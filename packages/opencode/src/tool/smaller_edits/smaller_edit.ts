import { NonNegativeInt } from "@opencode-ai/core/schema"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { createTwoFilesPatch, diffLines } from "diff"
import { Effect, Schema, Semaphore } from "effect"
import * as path from "path"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import { Snapshot } from "@/snapshot"
import * as Bom from "@/util/bom"
import { assertExternalDirectoryEffect } from "../external-directory"
import { trimDiff } from "../edit"
import * as Tool from "../tool"
import { LineAnchors, lineAnchors } from "./linehash"
import DESCRIPTION from "./smaller_edit.txt"
import { Service as SmallerEditsState, type FileLine } from "./state"
import { snapshotAtoms, snapshotError, snapshotFileLines, snapshotRenderedLines, traceSmallerEdits } from "./trace"

const DEFAULT_CONTEXT = 2
const MAX_CONTEXT = 20
const MAX_VISIBLE_LINE_LENGTH = 2000
const MAX_VISIBLE_LINE_SUFFIX = `... (line truncated to ${MAX_VISIBLE_LINE_LENGTH} chars)`

const locks = new Map<string, Semaphore.Semaphore>()

export const Parameters = parametersFor(lineAnchors("b64"))

type OperationInput = Schema.Schema.Type<typeof Parameters>["operations"][number]

type Display = {
  type: "file"
  path: string
  text: string
  lineStart: number
  lineEnd: number
  totalLines: number
  truncated: boolean
}

type Metadata = {
  diff: string
  filediff: Snapshot.FileDiff
  diagnostics: Record<string, unknown>
  display: Display
}

type PlannedOperation =
  | {
      batchIndex: number
      kind: "replace_range"
      startLabel: string
      endLabel: string
      editStart: number
      oldCount: number
      newCount: number
      replacement: string[]
      expected: FileLine[]
      overlapStart: number
      overlapEnd: number
    }
  | {
      batchIndex: number
      kind: "insert_after"
      startLabel: string
      editStart: number
      oldCount: 0
      newCount: number
      replacement: string[]
      expected: [FileLine]
      overlapStart: number
      overlapEnd: number
    }
  | {
      batchIndex: number
      kind: "delete_range"
      startLabel: string
      endLabel: string
      editStart: number
      oldCount: number
      newCount: 0
      replacement: []
      expected: FileLine[]
      overlapStart: number
      overlapEnd: number
    }
  | {
      batchIndex: number
      kind: "insert_at_start"
      editStart: 1
      oldCount: 0
      newCount: number
      replacement: string[]
      expected: []
      overlapStart: 1
      overlapEnd: 1
    }

type Trace = (type: string, data?: unknown) => void

export const SmallerEditTool = Tool.define<
  typeof Parameters,
  Metadata,
  FSUtil.Service | LSP.Service | Format.Service | EventV2Bridge.Service | SmallerEditsState
>(
  "edit",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service
    const smallerEditsState = yield* SmallerEditsState
    const activeLineAnchors = lineAnchors()

    const run = Effect.fn("SmallerEditTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const instance = yield* InstanceState.context
      let filePath = params.filePath
      if (!path.isAbsolute(filePath)) {
        filePath = path.join(instance.directory, filePath)
      }
      if (process.platform === "win32") {
        filePath = FSUtil.normalizePath(filePath)
      }
      yield* assertExternalDirectoryEffect(ctx, filePath)

      const title = path.relative(instance.worktree, filePath)
      const contextBefore = resolveContext(params.contextBefore)
      const contextAfter = resolveContext(params.contextAfter)
      const trace: Trace = (type, data) =>
        traceSmallerEdits(type, data, {
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          callID: ctx.callID,
          filePath,
        })

      let diff = ""
      let contentOld = ""
      let contentNew = ""
      let display: Display | undefined

      trace("edit.start", {
        params,
        contextBefore,
        contextAfter,
      })

      yield* lock(filePath).withPermits(1)(
        Effect.gen(function* () {
          const info = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (info?.type === "Directory") {
            throw new Error(`Path is a directory, not a file: ${filePath}`)
          }

          const source = info ? yield* Bom.readFile(afs, filePath) : { bom: false, text: "" }
          const existed = Boolean(info)
          const ending = detectLineEnding(source.text)
          const hadTrailingNewline = normalizeLineEndings(source.text).endsWith("\n")
          const initialLines = splitFileLines(normalizeLineEndings(source.text))
          const state = yield* smallerEditsState.getFileState(filePath)
          trace("edit.loaded_state", {
            fileExists: existed,
            initialLineCount: initialLines.length,
            atoms: snapshotAtoms(state.atoms),
          })
          const planned = planOperations({
            operations: params.operations,
            atoms: state.atoms,
            liveLines: initialLines,
            fileExists: existed,
          }, trace)
          trace("edit.planned", {
            planned: snapshotPlannedOperations(planned),
          })

          const nextLines = initialLines.slice()
          const changedRanges: Array<{ start: number; end: number }> = []
          for (const operation of planned) {
            shiftRanges(changedRanges, operation)
            applyOperation(nextLines, operation)
            changedRanges.push({
              start: operation.editStart,
              end: operation.editStart + Math.max(operation.newCount, 1) - 1,
            })
          }

          const normalizedNew = joinFileLines(nextLines, hadTrailingNewline && nextLines.length > 0)
          contentOld = source.text
          contentNew = convertToLineEnding(normalizedNew, ending)
          diff = trimDiff(
            createTwoFilesPatch(filePath, filePath, normalizeLineEndings(contentOld), normalizeLineEndings(contentNew)),
          )

          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, filePath)],
            always: ["*"],
            metadata: {
              filepath: filePath,
              diff,
            },
          })

          if (existed) {
            const liveSource = yield* Bom.readFile(afs, filePath)
            validatePlannedOperationsAgainstLive(planned, splitFileLines(normalizeLineEndings(liveSource.text)), trace)
          } else {
            const liveInfo = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (liveInfo) {
              trace("edit.live_file_created", {
                filePath,
              })
              throw new Error(`File ${filePath} changed before the edit could be applied. Re-read and retry.`)
            }
          }

          yield* afs.writeWithDirs(filePath, Bom.join(contentNew, source.bom))
          if (yield* format.file(filePath)) {
            contentNew = yield* Bom.syncFile(afs, filePath, source.bom)
          }

          const finalLines = splitFileLines(normalizeLineEndings(contentNew))
          const returnedWindow = computeReturnedWindow(finalLines, changedRanges, contextBefore, contextAfter)
          const returnedLines = LineAnchors.buildRenderedLines(
            toVisibleLines(finalLines),
            returnedWindow.start,
            returnedWindow.end,
          )
          trace("edit.returned_window", {
            changedRanges,
            returnedWindow,
            returnedLines: snapshotRenderedLines(returnedLines),
          })

          for (const operation of planned) {
            yield* smallerEditsState.recordEditShift({
              filePath,
              editStart: operation.editStart,
              oldCount: operation.oldCount,
              newCount: operation.newCount,
            })
          }
          if (returnedLines.length > 0) {
            yield* smallerEditsState.replaceWindowLines({
              filePath,
              start: returnedLines[0]!.lineno,
              end: returnedLines[returnedLines.length - 1]!.lineno,
              lines: returnedLines.map((line) => ({
                _tag: "line" as const,
                fileno: line.lineno,
                orig_fileno: line.lineno,
                token: line.token,
                content: line.content,
              })),
            })
          }

          yield* events.publish(FileSystem.Event.Edited, { file: filePath })
          yield* events.publish(Watcher.Event.Updated, {
            file: filePath,
            event: existed ? "change" : "add",
          })

          diff = trimDiff(
            createTwoFilesPatch(filePath, filePath, normalizeLineEndings(contentOld), normalizeLineEndings(contentNew)),
          )

          display = {
            type: "file",
            path: filePath,
            text: returnedLines.map((line) => line.text).join("\n"),
            lineStart: returnedWindow.start,
            lineEnd: returnedWindow.end,
            totalLines: finalLines.length,
            truncated: false,
          }
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              trace("edit.error", {
                error: snapshotError(error),
              })
            }),
          ),
          Effect.orDie,
        ),
      )

      let additions = 0
      let deletions = 0
      for (const change of diffLines(contentOld, contentNew)) {
        if (change.added) additions += change.count || 0
        if (change.removed) deletions += change.count || 0
      }
      const filediff: Snapshot.FileDiff = {
        file: filePath,
        patch: diff,
        additions,
        deletions,
      }

      yield* lsp.touchFile(filePath, "document")
      const diagnostics = yield* lsp.diagnostics()
      const normalizedFilePath = FSUtil.normalizePath(filePath)
      const diagnosticBlock = LSP.Diagnostic.report(filePath, diagnostics[normalizedFilePath] ?? [])
      const nextDisplay = display ?? {
        type: "file",
        path: filePath,
        text: "",
        lineStart: 1,
        lineEnd: 0,
        totalLines: 0,
        truncated: false,
      }

      yield* ctx.metadata({
        metadata: {
          diff,
          filediff,
          diagnostics,
          display: nextDisplay,
        },
      })

      let output = `Edit applied successfully. Use the refreshed returned ${LineAnchors.morphology.lineLabel}s for follow-up edits in this region.`
      output += `\n\n<path>${filePath}</path>`
      output += "\n<type>file</type>"
      output += `\n<window offset="${nextDisplay.lineStart}" limit="${Math.max(nextDisplay.lineEnd - nextDisplay.lineStart + 1, 0)}">`
      output += "\n<content>"
      if (nextDisplay.text) output += `\n${nextDisplay.text}`
      if (nextDisplay.totalLines === 0) {
        output += "\n\n(End of file - total 0 lines)"
      } else {
          output += `\n\n(Returned lines ${nextDisplay.lineStart}-${nextDisplay.lineEnd} of ${nextDisplay.totalLines}. These are the fresh post-edit ${LineAnchors.morphology.lineLabel}s to continue from.)`
      }
      output += "\n</content>\n</window>"
      if (diagnosticBlock) {
        output += `\n\nLSP errors detected in this file, please fix:\n${diagnosticBlock}`
      }

      return {
        title,
        output,
        metadata: {
          diff,
          filediff,
          diagnostics,
          display: nextDisplay,
        },
      }
    })

    return {
      description: descriptionWithMorphology(activeLineAnchors),
      parameters: parametersFor(activeLineAnchors),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

function descriptionWithMorphology(activeLineAnchors: ReturnType<typeof lineAnchors>) {
  return [
    DESCRIPTION,
    "",
    `Active ${activeLineAnchors.morphology.anchorLabel} format: ${activeLineAnchors.morphology.anchorFormatDescription}.`,
    `Active ${activeLineAnchors.morphology.lineLabel} format: ${activeLineAnchors.morphology.renderedLineFormatDescription}.`,
    activeLineAnchors.morphology.followupGuidance,
  ].join("\n")
}

function parametersFor(activeLineAnchors: ReturnType<typeof lineAnchors>) {
  const replaceRangeOperation = Schema.Struct({
    kind: Schema.Literal("replace_range"),
    start: Schema.String.annotate({
      description: `The start ${activeLineAnchors.morphology.anchorLabel} in ${activeLineAnchors.morphology.anchorFormatDescription}`,
    }),
    end: Schema.String.annotate({
      description: `The end ${activeLineAnchors.morphology.anchorLabel} in ${activeLineAnchors.morphology.anchorFormatDescription}`,
    }),
    content: Schema.String.annotate({ description: "The replacement content, expressed as raw file lines joined with \\n" }),
  })
  const insertAfterOperation = Schema.Struct({
    kind: Schema.Literal("insert_after"),
    start: Schema.String.annotate({
      description: `The ${activeLineAnchors.morphology.anchorLabel} line after which to insert, in ${activeLineAnchors.morphology.anchorFormatDescription}`,
    }),
    content: Schema.String.annotate({ description: "The inserted content, expressed as raw file lines joined with \\n" }),
  })
  const deleteRangeOperation = Schema.Struct({
    kind: Schema.Literal("delete_range"),
    start: Schema.String.annotate({
      description: `The start ${activeLineAnchors.morphology.anchorLabel} in ${activeLineAnchors.morphology.anchorFormatDescription}`,
    }),
    end: Schema.String.annotate({
      description: `The end ${activeLineAnchors.morphology.anchorLabel} in ${activeLineAnchors.morphology.anchorFormatDescription}`,
    }),
  })
  const insertAtStartOperation = Schema.Struct({
    kind: Schema.Literal("insert_at_start"),
    content: Schema.String.annotate({ description: "The inserted content, expressed as raw file lines joined with \\n" }),
  })
  const operation = Schema.Union([
    replaceRangeOperation,
    insertAfterOperation,
    deleteRangeOperation,
    insertAtStartOperation,
  ]).annotate({ discriminator: "kind", identifier: "SmallerEditOperation" })

  return Schema.Struct({
    filePath: Schema.String.annotate({ description: "The absolute path to the file to modify" }),
    operations: Schema.mutable(Schema.NonEmptyArray(operation)).annotate({
      description: "The ordered edit operations to apply against remembered line identities",
    }),
    contextBefore: Schema.optional(NonNegativeInt).annotate({
      description: "How many lines of leading context to return around the changed region (defaults to 2, capped at 20)",
    }),
    contextAfter: Schema.optional(NonNegativeInt).annotate({
      description: "How many lines of trailing context to return around the changed region (defaults to 2, capped at 20)",
    }),
  })
}

function lock(filePath: string) {
  const resolvedFilePath = FSUtil.resolve(filePath)
  const hit = locks.get(resolvedFilePath)
  if (hit) return hit

  const next = Semaphore.makeUnsafe(1)
  locks.set(resolvedFilePath, next)
  return next
}

function normalizeLineEndings(text: string) {
  return text.replaceAll("\r\n", "\n")
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

function convertToLineEnding(text: string, ending: "\n" | "\r\n") {
  if (ending === "\n") return text
  return text.replaceAll("\n", "\r\n")
}

function resolveContext(input: number | undefined) {
  return Math.min(input ?? DEFAULT_CONTEXT, MAX_CONTEXT)
}

function splitFileLines(text: string) {
  if (text === "") return [] as string[]
  const lines = text.split("\n")
  if (text.endsWith("\n")) lines.pop()
  return lines
}

function splitReplacementLines(content: string) {
  return normalizeLineEndings(content).split("\n")
}

function joinFileLines(lines: string[], keepTrailingNewline: boolean) {
  if (lines.length === 0) return ""
  return lines.join("\n") + (keepTrailingNewline ? "\n" : "")
}

function toVisibleLines(lines: string[]) {
  return lines.map(visibleLine)
}

function visibleLine(text: string) {
  const line = LineAnchors.canonicalizeContent(text)
  if (line.length <= MAX_VISIBLE_LINE_LENGTH) return line
  return line.substring(0, MAX_VISIBLE_LINE_LENGTH) + MAX_VISIBLE_LINE_SUFFIX
}

function planOperations(input: {
  operations: ReadonlyArray<OperationInput>
  atoms: ReadonlyArray<FileLine | { _tag: "offset"; fileno: number; orig_fileno: number; delta: number }>
  liveLines: string[]
  fileExists: boolean
}, trace?: Trace) {
  const remembered = new Map(
    input.atoms.filter((atom): atom is FileLine => atom._tag === "line").map((atom) => [atom.fileno, atom]),
  )
  trace?.("edit.plan_operations", {
    fileExists: input.fileExists,
    liveLineCount: input.liveLines.length,
    operations: input.operations,
    atoms: snapshotAtoms(input.atoms),
  })
  const planned = input.operations.map((operation, batchIndex) =>
    planOperation(operation, batchIndex, remembered, input.liveLines, input.fileExists, trace),
  )
  for (let left = 0; left < planned.length; left++) {
    for (let right = left + 1; right < planned.length; right++) {
      if (operationsConflict(planned[left]!, planned[right]!)) {
        trace?.("edit.plan_conflict", {
          left: snapshotPlannedOperation(planned[left]!),
          right: snapshotPlannedOperation(planned[right]!),
        })
        throw new Error("CONFLICT: overlapping batch. Split these edits into separate calls and retry.")
      }
    }
  }
  return planned.sort(comparePlannedOperations)
}

function planOperation(
  operation: OperationInput,
  batchIndex: number,
  remembered: Map<number, FileLine>,
  liveLines: string[],
  fileExists: boolean,
  trace?: Trace,
): PlannedOperation {
  if (!fileExists && operation.kind !== "insert_at_start") {
    trace?.("edit.plan_missing_file", { operation })
    throw new Error("File does not exist yet. Use a single insert_at_start operation to create it.")
  }

  if (liveLines.length === 0 && operation.kind !== "insert_at_start") {
    trace?.("edit.plan_empty_file", { operation })
    throw new Error("File is empty. Re-read the file and use insert_at_start to populate it.")
  }

  if (operation.kind === "insert_at_start") {
    const replacement = splitReplacementLines(operation.content)
    return {
      batchIndex,
      kind: "insert_at_start",
      editStart: 1,
      oldCount: 0,
      newCount: replacement.length,
      replacement,
      expected: [],
      overlapStart: 1,
      overlapEnd: 1,
    }
  }

  const start = resolveRememberedLine(operation.start, remembered, trace)
  if (operation.kind === "insert_after") {
    requireLiveMatch(operation.start, start, liveLines, trace)
    const replacement = splitReplacementLines(operation.content)
    return {
      batchIndex,
      kind: "insert_after",
      startLabel: operation.start,
      editStart: start.fileno + 1,
      oldCount: 0,
      newCount: replacement.length,
      replacement,
      expected: [start],
      overlapStart: start.fileno + 1,
      overlapEnd: start.fileno + 1,
    }
  }

  const end = resolveRememberedLine(operation.end, remembered, trace)
  if (end.fileno < start.fileno) {
    trace?.("edit.plan_invalid_range", {
      start: operation.start,
      end: operation.end,
      startResolved: start.fileno,
      endResolved: end.fileno,
    })
    throw new Error(`Invalid range ${operation.start}..${operation.end}. Re-read the file and retry.`)
  }
  const span = resolveRememberedSpan(start, end, remembered, operation.start, operation.end, trace)
  requireLiveSpanMatch(operation.start, operation.end, span, liveLines, trace)
  if (operation.kind === "delete_range") {
    return {
      batchIndex,
      kind: "delete_range",
      startLabel: operation.start,
      endLabel: operation.end,
      editStart: start.fileno,
      oldCount: span.length,
      newCount: 0,
      replacement: [],
      expected: span,
      overlapStart: start.fileno,
      overlapEnd: end.fileno,
    }
  }

  const replacement = splitReplacementLines(operation.content)
  return {
    batchIndex,
    kind: "replace_range",
    startLabel: operation.start,
    endLabel: operation.end,
    editStart: start.fileno,
    oldCount: span.length,
    newCount: replacement.length,
    replacement,
    expected: span,
    overlapStart: start.fileno,
    overlapEnd: end.fileno,
  }
}

function comparePlannedOperations(left: PlannedOperation, right: PlannedOperation) {
  if (left.editStart !== right.editStart) return right.editStart - left.editStart

  const leftConsumes = consumesOriginalLines(left)
  const rightConsumes = consumesOriginalLines(right)
  if (leftConsumes !== rightConsumes) return leftConsumes ? -1 : 1

  return right.batchIndex - left.batchIndex
}

function operationsConflict(left: PlannedOperation, right: PlannedOperation) {
  const leftRange = operationRange(left)
  const rightRange = operationRange(right)
  const leftAnchorLine = insertionAnchorLine(left)
  const rightAnchorLine = insertionAnchorLine(right)
  const leftSite = insertionSite(left)
  const rightSite = insertionSite(right)

  if (leftRange && rightRange) return leftRange.start <= rightRange.end && rightRange.start <= leftRange.end
  if (leftSite && rightSite) return leftSite === rightSite
  if (leftRange && rightAnchorLine !== undefined) return leftRange.start <= rightAnchorLine && rightAnchorLine < leftRange.end
  if (leftAnchorLine !== undefined && rightRange) return rightRange.start <= leftAnchorLine && leftAnchorLine < rightRange.end
  return false
}

function consumesOriginalLines(operation: PlannedOperation) {
  return operation.oldCount > 0
}

function operationRange(operation: PlannedOperation) {
  if (!consumesOriginalLines(operation)) return undefined
  return {
    start: operation.editStart,
    end: operation.editStart + operation.oldCount - 1,
  }
}

function insertionAnchorLine(operation: PlannedOperation) {
  if (operation.kind !== "insert_after") return undefined
  return operation.editStart - 1
}

function insertionSite(operation: PlannedOperation) {
  if (operation.kind === "insert_at_start") return "start"
  if (operation.kind === "insert_after") return `after:${operation.editStart - 1}`
  return undefined
}

function matchesAnchor(line: FileLine, anchor: { lineno: number; token: string }) {
  return LineAnchors.matchAnchorToken(anchor.token, candidateTokens(line))._tag === "match"
}

function candidateTokens(line: FileLine) {
  return [...new Set([line.token, ...(line.tokenAliases ?? [])])]
}

function resolveRememberedSpan(
  start: FileLine,
  end: FileLine,
  remembered: Map<number, FileLine>,
  startLabel: string,
  endLabel: string,
  trace?: Trace,
) {
  const span: FileLine[] = []
  for (let lineno = start.fileno; lineno <= end.fileno; lineno++) {
    const line = remembered.get(lineno)
    if (!line) {
      trace?.("edit.resolve_span_incomplete", {
        startLabel,
        endLabel,
        missingLineno: lineno,
        remembered: snapshotFileLines([...remembered.values()]),
      })
      throw new Error(`Remembered span ${startLabel}..${endLabel} is incomplete. Re-read that full range and retry.`)
    }
    span.push(line)
  }
  return span
}

function requireLiveMatch(label: string, remembered: FileLine, liveLines: string[], trace?: Trace) {
  const live = liveLines[remembered.fileno - 1]
  if (live === undefined || visibleLine(live) !== LineAnchors.canonicalizeContent(remembered.content)) {
    trace?.("edit.require_live_match_failed", {
      label,
      remembered,
      live,
    })
    throw new Error(`Line ${label} no longer matches the live file. Re-read that window and retry.`)
  }
}

function requireLiveSpanMatch(startLabel: string, endLabel: string, span: FileLine[], liveLines: string[], trace?: Trace) {
  for (const line of span) {
    const live = liveLines[line.fileno - 1]
    if (live === undefined || visibleLine(live) !== LineAnchors.canonicalizeContent(line.content)) {
      trace?.("edit.require_live_span_match_failed", {
        startLabel,
        endLabel,
        line: line.fileno,
        remembered: snapshotFileLines(span),
        live,
      })
      throw new Error(`Span ${startLabel}..${endLabel} no longer matches the live file. Re-read that full range and retry.`)
    }
  }
}

function applyOperation(lines: string[], operation: PlannedOperation) {
  if (operation.kind === "insert_at_start") {
    lines.splice(0, 0, ...operation.replacement)
    return
  }
  lines.splice(operation.editStart - 1, operation.oldCount, ...operation.replacement)
}

function shiftRanges(ranges: Array<{ start: number; end: number }>, operation: PlannedOperation) {
  const delta = operation.newCount - operation.oldCount
  if (delta === 0) return
  const origBoundary = operation.editStart + operation.oldCount
  for (const range of ranges) {
    if (range.start < origBoundary) continue
    range.start += delta
    range.end += delta
  }
}

function computeReturnedWindow(
  finalLines: string[],
  changedRanges: Array<{ start: number; end: number }>,
  contextBefore: number,
  contextAfter: number,
) {
  const bounds = changedRanges.reduce(
    (acc, range) => ({
      start: Math.min(acc.start, range.start),
      end: Math.max(acc.end, range.end),
    }),
    { start: Number.POSITIVE_INFINITY, end: 0 },
  )
  if (finalLines.length === 0) {
    return { start: 1, end: 0 }
  }
  const coreStart = Number.isFinite(bounds.start) ? bounds.start : 1
  const coreEnd = bounds.end > 0 ? bounds.end : coreStart
  return {
    start: Math.max(1, coreStart - contextBefore),
    end: Math.min(finalLines.length, coreEnd + contextAfter),
  }
}

function validatePlannedOperationsAgainstLive(planned: PlannedOperation[], liveLines: string[], trace?: Trace) {
  const liveIdentities = new Map(LineAnchors.buildRenderedLines(toVisibleLines(liveLines)).map((line) => [line.lineno, line]))
  for (const operation of planned) {
    for (const expected of operation.expected) {
      const live = liveIdentities.get(expected.fileno)
      if (!live || live.token !== expected.token || live.content !== expected.content) {
        const target = LineAnchors.formatAnchor({ lineno: expected.fileno, token: expected.token })
        trace?.("edit.validate_live_failed", {
          operation: snapshotPlannedOperation(operation),
          expected: snapshotFileLines([expected])[0],
          live,
        })
        throw new Error(`Line ${target} no longer matches the live file. Re-read that window and retry.`)
      }
    }
  }
}

function resolveRememberedLine(label: string, remembered: Map<number, FileLine>, trace?: Trace) {
  const anchor = LineAnchors.parseAnchor(label)
  const candidates = [...remembered.values()].filter(
    (candidate) => candidate.fileno === anchor.lineno || candidate.orig_fileno === anchor.lineno,
  )
  const matches = candidates.filter((candidate) => matchesAnchor(candidate, anchor))
  trace?.("edit.resolve_line", {
    label,
    parsed: anchor,
    candidates: candidates.map((candidate) => ({
      ...candidate,
      candidateTokens: candidateTokens(candidate),
    })),
    matches: snapshotFileLines(matches),
  })
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) {
    trace?.("edit.resolve_line_ambiguous", {
      label,
      parsed: anchor,
      matches: snapshotFileLines(matches),
    })
    throw new Error(`Line ${label} is ambiguous in remembered state. Use more token characters and retry.`)
  }

  trace?.("edit.resolve_line_miss", {
    label,
    parsed: anchor,
    remembered: snapshotFileLines([...remembered.values()]),
  })
  throw new Error(`Line ${label} is not available in remembered state. Re-read that window and retry.`)
}

function snapshotPlannedOperations(planned: ReadonlyArray<PlannedOperation>) {
  return planned.map(snapshotPlannedOperation)
}

function snapshotPlannedOperation(operation: PlannedOperation) {
  return {
    batchIndex: operation.batchIndex,
    kind: operation.kind,
    editStart: operation.editStart,
    oldCount: operation.oldCount,
    newCount: operation.newCount,
    replacement: operation.replacement,
    expected: snapshotFileLines(operation.expected),
    overlapStart: operation.overlapStart,
    overlapEnd: operation.overlapEnd,
    startLabel: "startLabel" in operation ? operation.startLabel : undefined,
    endLabel: "endLabel" in operation ? operation.endLabel : undefined,
  }
}

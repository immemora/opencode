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
import {
  buildIdentityLines,
  canonicalizeLine,
  parseIdentityAnchor,
} from "./linehash"
import DESCRIPTION from "./smaller_edit.txt"
import { Service as SmallerEditsState, type FileLine } from "./state"

const DEFAULT_CONTEXT = 2
const MAX_CONTEXT = 20
const MAX_VISIBLE_LINE_LENGTH = 2000
const MAX_VISIBLE_LINE_SUFFIX = `... (line truncated to ${MAX_VISIBLE_LINE_LENGTH} chars)`

const locks = new Map<string, Semaphore.Semaphore>()

const ReplaceRangeOperation = Schema.Struct({
  kind: Schema.Literal("replace_range"),
  start: Schema.String.annotate({ description: "The start anchor in {lineno},{chainHash} format" }),
  end: Schema.String.annotate({ description: "The end anchor in {lineno},{chainHash} format" }),
  content: Schema.String.annotate({ description: "The replacement content, expressed as raw file lines joined with \\n" }),
})

const InsertAfterOperation = Schema.Struct({
  kind: Schema.Literal("insert_after"),
  start: Schema.String.annotate({ description: "The anchor line after which to insert, in {lineno},{chainHash} format" }),
  content: Schema.String.annotate({ description: "The inserted content, expressed as raw file lines joined with \\n" }),
})

const DeleteRangeOperation = Schema.Struct({
  kind: Schema.Literal("delete_range"),
  start: Schema.String.annotate({ description: "The start anchor in {lineno},{chainHash} format" }),
  end: Schema.String.annotate({ description: "The end anchor in {lineno},{chainHash} format" }),
})

const InsertAtStartOperation = Schema.Struct({
  kind: Schema.Literal("insert_at_start"),
  content: Schema.String.annotate({ description: "The inserted content, expressed as raw file lines joined with \\n" }),
})

const Operation = Schema.Union([
  ReplaceRangeOperation,
  InsertAfterOperation,
  DeleteRangeOperation,
  InsertAtStartOperation,
]).annotate({ discriminator: "kind", identifier: "SmallerEditOperation" })

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file to modify" }),
  operations: Schema.mutable(Schema.NonEmptyArray(Operation)).annotate({
    description: "The ordered edit operations to apply against remembered line identities",
  }),
  contextBefore: Schema.optional(NonNegativeInt).annotate({
    description: "How many lines of leading context to return around the changed region (defaults to 2, capped at 20)",
  }),
  contextAfter: Schema.optional(NonNegativeInt).annotate({
    description: "How many lines of trailing context to return around the changed region (defaults to 2, capped at 20)",
  }),
})

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
      kind: "insert_at_start"
      editStart: 1
      oldCount: 0
      newCount: number
      replacement: string[]
      expected: []
      overlapStart: 1
      overlapEnd: 1
    }

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

      let diff = ""
      let contentOld = ""
      let contentNew = ""
      let display: Display | undefined

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
          const planned = planOperations({
            operations: params.operations,
            atoms: state.atoms,
            liveLines: initialLines,
            fileExists: existed,
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
            validatePlannedOperationsAgainstLive(planned, splitFileLines(normalizeLineEndings(liveSource.text)))
          } else {
            const liveInfo = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (liveInfo) {
              throw new Error(`File ${filePath} changed before the edit could be applied. Re-read and retry.`)
            }
          }

          yield* afs.writeWithDirs(filePath, Bom.join(contentNew, source.bom))
          if (yield* format.file(filePath)) {
            contentNew = yield* Bom.syncFile(afs, filePath, source.bom)
          }

          const finalLines = splitFileLines(normalizeLineEndings(contentNew))
          const returnedWindow = computeReturnedWindow(finalLines, changedRanges, contextBefore, contextAfter)
          const returnedLines = buildIdentityLines(toVisibleLines(finalLines), returnedWindow.start, returnedWindow.end)

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
                chainHash: line.chainHash,
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
        }).pipe(Effect.orDie),
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

      let output = "Edit applied successfully. Use the returned identity-prefixed lines for follow-up edits in this region."
      output += `\n\n<path>${filePath}</path>`
      output += "\n<type>file</type>"
      output += `\n<window offset="${nextDisplay.lineStart}" limit="${Math.max(nextDisplay.lineEnd - nextDisplay.lineStart + 1, 0)}">`
      output += "\n<content>"
      if (nextDisplay.text) output += `\n${nextDisplay.text}`
      if (nextDisplay.totalLines === 0) {
        output += "\n\n(End of file - total 0 lines)"
      } else {
        output += `\n\n(Returned lines ${nextDisplay.lineStart}-${nextDisplay.lineEnd} of ${nextDisplay.totalLines}. Continue from these identity-prefixed lines.)`
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
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

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
  const line = canonicalizeLine(text)
  if (line.length <= MAX_VISIBLE_LINE_LENGTH) return line
  return line.substring(0, MAX_VISIBLE_LINE_LENGTH) + MAX_VISIBLE_LINE_SUFFIX
}

function planOperations(input: {
  operations: ReadonlyArray<Schema.Schema.Type<typeof Operation>>
  atoms: ReadonlyArray<FileLine | { _tag: "offset"; fileno: number; orig_fileno: number; delta: number }>
  liveLines: string[]
  fileExists: boolean
}) {
  const remembered = new Map(
    input.atoms.filter((atom): atom is FileLine => atom._tag === "line").map((atom) => [atom.fileno, atom]),
  )
  const planned = input.operations.map((operation) => planOperation(operation, remembered, input.liveLines, input.fileExists))
  const ascending = planned.slice().sort((left, right) => left.overlapStart - right.overlapStart)
  for (let index = 1; index < ascending.length; index++) {
    const prev = ascending[index - 1]!
    const next = ascending[index]!
    if (next.overlapStart <= prev.overlapEnd) {
      throw new Error("CONFLICT: overlapping batch. Split these edits into separate calls and retry.")
    }
  }
  return planned.sort((left, right) => right.editStart - left.editStart)
}

function planOperation(
  operation: Schema.Schema.Type<typeof Operation>,
  remembered: Map<number, FileLine>,
  liveLines: string[],
  fileExists: boolean,
): PlannedOperation {
  if (!fileExists && operation.kind !== "insert_at_start") {
    throw new Error("File does not exist yet. Use a single insert_at_start operation to create it.")
  }

  if (liveLines.length === 0 && operation.kind !== "insert_at_start") {
    throw new Error("File is empty. Re-read the file and use insert_at_start to populate it.")
  }

  if (operation.kind === "insert_at_start") {
    const replacement = splitReplacementLines(operation.content)
    return {
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

  const start = resolveRememberedLine(operation.start, remembered)
  if (operation.kind === "insert_after") {
    requireLiveMatch(operation.start, start, liveLines)
    const replacement = splitReplacementLines(operation.content)
    return {
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

  const end = resolveRememberedLine(operation.end, remembered)
  if (end.fileno < start.fileno) {
    throw new Error(`Invalid range ${operation.start}..${operation.end}. Re-read the file and retry.`)
  }
  const span = resolveRememberedSpan(start, end, remembered, operation.start, operation.end)
  requireLiveSpanMatch(operation.start, operation.end, span, liveLines)
  if (operation.kind === "delete_range") {
    return {
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

function resolveRememberedLine(label: string, remembered: Map<number, FileLine>) {
  const anchor = parseIdentityAnchor(label)
  const line = remembered.get(anchor.lineno)
  if (!line || line.chainHash !== anchor.chainHash) {
    throw new Error(`Line ${label} is not available in remembered state. Re-read that window and retry.`)
  }
  return line
}

function resolveRememberedSpan(
  start: FileLine,
  end: FileLine,
  remembered: Map<number, FileLine>,
  startLabel: string,
  endLabel: string,
) {
  const span: FileLine[] = []
  for (let lineno = start.fileno; lineno <= end.fileno; lineno++) {
    const line = remembered.get(lineno)
    if (!line) {
      throw new Error(`Remembered span ${startLabel}..${endLabel} is incomplete. Re-read that full range and retry.`)
    }
    span.push(line)
  }
  return span
}

function requireLiveMatch(label: string, remembered: FileLine, liveLines: string[]) {
  const live = liveLines[remembered.fileno - 1]
  if (live === undefined || visibleLine(live) !== canonicalizeLine(remembered.content)) {
    throw new Error(`Line ${label} no longer matches the live file. Re-read that window and retry.`)
  }
}

function requireLiveSpanMatch(startLabel: string, endLabel: string, span: FileLine[], liveLines: string[]) {
  for (const line of span) {
    const live = liveLines[line.fileno - 1]
    if (live === undefined || visibleLine(live) !== canonicalizeLine(line.content)) {
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

function validatePlannedOperationsAgainstLive(planned: PlannedOperation[], liveLines: string[]) {
  const liveIdentities = new Map(buildIdentityLines(toVisibleLines(liveLines)).map((line) => [line.lineno, line]))
  for (const operation of planned) {
    for (const expected of operation.expected) {
      const live = liveIdentities.get(expected.fileno)
      if (!live || live.chainHash !== expected.chainHash || live.content !== expected.content) {
        const target = `${expected.fileno},${expected.chainHash}`
        throw new Error(`Line ${target} no longer matches the live file. Re-read that window and retry.`)
      }
    }
  }
}

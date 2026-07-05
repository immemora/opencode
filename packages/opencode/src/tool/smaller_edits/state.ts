import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Context, Effect, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { snapshotAtom, snapshotAtoms, snapshotFileLine, snapshotFileLines, traceSmallerEdits } from "./trace"

export type FileOffset = {
  _tag: "offset"
  fileno: number
  orig_fileno: number
  delta: number
}

export type FileLine = {
  _tag: "line"
  fileno: number
  orig_fileno: number
  token: string
  tokenAliases?: string[]
  content: string
}

export type FileAtom = FileOffset | FileLine

type State = {
  files: Map<string, FileAtom[]>
}

export interface Interface {
  readonly getFileState: (filePath: string) => Effect.Effect<{ path: string; atoms: FileAtom[] }>
  readonly replaceWindowLines: (input: {
    filePath: string
    start: number
    end: number
    lines: FileLine[]
  }) => Effect.Effect<void>
  readonly recordEditShift: (input: {
    filePath: string
    editStart: number
    oldCount: number
    newCount: number
  }) => Effect.Effect<void>
  readonly resolveVisibleLine: (input: {
    filePath: string
    lineno: number
    token: string
  }) => Effect.Effect<FileLine | undefined>
  readonly clearWindow: (input: { filePath: string; start: number; end: number }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SmallerEditsState") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make<State>(
      Effect.fn("SmallerEditsState.state")(() =>
        Effect.succeed({
          files: new Map<string, FileAtom[]>(),
        }),
      ),
    )

    const getAtoms = Effect.fn("SmallerEditsState.getAtoms")(function* (filePath: string) {
      const key = normalizeFilePath(filePath)
      const s = yield* InstanceState.get(state)
      let atoms = s.files.get(key)
      if (!atoms) {
        atoms = []
        s.files.set(key, atoms)
      }
      return { key, atoms }
    })

    const getFileState: Interface["getFileState"] = Effect.fn("SmallerEditsState.getFileState")(function* (filePath) {
      const { key, atoms } = yield* getAtoms(filePath)
      traceSmallerEdits("state.get_file_state", {
        filePath: key,
        atoms: snapshotAtoms(atoms),
      })
      return {
        path: key,
        atoms: atoms.slice().sort(compareAtoms).map(cloneAtom),
      }
    })

    const clearWindow: Interface["clearWindow"] = Effect.fn("SmallerEditsState.clearWindow")(function* (input) {
      const { atoms } = yield* getAtoms(input.filePath)
      const before = snapshotAtoms(atoms)
      replaceAtoms(
        atoms,
        atoms.filter(
          (atom) => atom._tag === "offset" || atom.fileno < input.start || atom.fileno > input.end,
        ),
      )
      traceSmallerEdits("state.clear_window", {
        filePath: normalizeFilePath(input.filePath),
        start: input.start,
        end: input.end,
        before,
        after: snapshotAtoms(atoms),
      })
    })

    const replaceWindowLines: Interface["replaceWindowLines"] = Effect.fn(
      "SmallerEditsState.replaceWindowLines",
    )(function* (input) {
      const { atoms } = yield* getAtoms(input.filePath)
      const before = snapshotAtoms(atoms)
      const previous = atoms.filter((atom): atom is FileLine => atom._tag === "line")
      replaceAtoms(
        atoms,
        [
          ...atoms.filter(
            (atom) => atom._tag === "offset" || atom.fileno < input.start || atom.fileno > input.end,
          ),
          ...input.lines.map((line) => mergeLine(previous, line)),
        ],
      )
      traceSmallerEdits("state.replace_window_lines", {
        filePath: normalizeFilePath(input.filePath),
        start: input.start,
        end: input.end,
        before,
        incoming: snapshotFileLines(input.lines),
        after: snapshotAtoms(atoms),
      })
    })

    const recordEditShift: Interface["recordEditShift"] = Effect.fn("SmallerEditsState.recordEditShift")(
      function* (input) {
        const { atoms } = yield* getAtoms(input.filePath)
        const before = snapshotAtoms(atoms)
        const delta = input.newCount - input.oldCount
        const origBoundary = input.editStart + input.oldCount
        const liveBoundary = input.editStart + input.newCount
        const shifted = atoms
          .filter(
            (atom) => atom._tag === "offset" || atom.fileno < input.editStart || atom.fileno >= origBoundary,
          )
          .map((atom) => {
            if (atom.fileno < origBoundary) return atom
            return {
              ...atom,
              fileno: atom.fileno + delta,
            }
          })

        if (delta === 0) {
          replaceAtoms(atoms, shifted)
          traceSmallerEdits("state.record_edit_shift", {
            filePath: normalizeFilePath(input.filePath),
            input,
            before,
            after: snapshotAtoms(atoms),
          })
          return
        }

        replaceAtoms(
          atoms,
          [
            ...shifted.filter(
              (atom) => atom._tag === "line" || (atom.fileno !== liveBoundary && atom.orig_fileno !== origBoundary),
            ),
            {
              _tag: "offset",
              fileno: liveBoundary,
              orig_fileno: origBoundary,
              delta,
            } satisfies FileOffset,
          ],
        )
        traceSmallerEdits("state.record_edit_shift", {
          filePath: normalizeFilePath(input.filePath),
          input,
          before,
          after: snapshotAtoms(atoms),
        })
      },
    )

    const resolveVisibleLine: Interface["resolveVisibleLine"] = Effect.fn(
      "SmallerEditsState.resolveVisibleLine",
    )(function* (input) {
      const { atoms } = yield* getAtoms(input.filePath)
      const hit = atoms.find(
        (atom): atom is FileLine =>
          atom._tag === "line" && atom.fileno === input.lineno && atom.token === input.token,
      )
      traceSmallerEdits("state.resolve_visible_line", {
        filePath: normalizeFilePath(input.filePath),
        lineno: input.lineno,
        token: input.token,
        result: hit ? snapshotFileLine(hit) : undefined,
        atoms: snapshotAtoms(atoms),
      })
      return hit ? cloneAtom(hit) : undefined
    })

    return Service.of({
      getFileState,
      replaceWindowLines,
      recordEditShift,
      resolveVisibleLine,
      clearWindow,
    })
  }),
)

function normalizeFilePath(filePath: string) {
  const resolved = FSUtil.resolve(filePath)
  if (process.platform === "win32") return FSUtil.normalizePath(resolved)
  return resolved
}

function compareAtoms(left: FileAtom, right: FileAtom) {
  if (left.fileno !== right.fileno) return left.fileno - right.fileno
  if (left._tag === right._tag) return 0
  if (left._tag === "offset") return -1
  return 1
}

function cloneAtom<A extends FileAtom>(atom: A): A {
  if (atom._tag === "offset") return { ...atom } as A
  if (!atom.tokenAliases) return { ...atom } as A
  return {
    ...atom,
    tokenAliases: atom.tokenAliases.slice(),
  } as A
}

function mergeLine(previous: FileLine[], line: FileLine): FileLine {
  const match = previous.find((candidate) => candidate.fileno === line.fileno && candidate.content === line.content)
  if (!match) return cloneAtom(line)

  const tokenAliases = [...new Set([...(match.tokenAliases ?? []), match.token].filter((token) => token !== line.token))]
  if (tokenAliases.length === 0) {
    return {
      ...line,
      orig_fileno: match.orig_fileno,
    }
  }

  return {
    ...line,
    orig_fileno: match.orig_fileno,
    tokenAliases,
  }
}

function replaceAtoms(target: FileAtom[], next: FileAtom[]) {
  target.splice(0, target.length, ...next.sort(compareAtoms).map(cloneAtom))
}

export const SmallerEditsStateNode = LayerNode.make({ service: Service, layer, deps: [] })

export const node = SmallerEditsStateNode

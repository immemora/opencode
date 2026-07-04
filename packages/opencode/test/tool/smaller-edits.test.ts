import { afterEach, describe, expect, it as bunIt } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Cause, Effect, Exit } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { InstanceState } from "../../src/effect/instance-state"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { LSP } from "../../src/lsp/lsp"
import { Instruction } from "../../src/session/instruction"
import { MessageID, SessionID } from "../../src/session/schema"
import { hashFirstLine, parseIdentityLine } from "../../src/tool/smaller_edits/linehash"
import { SmallerEditTool } from "../../src/tool/smaller_edits/smalled_edit"
import { SmallerReadTool } from "../../src/tool/smaller_edits/smalled_read"
import { node as smallerEditsStateNode, Service as SmallerEditsState } from "../../src/tool/smaller_edits/state"
import { Truncate } from "../../src/tool/truncate"
import * as Tool from "../../src/tool/tool"
import {
  disposeAllInstances,
  TestInstance,
} from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ctx = {
  sessionID: SessionID.make("ses_test-smaller-edits"),
  messageID: MessageID.make("msg_test-smaller-edits"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const layer = LayerNode.compile(
  LayerNode.group([
    Agent.node,
    FSUtil.node,
    Instruction.node,
    LSP.node,
    Truncate.node,
    Format.node,
    EventV2Bridge.node,
    smallerEditsStateNode,
  ]),
)

const it = testEffect(layer)

const initRead = Effect.fn("SmallerEditsTest.initRead")(function* () {
  const info = yield* SmallerReadTool
  return yield* info.init()
})

const initEdit = Effect.fn("SmallerEditsTest.initEdit")(function* () {
  const info = yield* SmallerEditTool
  return yield* info.init()
})

const runRead = Effect.fn("SmallerEditsTest.runRead")(function* (
  args: Tool.InferParameters<typeof SmallerReadTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* initRead()
  return yield* tool.execute(args, next)
})

const runEdit = Effect.fn("SmallerEditsTest.runEdit")(function* (
  args: Tool.InferParameters<typeof SmallerEditTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* initEdit()
  return yield* tool.execute(args, next)
})

const failEdit = Effect.fn("SmallerEditsTest.failEdit")(function* (
  args: Tool.InferParameters<typeof SmallerEditTool>,
) {
  const exit = yield* runEdit(args).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected smaller edit to fail")
})

const put = Effect.fn("SmallerEditsTest.put")(function* (p: string, content: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})

const load = Effect.fn("SmallerEditsTest.load")(function* (p: string) {
  const fs = yield* FSUtil.Service
  return yield* fs.readFileString(p)
})

function displayLines(text: string) {
  if (!text) return []
  return text.split("\n").filter(Boolean).map(parseIdentityLine)
}

function fileDisplayText(display: { type: "file"; text: string } | { type: "directory" } | undefined) {
  if (!display || display.type !== "file") return ""
  return display.text
}

describe("tool.smaller_edits linehash", () => {
  bunIt("rejects malformed identity prefixes", () => {
    expect(() => parseIdentityLine("bad line")).toThrow("Malformed identity-prefixed line")
    expect(() => parseIdentityLine("0,abc123|x")).toThrow("Malformed line identity")
  })

  bunIt("normalizes line endings before hashing", () => {
    expect(hashFirstLine("alpha\r\nbeta")).toBe(hashFirstLine("alpha\nbeta"))
    expect(hashFirstLine("alpha\rbeta")).toBe(hashFirstLine("alpha\nbeta"))
  })
})

describe("tool.smaller_edits state", () => {
  it.instance("records edit shifts for inserts and deletes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "state-shift.txt")
      const state = yield* SmallerEditsState

      yield* state.replaceWindowLines({
        filePath,
        start: 2,
        end: 4,
        lines: [
          { _tag: "line", fileno: 2, orig_fileno: 2, chainHash: "line-2", content: "two" },
          { _tag: "line", fileno: 3, orig_fileno: 3, chainHash: "line-3", content: "three" },
          { _tag: "line", fileno: 4, orig_fileno: 4, chainHash: "line-4", content: "four" },
        ],
      })

      yield* state.recordEditShift({
        filePath,
        editStart: 2,
        oldCount: 1,
        newCount: 3,
      })

      const afterInsert = yield* state.getFileState(filePath)
      expect(afterInsert.atoms).toEqual([
        { _tag: "offset", fileno: 5, orig_fileno: 3, delta: 2 },
        { _tag: "line", fileno: 5, orig_fileno: 3, chainHash: "line-3", content: "three" },
        { _tag: "line", fileno: 6, orig_fileno: 4, chainHash: "line-4", content: "four" },
      ])

      yield* state.recordEditShift({
        filePath,
        editStart: 4,
        oldCount: 2,
        newCount: 1,
      })

      const afterDelete = yield* state.getFileState(filePath)
      expect(afterDelete.atoms).toEqual([
        { _tag: "offset", fileno: 5, orig_fileno: 6, delta: -1 },
        { _tag: "line", fileno: 5, orig_fileno: 4, chainHash: "line-4", content: "four" },
      ])
    }),
  )

  it.instance("refreshes stale window lines and clears replaced identities", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "state-refresh.txt")
      const state = yield* SmallerEditsState

      yield* state.replaceWindowLines({
        filePath,
        start: 1,
        end: 2,
        lines: [
          { _tag: "line", fileno: 1, orig_fileno: 1, chainHash: "old-1", content: "alpha" },
          { _tag: "line", fileno: 2, orig_fileno: 2, chainHash: "old-2", content: "beta" },
        ],
      })

      yield* state.replaceWindowLines({
        filePath,
        start: 2,
        end: 3,
        lines: [
          { _tag: "line", fileno: 2, orig_fileno: 2, chainHash: "new-2", content: "BETA" },
          { _tag: "line", fileno: 3, orig_fileno: 3, chainHash: "new-3", content: "gamma" },
        ],
      })

      const refreshed = yield* state.getFileState(filePath)
      expect(refreshed.atoms).toEqual([
        { _tag: "line", fileno: 1, orig_fileno: 1, chainHash: "old-1", content: "alpha" },
        { _tag: "line", fileno: 2, orig_fileno: 2, chainHash: "new-2", content: "BETA" },
        { _tag: "line", fileno: 3, orig_fileno: 3, chainHash: "new-3", content: "gamma" },
      ])
      expect(
        yield* state.resolveVisibleLine({ filePath, lineno: 2, chainHash: "old-2" }),
      ).toBeUndefined()
      expect(
        yield* state.resolveVisibleLine({ filePath, lineno: 2, chainHash: "new-2" }),
      ).toEqual({ _tag: "line", fileno: 2, orig_fileno: 2, chainHash: "new-2", content: "BETA" })
    }),
  )

  it.instance("starts empty for each instance", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "state-empty.txt")
      const state = yield* SmallerEditsState

      const current = yield* state.getFileState(filePath)
      expect(current.path).toBe(FSUtil.resolve(filePath))
      expect(current.atoms).toEqual([])
    }),
  )
})

describe("tool.smaller_edits", () => {
  it.instance("read assigns distinct identities to repeated lines and refreshes remembered windows", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "dup.txt")
      yield* put(filePath, "dup\ndup\ndup\n")

      const first = yield* runRead({ filePath })
      const firstLines = displayLines(fileDisplayText(first.metadata.display))
      expect(firstLines).toHaveLength(3)
      expect(new Set(firstLines.map((line) => line.chainHash)).size).toBe(3)

      const state = yield* SmallerEditsState
      const firstState = yield* state.getFileState(filePath)
      expect(firstState.atoms.filter((atom) => atom._tag === "line")).toHaveLength(3)

      yield* put(filePath, "dup\nchanged\ndup\n")
      yield* runRead({ filePath, offset: 2, limit: 1 })

      const refreshed = yield* state.getFileState(filePath)
      const remembered = refreshed.atoms.filter((atom) => atom._tag === "line")
      expect(remembered.find((atom) => atom.fileno === 2)?.content).toBe("changed")
      expect(remembered.find((atom) => atom.fileno === 1)?.content).toBe("dup")
      expect(remembered.find((atom) => atom.fileno === 3)?.content).toBe("dup")
    }),
  )

  it.instance("replace_range returns fresh identities that can drive the next edit", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "flow.txt")
      yield* put(filePath, "alpha\ndup\ndup\nomega\n")

      const firstRead = yield* runRead({ filePath })
      const initialLines = displayLines(fileDisplayText(firstRead.metadata.display))
      const secondDup = initialLines[2]!

      const firstEdit = yield* runEdit({
        filePath,
        operations: [
          {
            kind: "replace_range",
            start: `${secondDup.lineno},${secondDup.chainHash}`,
            end: `${secondDup.lineno},${secondDup.chainHash}`,
            content: "mid",
          },
        ],
      })

      expect(yield* load(filePath)).toBe("alpha\ndup\nmid\nomega\n")
      const returnedLines = displayLines(firstEdit.metadata.display.text)
      const midLine = returnedLines.find((line) => line.content === "mid")
      const omegaLine = returnedLines.find((line) => line.content === "omega")
      expect(midLine).toBeDefined()
      expect(midLine?.chainHash).not.toBe(secondDup.chainHash)
      expect(omegaLine).toBeDefined()

      yield* runEdit({
        filePath,
        operations: [
          {
            kind: "replace_range",
            start: `${omegaLine!.lineno},${omegaLine!.chainHash}`,
            end: `${omegaLine!.lineno},${omegaLine!.chainHash}`,
            content: "tail",
          },
        ],
      })

      expect(yield* load(filePath)).toBe("alpha\ndup\nmid\ntail\n")
    }),
  )

  it.instance("supports insert_after and delete_range with identity anchors", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "ops.txt")
      yield* put(filePath, "one\ntwo\nthree\n")

      const firstRead = yield* runRead({ filePath })
      const lines = displayLines(fileDisplayText(firstRead.metadata.display))
      const one = lines.find((line) => line.content === "one")!
      const two = lines.find((line) => line.content === "two")!

      yield* runEdit({
        filePath,
        operations: [
          {
            kind: "insert_after",
            start: `${one.lineno},${one.chainHash}`,
            content: "one-point-five",
          },
        ],
      })
      expect(yield* load(filePath)).toBe("one\none-point-five\ntwo\nthree\n")

      const secondRead = yield* runRead({ filePath })
      const updated = displayLines(fileDisplayText(secondRead.metadata.display))
      const inserted = updated.find((line) => line.content === "one-point-five")!
      const shiftedTwo = updated.find((line) => line.content === "two")!

      yield* runEdit({
        filePath,
        operations: [
          {
            kind: "delete_range",
            start: `${inserted.lineno},${inserted.chainHash}`,
            end: `${shiftedTwo.lineno},${shiftedTwo.chainHash}`,
          },
        ],
      })
      expect(yield* load(filePath)).toBe("one\nthree\n")
      expect(two.lineno).toBe(2)
    }),
  )

  it.instance("handles one-line-to-three-line expansion and refreshes returned identities", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "expand.txt")
      yield* put(filePath, "before\nslot\nafter\n")

      const read = yield* runRead({ filePath })
      const lines = displayLines(fileDisplayText(read.metadata.display))
      const slot = lines.find((line) => line.content === "slot")!

      const result = yield* runEdit({
        filePath,
        operations: [
          {
            kind: "replace_range",
            start: `${slot.lineno},${slot.chainHash}`,
            end: `${slot.lineno},${slot.chainHash}`,
            content: "x\ny\nz",
          },
        ],
        contextAfter: 4,
      })

      expect(yield* load(filePath)).toBe("before\nx\ny\nz\nafter\n")
      const returned = displayLines(result.metadata.display.text)
      expect(returned.map((line) => line.content)).toEqual(["before", "x", "y", "z", "after"])
    }),
  )

  it.instance("uses insert_at_start to create and populate a new file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "new.txt")

      const result = yield* runEdit({
        filePath,
        operations: [
          {
            kind: "insert_at_start",
            content: "first\nsecond",
          },
        ],
        contextAfter: 4,
      })

      expect(yield* load(filePath)).toBe("first\nsecond")
      const lines = displayLines(result.metadata.display.text)
      expect(lines.map((line) => line.content)).toEqual(["first", "second"])
    }),
  )

  it.instance("rejects edits that target unread gaps", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "gap.txt")
      yield* put(filePath, "one\ntwo\nthree\nfour\nfive\n")

      yield* runRead({ filePath, offset: 1, limit: 2 })
      const err = yield* failEdit({
        filePath,
        operations: [
          {
            kind: "replace_range",
            start: "4,aaaaaa",
            end: "4,aaaaaa",
            content: "FOUR",
          },
        ],
      })

      expect(err.message).toContain("not available in remembered state")
    }),
  )

  it.instance("rejects stale anchors after the file changes on disk", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "stale.txt")
      yield* put(filePath, "one\ntwo\nthree\n")

      const read = yield* runRead({ filePath })
      const lines = displayLines(fileDisplayText(read.metadata.display))
      const two = lines.find((line) => line.content === "two")!

      yield* put(filePath, "one\nTWO\nthree\n")
      const err = yield* failEdit({
        filePath,
        operations: [
          {
            kind: "replace_range",
            start: `${two.lineno},${two.chainHash}`,
            end: `${two.lineno},${two.chainHash}`,
            content: "dos",
          },
        ],
      })

      expect(err.message).toContain("no longer matches the live file")
    }),
  )

  it.instance("shifts lower remembered regions after insertions and requires fresh returned identities", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "shift.txt")
      yield* put(filePath, "one\ntwo\nthree\nfour\n")

      const initial = yield* runRead({ filePath, offset: 3, limit: 2 })
      const lower = displayLines(fileDisplayText(initial.metadata.display))
      const oldThree = lower.find((line) => line.content === "three")!

      const inserted = yield* runEdit({
        filePath,
        operations: [
          {
            kind: "insert_at_start",
            content: "zero\nzero-point-five",
          },
        ],
        contextAfter: 10,
      })

      const staleErr = yield* failEdit({
        filePath,
        operations: [
          {
            kind: "replace_range",
            start: `${oldThree.lineno},${oldThree.chainHash}`,
            end: `${oldThree.lineno},${oldThree.chainHash}`,
            content: "THREE",
          },
        ],
      })
      expect(staleErr.message).toContain("not available in remembered state")

      const fresh = displayLines(inserted.metadata.display.text)
      const shiftedThree = fresh.find((line) => line.content === "three")!

      yield* runEdit({
        filePath,
        operations: [
          {
            kind: "replace_range",
            start: `${shiftedThree.lineno},${shiftedThree.chainHash}`,
            end: `${shiftedThree.lineno},${shiftedThree.chainHash}`,
            content: "THREE",
          },
        ],
      })

      expect(yield* load(filePath)).toBe("zero\nzero-point-five\none\ntwo\nTHREE\nfour\n")
    }),
  )

  it.instance("keeps sparse state isolated per instance", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "isolated.txt")
      yield* put(filePath, "only here\n")
      yield* runRead({ filePath })

      const state = yield* SmallerEditsState
      const current = yield* state.getFileState(filePath)
      expect(current.path).toBe(FSUtil.resolve(filePath))
      expect(current.atoms.filter((atom) => atom._tag === "line")).toHaveLength(1)

      const otherPath = path.join(path.dirname(test.directory), "outside.txt")
      const other = yield* state.getFileState(otherPath)
      expect(other.atoms).toHaveLength(0)
      expect(yield* InstanceState.directory).toBe(test.directory)
    }),
  )
})

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
import {
  DIGEST_WIDTH,
  lineAnchors,
  LineAnchors,
  LineHashTokenice100k,
  LineHashTokenice200k,
} from "../../src/tool/smaller_edits/linehash"
import type { LineHashName } from "../../src/tool/smaller_edits/linehash"
import { SmallerEditTool } from "../../src/tool/smaller_edits/smaller_edit"
import { SmallerReadTool } from "../../src/tool/smaller_edits/smaller_read"
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
  selection: LineHashName = "b64",
) {
  const restore = setLineHash(selection)
  const tool = yield* initRead()
  try {
    return yield* tool.execute(args, next)
  } finally {
    restore()
  }
})

const runEdit = Effect.fn("SmallerEditsTest.runEdit")(function* (
  args: Tool.InferParameters<typeof SmallerEditTool>,
  next: Tool.Context = ctx,
  selection: LineHashName = "b64",
) {
  const restore = setLineHash(selection)
  const tool = yield* initEdit()
  try {
    return yield* tool.execute(args, next)
  } finally {
    restore()
  }
})

const failEdit = Effect.fn("SmallerEditsTest.failEdit")(function* (
  args: Tool.InferParameters<typeof SmallerEditTool>,
  selection: LineHashName = "b64",
) {
  const exit = yield* runEdit(args, ctx, selection).pipe(Effect.exit)
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
  return displayLinesFor("b64", text)
}

function displayLinesFor(selection: LineHashName, text: string) {
  if (!text) return []
  const codec = lineAnchors(selection)
  return text.split("\n").filter(Boolean).map((line) => codec.parseRenderedLine(line))
}

function fileDisplayText(display: { type: "file"; text: string } | { type: "directory" } | undefined) {
  if (!display || display.type !== "file") return ""
  return display.text
}

function setLineHash(selection: LineHashName) {
  const previous = process.env.OPENCODE_SMALLER_EDITS_LINEHASH
  process.env.OPENCODE_SMALLER_EDITS_LINEHASH = selection
  return () => {
    if (previous === undefined) {
      delete process.env.OPENCODE_SMALLER_EDITS_LINEHASH
      return
    }
    process.env.OPENCODE_SMALLER_EDITS_LINEHASH = previous
  }
}

describe("tool.smaller_edits linehash", () => {
  bunIt("rejects malformed identity prefixes", () => {
    const codec = lineAnchors("b64")
    expect(() => codec.parseRenderedLine("bad line")).toThrow("Malformed anchored line")
    expect(() => codec.parseRenderedLine("0,abcd|x")).toThrow("Malformed anchor")
  })

  bunIt("normalizes line endings before hashing", () => {
    const codec = lineAnchors("b64")
    expect(codec.firstToken("alpha\r\nbeta")).toBe(codec.firstToken("alpha\nbeta"))
    expect(codec.firstToken("alpha\rbeta")).toBe(codec.firstToken("alpha\nbeta"))
  })

  bunIt("uses a 4-character digest and tolerates copied line content in anchors", () => {
    const codec = lineAnchors("b64")
    expect(codec.firstToken("alpha")).toHaveLength(DIGEST_WIDTH)
    expect(codec.parseAnchor("12,abcd|const x = 1")).toEqual({ lineno: 12, token: "abcd" })
    expect(codec.parseAnchor("12,ab")).toEqual({ lineno: 12, token: "ab" })
  })
})

describe("tool.smaller_edits linehash tokenice", () => {
  bunIt("parses line,word anchors and rendered lines", () => {
    const token = LineHashTokenice100k.firstToken("const x = 1")
    const rendered = LineHashTokenice100k.formatRenderedLine({ lineno: 12, token, content: "const x = 1" })

    expect(rendered).toBe(`12,${token}!const x = 1`)
    expect(LineHashTokenice100k.parseAnchor(rendered)).toEqual({ lineno: 12, token })
    expect(LineHashTokenice100k.parseRenderedLine(rendered)).toEqual({
      lineno: 12,
      token,
      content: "const x = 1",
      text: rendered,
    })
  })

  bunIt("normalizes line endings before deriving nonce words", () => {
    expect(LineHashTokenice100k.firstToken("alpha\r\nbeta")).toBe(LineHashTokenice100k.firstToken("alpha\nbeta"))
    expect(LineHashTokenice100k.firstToken("alpha\rbeta")).toBe(LineHashTokenice100k.firstToken("alpha\nbeta"))
  })

  bunIt("emits lowercase nonce words and matches exact anchors", () => {
    const token = LineHashTokenice100k.firstToken("alpha")

    expect(token).toMatch(/^[a-z]+$/)
    expect(LineHashTokenice100k.matchAnchorToken(token, [token])).toEqual({ _tag: "match" })
    expect(LineHashTokenice100k.matchAnchorToken(token.slice(0, 3), [token])).toEqual({ _tag: "miss" })
    expect(LineHashTokenice100k.parseAnchor(`12,${token.toUpperCase()}`)).toEqual({ lineno: 12, token })
  })

  bunIt("stays deterministic per mode and distinguishes configured vocabularies", () => {
    expect(LineHashTokenice100k.firstToken("alpha")).toBe(LineHashTokenice100k.firstToken("alpha"))
    expect(LineHashTokenice100k.firstToken("alpha")).not.toBe(LineHashTokenice200k.firstToken("alpha"))
  })

  bunIt("selects implementations by explicit parameter and envvar", () => {
    expect(lineAnchors("b64").name).toBe("linehash-b64")
    expect(lineAnchors("tokenice-cl100k").name).toBe("linehash-tokenice-cl100k")
    expect(lineAnchors("tokenice-o200k").name).toBe("linehash-tokenice-o200k")

    const restore = setLineHash("tokenice-cl100k")
    try {
      expect(LineAnchors.name).toBe("linehash-tokenice-cl100k")
    } finally {
      restore()
    }
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
          { _tag: "line", fileno: 2, orig_fileno: 2, token: "line-2", content: "two" },
          { _tag: "line", fileno: 3, orig_fileno: 3, token: "line-3", content: "three" },
          { _tag: "line", fileno: 4, orig_fileno: 4, token: "line-4", content: "four" },
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
        { _tag: "line", fileno: 5, orig_fileno: 3, token: "line-3", content: "three" },
        { _tag: "line", fileno: 6, orig_fileno: 4, token: "line-4", content: "four" },
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
        { _tag: "line", fileno: 5, orig_fileno: 4, token: "line-4", content: "four" },
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
          { _tag: "line", fileno: 1, orig_fileno: 1, token: "old-1", content: "alpha" },
          { _tag: "line", fileno: 2, orig_fileno: 2, token: "old-2", content: "beta" },
        ],
      })

      yield* state.replaceWindowLines({
        filePath,
        start: 2,
        end: 3,
        lines: [
          { _tag: "line", fileno: 2, orig_fileno: 2, token: "new-2", content: "BETA" },
          { _tag: "line", fileno: 3, orig_fileno: 3, token: "new-3", content: "gamma" },
        ],
      })

      const refreshed = yield* state.getFileState(filePath)
      expect(refreshed.atoms).toEqual([
        { _tag: "line", fileno: 1, orig_fileno: 1, token: "old-1", content: "alpha" },
        { _tag: "line", fileno: 2, orig_fileno: 2, token: "new-2", content: "BETA" },
        { _tag: "line", fileno: 3, orig_fileno: 3, token: "new-3", content: "gamma" },
      ])
      expect(
        yield* state.resolveVisibleLine({ filePath, lineno: 2, token: "old-2" }),
      ).toBeUndefined()
      expect(
        yield* state.resolveVisibleLine({ filePath, lineno: 2, token: "new-2" }),
      ).toEqual({ _tag: "line", fileno: 2, orig_fileno: 2, token: "new-2", content: "BETA" })
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
      expect(new Set(firstLines.map((line) => line.token)).size).toBe(3)

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
            start: `${secondDup.lineno},${secondDup.token}`,
            end: `${secondDup.lineno},${secondDup.token}`,
            content: "mid",
          },
        ],
      })

      expect(yield* load(filePath)).toBe("alpha\ndup\nmid\nomega\n")
      const returnedLines = displayLines(firstEdit.metadata.display.text)
      const midLine = returnedLines.find((line) => line.content === "mid")
      const omegaLine = returnedLines.find((line) => line.content === "omega")
      expect(midLine).toBeDefined()
      expect(midLine?.token).not.toBe(secondDup.token)
      expect(omegaLine).toBeDefined()

      yield* runEdit({
        filePath,
        operations: [
          {
            kind: "replace_range",
            start: `${omegaLine!.lineno},${omegaLine!.token}`,
            end: `${omegaLine!.lineno},${omegaLine!.token}`,
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
            start: `${one.lineno},${one.token}`,
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
            start: `${inserted.lineno},${inserted.token}`,
            end: `${shiftedTwo.lineno},${shiftedTwo.token}`,
          },
        ],
      })
      expect(yield* load(filePath)).toBe("one\nthree\n")
      expect(two.lineno).toBe(2)
    }),
  )

  it.instance("accepts anchors with copied line content in edit operations", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "copied-anchor.txt")
      yield* put(filePath, "alpha\nbeta\ngamma\n")

      const read = yield* runRead({ filePath })
      const lines = displayLines(fileDisplayText(read.metadata.display))
      const beta = lines.find((line) => line.content === "beta")!

      yield* runEdit({
        filePath,
        operations: [
          {
            kind: "replace_range",
            start: `${beta.lineno},${beta.token}|${beta.content}`,
            end: `${beta.lineno},${beta.token}|${beta.content}`,
            content: "BETA",
          },
        ],
      })

      expect(yield* load(filePath)).toBe("alpha\nBETA\ngamma\n")
    }),
  )

  it.instance("accepts unambiguous short-hash anchors", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "short-anchor.txt")
      yield* put(filePath, "alpha\nbeta\ngamma\n")

      const read = yield* runRead({ filePath })
      const lines = displayLines(fileDisplayText(read.metadata.display))
      const beta = lines.find((line) => line.content === "beta")!

      yield* runEdit({
        filePath,
        operations: [
          {
            kind: "replace_range",
            start: `${beta.lineno},${beta.token.slice(0, 2)}`,
            end: `${beta.lineno},${beta.token.slice(0, 2)}`,
            content: "BETA",
          },
        ],
      })

      expect(yield* load(filePath)).toBe("alpha\nBETA\ngamma\n")
    }),
  )

  it.instance("rejects ambiguous short-hash anchors", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "ambiguous-short-anchor.txt")
      yield* put(filePath, "alpha\nbeta\ngamma\n")

      const state = yield* SmallerEditsState
      yield* state.replaceWindowLines({
        filePath,
        start: 2,
        end: 2,
        lines: [
          { _tag: "line", fileno: 2, orig_fileno: 2, token: "ab12", tokenAliases: ["ac34"], content: "beta" },
          { _tag: "line", fileno: 4, orig_fileno: 2, token: "ab56", content: "beta shifted" },
        ],
      })

      const err = yield* failEdit({
        filePath,
        operations: [
          {
            kind: "replace_range",
            start: "2,ab",
            end: "2,ab",
            content: "BETA",
          },
        ],
      })

      expect(err.message).toContain("ambiguous in remembered state")
    }),
  )

  it.instance("allows same-file batched edits that only touch adjacent boundaries", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "batched-boundaries.txt")
      yield* put(filePath, "alpha\nbeta\ngamma\ndelta\n")

      const read = yield* runRead({ filePath })
      const lines = displayLines(fileDisplayText(read.metadata.display))
      const beta = lines.find((line) => line.content === "beta")!
      const gamma = lines.find((line) => line.content === "gamma")!

      yield* runEdit({
        filePath,
        operations: [
          {
            kind: "insert_after",
            start: `${beta.lineno},${beta.token}`,
            content: "beta-note",
          },
          {
            kind: "replace_range",
            start: `${gamma.lineno},${gamma.token}`,
            end: `${gamma.lineno},${gamma.token}`,
            content: "GAMMA",
          },
        ],
      })

      expect(yield* load(filePath)).toBe("alpha\nbeta\nbeta-note\nGAMMA\ndelta\n")
    }),
  )

  it.instance("allows batched insertions anchored to a line that is also replaced", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "batched-conflict.txt")
      yield* put(filePath, "alpha\nbeta\ngamma\n")

      const read = yield* runRead({ filePath })
      const lines = displayLines(fileDisplayText(read.metadata.display))
      const beta = lines.find((line) => line.content === "beta")!

      yield* runEdit({
        filePath,
        operations: [
          {
            kind: "replace_range",
            start: `${beta.lineno},${beta.token}`,
            end: `${beta.lineno},${beta.token}`,
            content: "BETA",
          },
          {
            kind: "insert_after",
            start: `${beta.lineno},${beta.token}`,
            content: "beta-note",
          },
        ],
      })

      expect(yield* load(filePath)).toBe("alpha\nBETA\nbeta-note\ngamma\n")
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
            start: `${slot.lineno},${slot.token}`,
            end: `${slot.lineno},${slot.token}`,
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
            start: "4,aaaa",
            end: "4,aaaa",
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
            start: `${two.lineno},${two.token}`,
            end: `${two.lineno},${two.token}`,
            content: "dos",
          },
        ],
      })

      expect(err.message).toContain("no longer matches the live file")
    }),
  )

  it.instance("keeps previously remembered anchors valid after disjoint insertions", () =>
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

      yield* runEdit({
        filePath,
        operations: [
          {
            kind: "replace_range",
            start: `${oldThree.lineno},${oldThree.token}`,
            end: `${oldThree.lineno},${oldThree.token}`,
            content: "THREE",
          },
        ],
      })

      expect(yield* load(filePath)).toBe("zero\nzero-point-five\none\ntwo\nTHREE\nfour\n")
      const fresh = displayLines(inserted.metadata.display.text)
      expect(fresh.find((line) => line.content === "three")?.lineno).toBe(5)
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

for (const selection of ["tokenice-cl100k", "tokenice-o200k"] as const) {
  describe(`tool.smaller_edits ${selection}`, () => {
    it.instance("reads and edits with tokenice anchors", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filePath = path.join(test.directory, `${selection}-flow.txt`)
        yield* put(filePath, "alpha\nbeta\ngamma\nomega\n")

        const read = yield* runRead({ filePath }, ctx, selection)
        const lines = displayLinesFor(selection, fileDisplayText(read.metadata.display))
        const beta = lines.find((line) => line.content === "beta")!

        expect(beta.token).toMatch(/^[a-z]+$/)

        const firstEdit = yield* runEdit(
          {
            filePath,
            operations: [
              {
                kind: "replace_range",
                start: `${beta.lineno},${beta.token}`,
                end: `${beta.lineno},${beta.token}`,
                content: "BETA",
              },
            ],
          },
          ctx,
          selection,
        )

        expect(yield* load(filePath)).toBe("alpha\nBETA\ngamma\nomega\n")

        const refreshed = displayLinesFor(selection, fileDisplayText(firstEdit.metadata.display))
        const omega = refreshed.find((line) => line.content === "omega")!

        yield* runEdit(
          {
            filePath,
            operations: [
              {
                kind: "replace_range",
                start: `${omega.lineno},${omega.token}`,
                end: `${omega.lineno},${omega.token}`,
                content: "OMEGA",
              },
            ],
          },
          ctx,
          selection,
        )

        expect(yield* load(filePath)).toBe("alpha\nBETA\ngamma\nOMEGA\n")
      }),
    )

    it.instance("accepts copied tokenice anchors with payload text", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filePath = path.join(test.directory, `${selection}-copied.txt`)
        yield* put(filePath, "alpha\nbeta\ngamma\n")

        const read = yield* runRead({ filePath }, ctx, selection)
        const lines = displayLinesFor(selection, fileDisplayText(read.metadata.display))
        const beta = lines.find((line) => line.content === "beta")!

        yield* runEdit(
          {
            filePath,
            operations: [
              {
                kind: "replace_range",
                start: `${beta.lineno},${beta.token}!${beta.content}`,
                end: `${beta.lineno},${beta.token}!${beta.content}`,
                content: "BETA",
              },
            ],
          },
          ctx,
          selection,
        )

        expect(yield* load(filePath)).toBe("alpha\nBETA\ngamma\n")
      }),
    )

    it.instance("rejects shortened tokenice anchors", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filePath = path.join(test.directory, `${selection}-short.txt`)
        yield* put(filePath, "alpha\nbeta\ngamma\n")

        const read = yield* runRead({ filePath }, ctx, selection)
        const lines = displayLinesFor(selection, fileDisplayText(read.metadata.display))
        const beta = lines.find((line) => line.content === "beta")!

        const err = yield* failEdit(
          {
            filePath,
            operations: [
              {
                kind: "replace_range",
                start: `${beta.lineno},${beta.token.slice(0, -1)}`,
                end: `${beta.lineno},${beta.token.slice(0, -1)}`,
                content: "BETA",
              },
            ],
          },
          selection,
        )

        expect(err.message).toContain("not available in remembered state")
      }),
    )
  })
}

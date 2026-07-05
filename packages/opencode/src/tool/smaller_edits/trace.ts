import fs from "fs"
import path from "path"
import type { FileAtom, FileLine } from "./state"

type TraceContext = {
  sessionID?: string
  messageID?: string
  callID?: string
  filePath?: string
}

const MAX_TEXT = 400

export function traceSmallerEdits(type: string, data?: unknown, context?: TraceContext) {
  const target = process.env.OPENCODE_SMALLER_EDITS_TRACE
  if (!target) return

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.appendFileSync(
      target,
      serialize({
        time: new Date().toISOString(),
        pid: process.pid,
        type,
        sessionID: context?.sessionID,
        messageID: context?.messageID,
        callID: context?.callID,
        filePath: context?.filePath,
        data,
      }) + "\n",
    )
  } catch {}
}

export function snapshotAtoms(atoms: ReadonlyArray<FileAtom>) {
  return atoms.map(snapshotAtom)
}

export function snapshotAtom(atom: FileAtom) {
  if (atom._tag === "offset") {
    return {
      _tag: atom._tag,
      fileno: atom.fileno,
      orig_fileno: atom.orig_fileno,
      delta: atom.delta,
    }
  }

  return snapshotFileLine(atom)
}

export function snapshotFileLines(lines: ReadonlyArray<FileLine>) {
  return lines.map(snapshotFileLine)
}

export function snapshotFileLine(line: FileLine) {
  return {
    _tag: line._tag,
    fileno: line.fileno,
    orig_fileno: line.orig_fileno,
    token: line.token,
    tokenAliases: line.tokenAliases?.slice(),
    content: clip(line.content),
  }
}

export function snapshotRenderedLines(
  lines: ReadonlyArray<{ lineno: number; token: string; content: string; text: string }>,
) {
  return lines.map((line) => ({
    lineno: line.lineno,
    token: line.token,
    content: clip(line.content),
    text: clip(line.text),
  }))
}

export function snapshotError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }

  return {
    value: error,
  }
}

function clip(text: string) {
  if (text.length <= MAX_TEXT) return text
  return `${text.slice(0, MAX_TEXT)}... [${text.length} chars]`
}

function serialize(data: unknown) {
  return JSON.stringify(
    data,
    (_key, value) => {
      if (typeof value === "bigint") return String(value)
      return value
    },
    0,
  )
}

export type { AnchorMatchResult, LineAnchor, LineAnchorCodec, LineAnchorMorphology, RenderedLine } from "./linehash_iface"
export { DIGEST_ALPHABET, DIGEST_WIDTH, LineHashB64, MIN_DIGEST_MATCH_WIDTH } from "./linehash_b64"
export {
  LineHashTokenice100k,
  LineHashTokenice200k,
  makeLineHashTokenice,
  TOKENICE_FRAGMENT_LIMIT,
  TOKENICE_SEPARATOR,
  TOKENICE_WORD_COUNTS,
  TOKENICE_WORD_TARGET,
  TOKENICE_WORDS_BY_MODE,
} from "./linehash_tokenice"
export type { TokeniceMode } from "./linehash_tokenice"

import type { AnchorMatchResult, LineAnchor, LineAnchorCodec, LineAnchorMorphology, RenderedLine } from "./linehash_iface"
import { LineHashB64 } from "./linehash_b64"
import { LineHashTokenice100k, LineHashTokenice200k } from "./linehash_tokenice"

export type LineHashName = "b64" | "tokenice-cl100k" | "tokenice-o200k"

export const DEFAULT_LINEHASH = "b64" satisfies LineHashName

// Accepted smaller-edits linehash selectors:
// - `b64` (default)
// - `tokenice` (alias for `tokenice-cl100k`)
// - `tokenice-cl100k`
// - `tokenice-o200k`
//
// Runtime selection reads `OPENCODE_SMALLER_EDITS_LINEHASH` unless an explicit
// parameter is passed to `lineAnchors(...)`.

const LINEHASH_BY_NAME = {
  b64: LineHashB64,
  "tokenice-cl100k": LineHashTokenice100k,
  "tokenice-o200k": LineHashTokenice200k,
} satisfies Record<LineHashName, LineAnchorCodec>

export function lineHashName(input: string | undefined): LineHashName {
  if (!input) return DEFAULT_LINEHASH
  if (input === "b64") return "b64"
  if (input === "tokenice") return "tokenice-cl100k"
  if (input === "tokenice-cl100k") return "tokenice-cl100k"
  if (input === "tokenice-o200k") return "tokenice-o200k"
  throw new Error(`Unknown smaller-edits linehash implementation: ${input}`)
}

export function lineAnchors(selection?: LineHashName | string): LineAnchorCodec {
  return LINEHASH_BY_NAME[lineHashName(selection ?? process.env.OPENCODE_SMALLER_EDITS_LINEHASH)]
}

export const LineAnchors: LineAnchorCodec = {
  get name() {
    return lineAnchors().name
  },
  get morphology() {
    return lineAnchors().morphology
  },
  canonicalizeContent(content: string) {
    return lineAnchors().canonicalizeContent(content)
  },
  firstToken(content: string) {
    return lineAnchors().firstToken(content)
  },
  nextToken(prevToken: string, content: string) {
    return lineAnchors().nextToken(prevToken, content)
  },
  formatAnchor(anchor: LineAnchor) {
    return lineAnchors().formatAnchor(anchor)
  },
  formatRenderedLine(line: { lineno: number; token: string; content: string }) {
    return lineAnchors().formatRenderedLine(line)
  },
  parseAnchor(text: string) {
    return lineAnchors().parseAnchor(text)
  },
  parseRenderedLine(text: string) {
    return lineAnchors().parseRenderedLine(text)
  },
  matchAnchorToken(inputToken: string, candidateTokens: ReadonlyArray<string>): AnchorMatchResult {
    return lineAnchors().matchAnchorToken(inputToken, candidateTokens)
  },
  buildRenderedLines(lines: ReadonlyArray<string>, start?: number, end?: number): RenderedLine[] {
    return lineAnchors().buildRenderedLines(lines, start, end)
  },
}

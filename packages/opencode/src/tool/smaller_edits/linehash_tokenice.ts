import { createHash } from "node:crypto"
import { get_encoding } from "tiktoken"
import type { Tiktoken, TiktokenEncoding } from "tiktoken"
import type { LineAnchorCodec, RenderedLine } from "./linehash_iface"

export type TokeniceMode = "cl100k" | "o200k"

export const TOKENICE_SEPARATOR = "!"
export const TOKENICE_FRAGMENT_LIMIT = 96
export const TOKENICE_WORD_TARGET = 16384

const TOKENICE_WORD = /^[a-z]+$/
const TOKENICE_VOWEL = /[aeiouy]/
const ENCODING_BY_MODE = {
  cl100k: "cl100k_base",
  o200k: "o200k_base",
} satisfies Record<TokeniceMode, TiktokenEncoding>

export const TOKENICE_WORDS_BY_MODE = {
  cl100k: buildWordList(ENCODING_BY_MODE.cl100k),
  o200k: buildWordList(ENCODING_BY_MODE.o200k),
} satisfies Record<TokeniceMode, ReadonlyArray<string>>

export const TOKENICE_WORD_COUNTS = {
  cl100k: TOKENICE_WORDS_BY_MODE.cl100k.length,
  o200k: TOKENICE_WORDS_BY_MODE.o200k.length,
} satisfies Record<TokeniceMode, number>

export const LineHashTokenice100k = makeLineHashTokenice("cl100k")
export const LineHashTokenice200k = makeLineHashTokenice("o200k")

export function makeLineHashTokenice(mode: TokeniceMode): LineAnchorCodec {
  const words = TOKENICE_WORDS_BY_MODE[mode]
  const exampleToken = words[321]!
  return {
    name: `linehash-tokenice-${mode}`,
    morphology: {
      anchorLabel: "anchor",
      lineLabel: "anchored line",
      anchorExample: `12,${exampleToken}`,
      renderedLineExample: `12,${exampleToken}!const x = 1`,
      anchorFormatDescription: "`line,word` form like `12,aeray`",
      renderedLineFormatDescription: "`line,word!content` form like `12,aeray!const x = 1`",
      followupGuidance: "Copy anchors exactly, including the comma after the line number, then use the fresh returned anchors after each successful edit.",
    },
    canonicalizeContent,
    firstToken(content) {
      return tokeniceWord(mode, canonicalizeContent(content))
    },
    nextToken(prevToken, content) {
      return tokeniceWord(mode, `${prevToken}\0${canonicalizeContent(content)}`)
    },
    formatAnchor(anchor) {
      return `${anchor.lineno},${anchor.token}`
    },
    formatRenderedLine(line) {
      return `${this.formatAnchor({ lineno: line.lineno, token: line.token })}${TOKENICE_SEPARATOR}${line.content}`
    },
    parseAnchor(text) {
      const anchor = text.split(TOKENICE_SEPARATOR, 1)[0] ?? text
      const match = anchor.match(/^(\d+),([A-Za-z]+)$/)
      if (!match) throw new Error(`Malformed anchor: ${text}`)

      const lineno = Number(match[1])
      if (!Number.isInteger(lineno) || lineno < 1) {
        throw new Error(`Malformed anchor: ${text}`)
      }

      const token = match[2]!.toLowerCase()
      if (!TOKENICE_WORD.test(token)) {
        throw new Error(`Malformed anchor: ${text}`)
      }

      return { lineno, token }
    },
    parseRenderedLine(text) {
      const split = text.indexOf(TOKENICE_SEPARATOR)
      if (split === -1) throw new Error(`Malformed anchored line: ${text}`)
      const anchor = this.parseAnchor(text.slice(0, split))
      return {
        ...anchor,
        content: text.slice(split + 1),
        text,
      }
    },
    matchAnchorToken(inputToken, candidateTokens) {
      const normalizedInput = inputToken.toLowerCase()
      const matches = [...new Set(candidateTokens.map((candidate) => candidate.toLowerCase()))].filter(
        (candidate) => candidate === normalizedInput,
      )
      if (matches.length === 1) return { _tag: "match" }
      if (matches.length > 1) return { _tag: "ambiguous" }
      return { _tag: "miss" }
    },
    buildRenderedLines(lines, start = 1, end = lines.length) {
      if (lines.length === 0 || end < start) return []

      const result: RenderedLine[] = []
      let prevToken = ""
      for (let index = 0; index < lines.length; index++) {
        const lineno = index + 1
        const content = lines[index]!
        const token = lineno === 1 ? this.firstToken(content) : this.nextToken(prevToken, content)
        prevToken = token
        if (lineno < start) continue
        if (lineno > end) break
        result.push({
          lineno,
          token,
          content,
          text: this.formatRenderedLine({ lineno, token, content }),
        })
      }
      return result
    },
  }
}

function canonicalizeContent(content: string) {
  return content.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
}

function tokeniceWord(mode: TokeniceMode, input: string) {
  const words = TOKENICE_WORDS_BY_MODE[mode]
  return words[digestIndex(mode, input) % words.length]!
}

function digestIndex(mode: TokeniceMode, input: string) {
  return createHash("sha256").update(mode).update("\0").update(input).digest().readUInt32BE(0)
}

function buildWordList(encodingName: TiktokenEncoding) {
  const encoding = get_encoding(encodingName)
  const fragments = collectFragments(encoding)
  const words = collectWords(encoding, fragments)
  encoding.free()
  if (words.length < TOKENICE_WORD_TARGET) {
    throw new Error(`Tokenice word list for ${encodingName} only produced ${words.length} words`)
  }
  return words
}

function collectFragments(encoding: Tiktoken) {
  const fragments: Array<{ id: number; text: string }> = []
  const seen = new Set<string>()
  const tokenCount = encoding.token_byte_values().length
  for (let id = 0; id < tokenCount; id++) {
    if (fragments.length >= TOKENICE_FRAGMENT_LIMIT) break
    const text = decodeToken(encoding, id)
    if (!TOKENICE_WORD.test(text)) continue
    if (text.length > 3) continue
    if (seen.has(text)) continue
    if (text.length > 1 && !TOKENICE_VOWEL.test(text)) continue
    seen.add(text)
    fragments.push({ id, text })
  }
  return fragments
}

function collectWords(encoding: Tiktoken, fragments: ReadonlyArray<{ id: number; text: string }>) {
  const words: string[] = []
  const seen = new Set<string>()
  outer: for (const first of fragments) {
    for (const second of fragments) {
      for (const third of fragments) {
        const word = `${first.text}${second.text}${third.text}`
        if (!isPronounceableWord(word)) continue
        const encoded = [...encoding.encode_ordinary(word)]
        if (encoded.length !== 3) continue
        if (encoded[0] !== first.id || encoded[1] !== second.id || encoded[2] !== third.id) continue
        if (seen.has(word)) continue
        seen.add(word)
        words.push(word)
        if (words.length >= TOKENICE_WORD_TARGET) break outer
      }
    }
  }
  return words
}

function isPronounceableWord(word: string) {
  if (word.length < 5 || word.length > 9) return false
  if (!TOKENICE_WORD.test(word)) return false
  if ((word.match(/[aeiouy]/g) ?? []).length < 2) return false
  if (!TOKENICE_VOWEL.test(word.at(-1) ?? "")) return false
  if (/[bcdfghjklmnpqrstvwxyz]{4}/.test(word)) return false
  if (/(.)\1\1/.test(word)) return false
  return true
}

function decodeToken(encoding: Tiktoken, id: number) {
  return Buffer.from(encoding.decode(new Uint32Array([id]))).toString("utf8")
}

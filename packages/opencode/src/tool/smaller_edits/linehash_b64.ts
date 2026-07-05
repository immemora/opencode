import { createHash } from "node:crypto"
import type { AnchorMatchResult, LineAnchor, LineAnchorCodec, RenderedLine } from "./linehash_iface"

// Four URL-safe base64 characters carry 24 bits of digest material, which is
// shorter for the model to copy while still distinguishing nearby lines well.
export const DIGEST_WIDTH = 4
export const MIN_DIGEST_MATCH_WIDTH = 2
// RFC 4648 base64url keeps the prefix dense and shell/JSON friendly.
export const DIGEST_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

export const LineHashB64: LineAnchorCodec = {
  name: "linehash-b64",
  morphology: {
    anchorLabel: "anchor",
    lineLabel: "anchored line",
    anchorExample: "12,abcd",
    renderedLineExample: "12,abcd|const x = 1",
    anchorFormatDescription: "`line,token` form like `12,abcd`",
    renderedLineFormatDescription: "`line,token|content` form like `12,abcd|const x = 1`",
    followupGuidance: "Copy anchors from returned lines exactly. Shorter tokens may work only when unambiguous.",
  },
  canonicalizeContent(content) {
    return content.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
  },
  firstToken(content) {
    return digest(LineHashB64.canonicalizeContent(content))
  },
  nextToken(prevToken, content) {
    return digest(prevToken + LineHashB64.canonicalizeContent(content))
  },
  formatAnchor(anchor) {
    return `${anchor.lineno},${anchor.token}`
  },
  formatRenderedLine(line) {
    return `${LineHashB64.formatAnchor({ lineno: line.lineno, token: line.token })}|${line.content}`
  },
  parseAnchor(text) {
    const anchor = text.split("|", 1)[0] ?? text
    const match = anchor.match(
      new RegExp(`^(\\d+),([${escapeRegExp(DIGEST_ALPHABET)}]{${MIN_DIGEST_MATCH_WIDTH},${DIGEST_WIDTH}})$`),
    )
    if (!match) throw new Error(`Malformed anchor: ${text}`)

    const lineno = Number(match[1])
    if (!Number.isInteger(lineno) || lineno < 1) {
      throw new Error(`Malformed anchor: ${text}`)
    }

    return {
      lineno,
      token: match[2]!,
    }
  },
  parseRenderedLine(text) {
    const split = text.indexOf("|")
    if (split === -1) throw new Error(`Malformed anchored line: ${text}`)
    const anchor = LineHashB64.parseAnchor(text.slice(0, split))
    return {
      ...anchor,
      content: text.slice(split + 1),
      text,
    }
  },
  matchAnchorToken(inputToken, candidateTokens) {
    const matches = [...new Set(candidateTokens)].filter((candidate) => candidate.startsWith(inputToken))
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
      const token = lineno === 1 ? LineHashB64.firstToken(content) : LineHashB64.nextToken(prevToken, content)
      prevToken = token
      if (lineno < start) continue
      if (lineno > end) break
      result.push({
        lineno,
        token,
        content,
        text: LineHashB64.formatRenderedLine({ lineno, token, content }),
      })
    }
    return result
  },
}

function digest(input: string) {
  return createHash("sha256").update(input).digest("base64url").slice(0, DIGEST_WIDTH)
}

function escapeRegExp(input: string) {
  return input.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&")
}

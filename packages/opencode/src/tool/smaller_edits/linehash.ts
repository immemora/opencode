import { createHash } from "node:crypto"

// Six URL-safe base64 characters carry 36 bits of digest material, which is
// short enough to copy but wide enough to distinguish repeated nearby lines.
export const DIGEST_WIDTH = 6
// RFC 4648 base64url keeps the prefix dense and shell/JSON friendly.
export const DIGEST_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

export type IdentityAnchor = {
  lineno: number
  chainHash: string
}

export type IdentityLine = IdentityAnchor & {
  content: string
  text: string
}

export function canonicalizeLine(content: string) {
  return content.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
}

export function hashFirstLine(content: string) {
  return digest(canonicalizeLine(content))
}

export function hashNextLine(prevHash: string, content: string) {
  return digest(prevHash + canonicalizeLine(content))
}

export function formatIdentityAnchor(lineno: number, chainHash: string) {
  return `${lineno},${chainHash}`
}

export function formatIdentityLine(lineno: number, chainHash: string, content: string) {
  return `${formatIdentityAnchor(lineno, chainHash)}|${content}`
}

export function parseIdentityAnchor(text: string): IdentityAnchor {
  const match = text.match(new RegExp(`^(\\d+),([${escapeRegExp(DIGEST_ALPHABET)}]{${DIGEST_WIDTH}})$`))
  if (!match) throw new Error(`Malformed line identity: ${text}`)
  const lineno = Number(match[1])
  if (!Number.isInteger(lineno) || lineno < 1) {
    throw new Error(`Malformed line identity: ${text}`)
  }
  return {
    lineno,
    chainHash: match[2]!,
  }
}

export function parseIdentityLine(text: string) {
  const split = text.indexOf("|")
  if (split === -1) throw new Error(`Malformed identity-prefixed line: ${text}`)
  const anchor = parseIdentityAnchor(text.slice(0, split))
  return {
    ...anchor,
    content: text.slice(split + 1),
  }
}

export function buildIdentityLines(lines: string[], start = 1, end = lines.length) {
  if (lines.length === 0 || end < start) return [] as IdentityLine[]

  const result: IdentityLine[] = []
  let prevHash = ""
  for (let index = 0; index < lines.length; index++) {
    const lineno = index + 1
    const chainHash = lineno === 1 ? hashFirstLine(lines[index]!) : hashNextLine(prevHash, lines[index]!)
    prevHash = chainHash
    if (lineno < start) continue
    if (lineno > end) break
    result.push({
      lineno,
      chainHash,
      content: lines[index]!,
      text: formatIdentityLine(lineno, chainHash, lines[index]!),
    })
  }
  return result
}

function digest(input: string) {
  return createHash("sha256").update(input).digest("base64url").slice(0, DIGEST_WIDTH)
}

function escapeRegExp(input: string) {
  return input.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&")
}

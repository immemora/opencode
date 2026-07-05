export type LineAnchor = {
  lineno: number
  token: string
}

export type RenderedLine = LineAnchor & {
  content: string
  text: string
}

export type AnchorMatchResult =
  | { _tag: "match" }
  | { _tag: "ambiguous" }
  | { _tag: "miss" }

export type LineAnchorMorphology = {
  anchorLabel: string
  lineLabel: string
  anchorExample: string
  renderedLineExample: string
  anchorFormatDescription: string
  renderedLineFormatDescription: string
  followupGuidance: string
}

export interface LineAnchorCodec {
  readonly name: string
  readonly morphology: LineAnchorMorphology

  canonicalizeContent(content: string): string
  firstToken(content: string): string
  nextToken(prevToken: string, content: string): string

  formatAnchor(anchor: LineAnchor): string
  formatRenderedLine(line: { lineno: number; token: string; content: string }): string
  parseAnchor(text: string): LineAnchor
  parseRenderedLine(text: string): RenderedLine

  matchAnchorToken(inputToken: string, candidateTokens: ReadonlyArray<string>): AnchorMatchResult
  buildRenderedLines(lines: ReadonlyArray<string>, start?: number, end?: number): RenderedLine[]
}

import { FoldSession } from "@opencode-ai/context-warp-drive/session"
import type { FoldMessage } from "@opencode-ai/context-warp-drive/fold"
import type { ModelMessage } from "ai"

const DEFAULTS = {
  pressureCeiling: 200_000,
  freezeTtlMs: 300_000,
  hardThresholdGap: 25_000,
  maxTurnsBeforeFold: 20,
}

function envInt(key: string): number | undefined {
  const v = process.env[key]
  if (v === undefined || v === "") return
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : undefined
}

function resolve(cfg?: {
  freeze_ttl_ms?: number
  pressure_ceiling_tokens?: number
  hard_threshold_gap_tokens?: number
  max_turns_before_fold?: number
}) {
  const pressure =
    envInt("OPENCODE_CWD_PRESSURE_CEILING_TOKENS") ?? cfg?.pressure_ceiling_tokens ?? DEFAULTS.pressureCeiling
  const gap =
    envInt("OPENCODE_CWD_HARD_THRESHOLD_GAP_TOKENS") ?? cfg?.hard_threshold_gap_tokens ?? DEFAULTS.hardThresholdGap
  const soft = pressure * 4

  const fttl = envInt("OPENCODE_CWD_FREEZE_TTL_MS") ?? cfg?.freeze_ttl_ms ?? DEFAULTS.freezeTtlMs
  const freeze = fttl === 0 ? false : { enabled: true, ttlMs: fttl, maxTailChars: 30_000 }

  const mtbf = envInt("OPENCODE_CWD_MAX_TURNS_BEFORE_FOLD") ?? cfg?.max_turns_before_fold ?? DEFAULTS.maxTurnsBeforeFold
  const maxTurns = mtbf === 0 ? Infinity : mtbf

  return {
    pressureCeiling: pressure,
    freeze,
    foldConfig: {
      continuous: true,
      activeWindowTurns: 1,
      softThresholdChars: soft,
      hardThresholdChars: soft + gap * 4,
      maxTurnsBeforeFold: maxTurns,
      assistantTextBudget: {
        fullRetentionChars: 8_000,
        essenceRetentionChars: 20_000,
      },
      verbatimKeepChars: 2_000,
    },
  } as const
}

const sessions = new Map<string, FoldSession>()

function get(sessionID: string, cfg?: Parameters<typeof resolve>[0]): FoldSession {
  let s = sessions.get(sessionID)
  if (!s) {
    s = new FoldSession(resolve(cfg))
    sessions.set(sessionID, s)
  }
  return s
}

export function prepare(
  sessionID: string,
  messages: ModelMessage[],
  measuredInputTokens?: number,
  cfg?: Parameters<typeof resolve>[0],
): ModelMessage[] {
  const fold = get(sessionID, cfg)
  const outcome = fold.prepare(messages as FoldMessage[], { measuredInputTokens })
  return outcome.messages as ModelMessage[]
}

import { truthy } from "@opencode-ai/core/flag/flag"

const raw = process.env.OPENCODE_IMMEMORA_ENABLED ?? ""
const features = new Set(raw.split(/[\s,;]+/).filter(Boolean))
const isEnabled = truthy(raw)

export function enabled(): boolean {
  return isEnabled
}

export function isFeatureEnabled(feature: string): boolean {
  return isEnabled || features.has(feature)
}

export * as ExperimentalGate from "./immemora"

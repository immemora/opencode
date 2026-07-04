import { ExperimentalGate } from "@/immemora";
import { truthy } from "@opencode-ai/core/flag/flag";

export const smallerEditsEnabled = 
    ExperimentalGate.isFeatureEnabled("smaller_edits") || 
    truthy(process.env.OPENCODE_SMALLER_EDITS_ENABLED ?? "")
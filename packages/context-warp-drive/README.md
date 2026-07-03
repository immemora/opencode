# @opencode-ai/context-warp-drive

**Deterministic, zero-LLM rolling-fold context compaction for function-calling agent sessions.**

Keep long-running agent sessions under the provider context ceiling without LLM
summarization calls and without ending the session — while keeping provider
prompt caches hot. Page folded content back in the moment the agent touches it
again. Provider-agnostic (Anthropic, OpenAI, Gemini).

## Acknowledgments

This package is adapted from [context-warp-drive](https://github.com/dogtorjonah/context-warp-drive) by [Jonah Tarashansky](https://github.com/dogtorjonah), used under the MIT license. The original engine powers long-running multi-agent sessions with deterministic zero-LLM context folding, and we are grateful for the design and implementation.

This integration for the [Opencode](https://opencode.ai) codebase is authored by **ImMemora s.r.l.** ([immemora.ai](https://immemora.ai)).

## How It Works

The core insight: most LLM session compaction is wasted work because **the agent
already wrote the answers**. The context-warp-drive never asks the LLM to
summarize. Instead it:

1.  **Folds** older conversation turns into compact skeleton blocks using a
    deterministic algorithm — no LLM calls, no I/O, no forced dependencies.
2.  **Freezes** the folded view byte-identically: when nothing has changed
    between turns, the engine returns the cached view verbatim. This keeps
    provider prompt-caching economics (Anthropic, OpenAI) hot.
3.  **Recalls** folded content *ambiently*: when the agent re-touches a file or
    topic that was folded away, the engine injects an inline
    `[Recalled from fold — …]` card without waiting for a user command.
4.  **Harvests episodes** from glyph-tagged messages (`🏁` verdict, `⚠️` hazard,
    `❓` blocked, …) into a portable durable store for cross-session memory.

### Data Flow

```
User messages + Tool results
    │
    ▼
FoldSession.prepare(rawHistory, context)
    │
    ├─ 1. Evaluate fold freeze (cache hot?)
    │      ├─ HOT → return cached byte-identical view
    │      └─ COLD → continue
    │
    ├─ 2. Check pressure ceiling → hard epoch?
    │      ├─ YES → build raw rebirth seed → collapse all history
    │      └─ NO → continue
    │
    ├─ 3. Check tail epoch → append band?
    │      ├─ YES → fold new turns → freeze with new band
    │      └─ NO → full recompute
    │
    ├─ 4. Fold recall (ambient page-in)
    │      └─ buildFoldIndex → deriveBoundaryRecallSignals → buildFoldRecallContext
    │
    ├─ 5. Episodic capture + recall
    │      └─ deriveEpisodesFromMessages → recordEpisodes → recallEpisodeCards
    │
    └─ 6. Return compacted messages + recall context + episode cards
```

### Key Properties

| Property | Detail |
|---|---|
| **Zero LLM calls** | All folding, recall, and ranking is pure CPU deterministic computation. |
| **Byte-identical fold reuse** | Freeze layer ensures cache hits for Anthropic/OpenAI prompt caching. |
| **Provider-agnostic** | Engine emits `FoldMessage[]` — adapters handle serialization. |
| **No forced dependencies** | `better-sqlite3` (the only native dep) is an optional peer dep. |
| **Deterministic pipeline** | Same inputs → same outputs. Critical for testability and cache hits. |
| **Context window floors** | Guaranteed safe operating limits per model, not advertised maximums. |

## Configuration

### OpenCode Config (`opencode.json`)

```jsonc
{
  "experimental": {
    "context_warp_drive": {
      "enabled": true,                          // Enable (default: false)
      "freeze_ttl_ms": 300000,                  // Freeze cache TTL (0 = no freeze)
      "pressure_ceiling_tokens": 200000,        // Hard epoch trigger token ceiling
      "hard_threshold_gap_tokens": 25000,       // Gap between soft/hard char thresholds
      "max_turns_before_fold": 20               // Max turns before forced fold (0 = no limit)
    }
  }
}
```

### Environment Variables

| Variable | Overrides |
|---|---|
| `OPENCODE_CWD_ENABLED` | `true` / `1` to enable (takes precedence over config) |
| `OPENCODE_CWD_PRESSURE_CEILING_TOKENS` | `pressure_ceiling_tokens` (default: 200000) |
| `OPENCODE_CWD_FREEZE_TTL_MS` | `freeze_ttl_ms` (default: 300000) |
| `OPENCODE_CWD_HARD_THRESHOLD_GAP_TOKENS` | `hard_threshold_gap_tokens` (default: 25000) |
| `OPENCODE_CWD_MAX_TURNS_BEFORE_FOLD` | `max_turns_before_fold` (default: 20) |

### Default Tuning

| Parameter | Default | Meaning |
|---|---|---|
| `pressureCeiling` | 200k tokens | Measured input tokens that trigger a hard epoch (collapse all history into a continuity seed). |
| `freezeTtlMs` | 300,000 (5 min) | How long a folded view is cached before a recompute is forced. |
| `softThresholdChars` | 800k | Character level at which folding starts (4× pressure ceiling). |
| `hardThresholdChars` | 900k | Character level at which folding is aggressive. |
| `maxTurnsBeforeFold` | 20 | Maximum number of turns before folding regardless of char count. |
| `fullRetentionChars` | 8k | Per-turn chars preserved verbatim in a folded block. |
| `essenceRetentionChars` | 20k | Per-turn compressed chars in a folded block. |
| `verbatimKeepChars` | 2k | Chars of the active turn kept verbatim during folding. |

## Architecture

### Layers

| Layer | Source | Responsibility |
|---|---|---|
| Rolling Fold | `src/rollingFold.ts` | Deterministic message compression, turn detection, active window preservation |
| Fold Freeze | `src/foldFreeze.ts` | Cache-aware byte-identical fold reuse with TTL and epoch tracking |
| Context Budget | `src/contextBudget.ts` | Model-aware fold and pressure ceilings using geometry signposts |
| Glyph Grammar | `src/glyphs.ts` | Register-tagged message annotations (`🏁`, `⚠️`, `❓`, `🔍`) |
| Fold Terms | `src/foldTerms.ts` | IDF-weighted distinctive-term extraction for fold recall |
| Fold Recall | `src/foldRecall.ts` | Ambient page-in system that detects when folded content is relevant |
| Boundary Auction | `src/boundaryAuction.ts` | Shared recall budget across fold recall, episodic chain, active pins, and atlas |
| User Message Vault | `src/userMessageVault.ts` | Bounded continuity block preserving user directives across fold boundaries |
| Raw Rebirth Seed | `src/rawRebirthSeed.ts` | Portable deterministic raw-rebirth renderer with lineage glyph log |
| Episodic Engine | `src/foldEpisodes.ts` | Durable cross-session path-based memory with value ledger |
| Episode Store | `src/episodes/` | Portable SQLite-backed episode persistence and recall |
| Task Rail | `src/taskRail.ts` | Long-horizon execution state machine (`load` / `shoot` / `sprint` / `draft`) |
| FoldSession | `src/session/FoldSession.ts` | One-call orchestrator that wires all layers together |
| MemoryLoop | `src/host/MemoryLoop.ts` | Turnkey standalone host adapter wiring the full memory stack |

### Provider Adapters

| Adapter | Path | Purpose |
|---|---|---|
| Anthropic | `context-warp-drive/providers/anthropic` | Cache-control breakpoint injection for Anthropic API |
| Gemini CLI | `context-warp-drive/providers/gemini-cli` | Gemini CLI JSONL fold serialization |
| Codex CLI | `context-warp-drive/providers/codex-cli` | OpenAI Responses API fold adapter |
| Claude CLI | `context-warp-drive/providers/claude-cli` | Pure Claude Code CLI JSONL chain serialization |
| Claude CLI Loop | `context-warp-drive/host/claude-cli-loop` | Standalone Claude Code subprocess fold loop |
| Claude Tmux Loop | `context-warp-drive/host/claude-tmux-loop` | Interactive Claude Code tmux fold loop |

### Exports

| Export path | Entry point |
|---|---|
| `.` | `src/index.ts` (barrel) |
| `./fold` | Rolling fold algorithm + types |
| `./budget` | Context budget resolver |
| `./session` | FoldSession orchestrator |
| `./glyphs` | Glyph grammar + register prompts |
| `./episodes` | Episode store types + runtime |
| `./task-rail` | Task rail state machine |
| `./raw-rebirth-seed` | Raw rebirth seed renderer |
| `./providers/anthropic` | Anthropic cache-breakpoint adapter |
| `./providers/gemini-cli` | Gemini CLI fold adapter |
| `./providers/codex-cli` | Codex CLI fold adapter |
| `./providers/claude-cli` | Claude CLI fold adapter |
| `./host/claude-cli-loop` | Claude CLI fold loop |
| `./host/claude-tmux-loop` | Claude CLI tmux fold loop |

## Development

```bash
# Type check
bun run typecheck

# Run tests (from package directory)
bun test
```

# Architecture & Data Flow

**Antigravity Context Window** runs as a native **Antigravity Desktop Sidecar UI Extension** using only Node.js built-in modules (`node:http`, `node:https`, `node:fs`, `node:crypto`, `node:sqlite`, `node:child_process`) plus Antigravity's injected `sidecar_sdk` and `/preload.js`.

## High-Level Components

```text
Antigravity Desktop App
  ├── AUX_PANE (/)  ───────┐
  ├── SIDEBAR (/full) ─────┼──> window.sidecar.fetch('/api/snapshot')
  └── /preload.js ─────────┘          │
                                      ▼
                    sidecars/context_window/main.mjs
                      ├── SidecarApp (sidecar_sdk)
                      ├── Standalone HTTP Server (127.0.0.1)
                      │
                      ├── 1. Primary: lib/rpc.mjs (Connect-RPC)
                      │     ├── GetAllCascadeTrajectories
                      │     ├── GetAvailableModels
                      │     ├── GetCascadeTrajectoryGeneratorMetadata
                      │     └── GetCascadeTrajectorySteps
                      │
                      ├── 2. Fallback: lib/sqlite-fallback.mjs
                      │     └── node:sqlite (?mode=ro) + Protobuf wire decoder
                      │         (~/.gemini/antigravity*/conversations/*.db)
                      │
                      └── 3. Analytics: lib/telemetry.mjs
                            ├── Additive token accounting
                            ├── Compaction drop detection
                            ├── Timeline series & Y-bounds
                            └── Top 5 spike attribution
```

## Token Accounting Semantics

Antigravity's `ModelUsageStats` reports prompt tokens **additively** per generation turn:

- `cacheTokens` = `cacheReadTokens`
- `uncachedTokens` = `inputTokens` (fresh) + `cacheCreationTokens`
- `usedTokens` = `cacheTokens + uncachedTokens`
- `cacheHitLastTurnPct` = `(cacheTokens / usedTokens) * 100`
- `outputTokens` = `usage.outputTokens` (which already includes `thinkingOutputTokens + responseOutputTokens`)

## Spike Attribution (`Top Spikes`)

For each turn $i$ with a positive context growth ($\Delta_i = \text{used}_i - \text{used}_{i-1} > 0$):
1. All execution steps in `(prevTurn.stepIndex, currentTurn.stepIndex]` (plus `stepIndices` listed in `gen_metadata`) are collected.
2. Tool calls (`metadata.toolCall`, `plannerResponse.toolCalls`, and typed step payloads like `viewFile`, `runCommand`, `codeAction`) are normalized (`view_file` → `read_file`, `write_to_file` → `write_file`, `replace_file_content` → `edit_file`).
3. Turns are sorted descending by $\Delta_i$ and the top 5 are formatted with tool counts and target basenames.

## Dual Runtime Modes

1. **Antigravity Sidecar Mode** (`ANTIGRAVITY_SIDECAR_WEB_PORT` set):
   - Boots `SidecarApp` from `sidecar_sdk`.
   - Registers `/` (`AUX_PANE`), `/full` (`SIDEBAR`), `/api/health`, `/api/snapshot`, and `/api/preferences`.
   - Persists preferences in `$ANTIGRAVITY_EXECUTABLE_DATA_DIR/prefs.json`.
2. **Standalone Loopback Mode** (`--standalone` / `--demo`):
   - Binds strictly to `127.0.0.1` for local browser preview (`npm run demo`) and automated integration tests (`npm test`).

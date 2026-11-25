# Customization Guide

You can customize the appearance, metrics, and defaults without any build tooling.

## 1. Visual Theme & Colors

Edit CSS variables at the top of [`sidecars/context_window/ui.html`](../sidecars/context_window/ui.html):

```css
:root {
  --cw-bg: var(--background, #090b0f);
  --cw-surface: var(--card, #101319);
  --cw-border: var(--border, rgba(255, 255, 255, 0.08));
  --cw-blue: #4c8df6;   /* Cache bar & curve */
  --cw-teal: #2dd4bf;   /* Total context curve & spike deltas */
  --cw-green: #22c55e;  /* Uncached segment & Live indicator */
  --cw-amber: #f59e0b;  /* >= 75% warning & compaction badge */
  --cw-red: #ef4444;    /* >= 90% critical warning */
}
```

Frontend changes to `ui.html` take effect the next time you close and reopen the panel.

## 2. Polling Interval & Limit Presets

In [`sidecars/context_window/ui.html`](../sidecars/context_window/ui.html):
- `POLL_MS = 2500` controls how often the panel checks `/api/snapshot` (visibility-gated, pauses automatically when hidden; unchanged snapshots short-circuit via ETag).
- `LIMIT_PRESETS` defines the entries in the `178K / 1M ▾` dropdown.

## 3. Panel Titles & Entrypoints

Edit [`sidecars/context_window/sidecar.json`](../sidecars/context_window/sidecar.json):
- `views[0].title` (`"Context"`) sets the tab label in the right-hand `AUX_PANE`.
- `views[1].title` (`"Context Window"`) sets the item label under **Plugins** in the left `SIDEBAR`.

## 4. Model Context Limits

Live model limits come automatically from Antigravity's `GetAvailableModels` RPC. Fallback defaults for offline SQLite or unknown models live in `MODEL_LIMIT_FALLBACKS` inside [`sidecars/context_window/lib/rpc.mjs`](../sidecars/context_window/lib/rpc.mjs).

> After editing `main.mjs`, `sidecar.json`, or `lib/*.mjs`, toggle the plugin **Disable → Enable** in **Customizations → Installed** so Antigravity restarts the sidecar process.

# Contributing

Contributions are welcome! This project intentionally maintains **zero external npm runtime dependencies** so it executes directly on Antigravity Desktop's bundled Node.js runtime on macOS, Windows, and Linux.

## Local Setup

Requires **Node.js 22+** (for built-in `node:test` and `node:sqlite`). No `npm install` is needed.

```bash
git clone https://github.com/omerokumus1/agy-context-plugin.git
cd agy-context-plugin
npm test
```

## Previewing UI Changes

```bash
npm run demo
```

Open:
- `http://127.0.0.1:17840/` (`AUX_PANE` compact view)
- `http://127.0.0.1:17840/full` (`SIDEBAR` full dashboard + Turn Ledger)

Append `?theme=light` or `?theme=dark` to test both theme polarities.

## Pull Request Checklist

1. Keep zero runtime dependencies in `package.json`.
2. Ensure `npm test` passes with 0 failures.
3. Validate plugin structure if `agy` CLI is installed: `agy plugin validate --strict .`
4. Keep changes cross-platform (macOS, Linux, Windows).

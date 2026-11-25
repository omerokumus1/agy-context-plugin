# Antigravity Context Window

A lightweight, zero-dependency open-source **Context Window** sidecar plugin for **Google Antigravity Desktop**.

Built with native `sidecar_sdk` + Antigravity Language Server Connect-RPC and a `node:sqlite` protobuf fallback, it adds a live toggleable **Context** side panel (`AUX_PANE`) and a full-width **Context Window** sidebar view (`SIDEBAR`) directly inside Antigravity Desktop — with **zero** external npm dependencies and **zero** extra LLM tokens per refresh.

> **Docs:** [Türkçe Rehber](docs/README.tr.md) · [Architecture](docs/ARCHITECTURE.md) · [Customization](docs/CUSTOMIZATION.md) · [Contributing](CONTRIBUTING.md)

## Features

- **Live Context Usage Gauge**: Real-time percentage, segmented **Cache** (blue) + **Uncached** (green) + **Free** bar, and a clickable ceiling selector (`Auto`, `128K`, `200K`, `256K`, `512K`, `1M`, `2M`).
- **Conversation Switcher**: Follow the active conversation automatically or switch between recent sessions from the header dropdown.
- **Prompt Cache & Output Metrics**:
  - **Cache Hit %** (last turn & cumulative session tooltip)
  - **Output** total tokens (with response vs thinking breakdown tooltip)
  - **Activity** turns, tool calls, and session duration
- **Interactive Turn Timeline**: Dual-curve SVG area chart tracking total context and cached tokens across turns (`#1` to `#N`), including compaction dips and hover inspection.
- **Top 5 Context Spikes**: Automatically attributes the largest `+Δ` context jumps to the exact tools and files (`read_file`, `write_file`, `edit_file`, etc.) that triggered them. Click any spike to highlight that turn on the timeline.
- **Dual Entrypoints**:
  - **Top-right Toggle Panel (`AUX_PANE` at `/`)**: Compact `Context` tab alongside your chat.
  - **Left Sidebar (`SIDEBAR` at `/full`)**: Full-width `Context Window` dashboard under **Plugins** with a turn-by-turn ledger table.
- **Theme Native**: Automatically adapts to Antigravity Light, Dark, and High-Contrast themes via `/preload.js`.
- **100% Local & Private**: Zero network telemetry; reads only from Antigravity's local Language Server RPC and local `~/.gemini/*/conversations/*.db` SQLite files.

## Installation

### Option 1 — Antigravity CLI (`agy`) (Recommended)

```bash
agy plugin install https://github.com/omerokumus1/agy-context-plugin
```

### Option 2 — Zero-dependency Installer Script

```bash
git clone https://github.com/omerokumus1/agy-context-plugin.git
cd agy-context-plugin
node scripts/install.mjs
```

This copies the plugin to `~/.gemini/config/plugins/agy-context-plugin/` and enables `agy-context-plugin/context_window` in `~/.gemini/config/config.json` without overwriting your existing configuration.

For workspace-only installation (`.agents/plugins/agy-context-plugin/`):

```bash
node scripts/install.mjs --workspace
```

### Option 3 — Antigravity Desktop (Install from URL)

In Antigravity Desktop, open **Customizations → Plugins → Install from URL** and enter:

```text
https://github.com/omerokumus1/agy-context-plugin
```

Or validate & install from a local clone with `agy`:

```bash
agy plugin validate --strict .
agy plugin install .
```

### Option 4 — Manual Installation

Copy this repository folder to `~/.gemini/config/plugins/agy-context-plugin/` and enable it under **Customizations → Installed** in Antigravity Desktop.

## Usage

1. In **Antigravity Desktop**, click the **Toggle Panel** icon in the top-right corner (or open the **`+`** tab menu) and select **Context**.
2. Or open **Plugins → Context Window** from the left sidebar for the full-width view + Turn Ledger.
3. You can also type `/context-window` in chat to surface the quick-open `sidecar://agy-context-plugin/context_window/` pill.

## Development & Preview

Run the automated test suite (uses Node.js built-in test runner, zero `npm install` needed):

```bash
npm test
```

Preview the UI locally in any browser using realistic demo data:

```bash
npm run demo
# Open http://127.0.0.1:17840/ (AUX_PANE) or http://127.0.0.1:17840/full (SIDEBAR)
```

## Project Structure

```text
agy-context-plugin/
├── plugin.json                              # Official Antigravity plugin manifest
├── assets/
│   └── logo.svg                             # 1:1 vector icon
├── sidecars/
│   └── context_window/
│       ├── sidecar.json                     # AUX_PANE (/) + SIDEBAR (/full) UI config
│       ├── main.mjs                         # Sidecar & standalone HTTP server
│       ├── ui.html                          # Self-contained frontend UI
│       └── lib/
│           ├── rpc.mjs                      # Language Server discovery & Connect-RPC client
│           ├── sqlite-fallback.mjs          # Pure-JS protobuf decoder + node:sqlite reader
│           ├── telemetry.mjs                # Token accounting, timeline & spike attribution
│           └── demo.mjs                     # Standalone demo fixture
├── skills/
│   └── context-window/
│       └── SKILL.md                         # /context-window companion skill
├── scripts/
│   └── install.mjs                          # Cross-platform installer / uninstaller
└── tests/
    └── context-window.test.mjs              # Unit & HTTP integration tests
```

## Customizing the Design

All UI styling, colors, layout, and chart rendering live in a single self-contained file: [`sidecars/context_window/ui.html`](sidecars/context_window/ui.html). Edit the CSS variables or markup and reopen the side panel to see changes immediately — no build step required. See [`docs/CUSTOMIZATION.md`](docs/CUSTOMIZATION.md) for all options.

## Documentation

- [Türkçe Kullanım ve Kurulum Rehberi](docs/README.tr.md)
- [Architecture & Data Flow](docs/ARCHITECTURE.md)
- [Customization Guide](docs/CUSTOMIZATION.md)
- [Contributing](CONTRIBUTING.md)

## Troubleshooting

- **"Waiting for Antigravity session data"**: Open any conversation and send at least one message, then click the refresh (`↻`) icon.
- **Changes to `main.mjs` or `lib/*.mjs` not applying**: Open **Customizations → Installed**, toggle **Context Window** **Disable → Enable** so Antigravity restarts the sidecar process.
- **Check installation status**: Run `node scripts/install.mjs --status` (or `--uninstall` to remove).

## License

[MIT](LICENSE)

---
name: context-window
description: >-
  Open the Context Window sidecar panel in Antigravity Desktop to monitor live
  token usage, prompt cache hit rate, turn-by-turn context timeline, and top
  context spikes. Use when the user asks about context usage, token limits,
  cache efficiency, or wants to open the Context Window panel.
---

# Context Window

Use this skill when the user wants to inspect live context window utilization,
prompt cache hit rate, turn-by-turn growth, or open the Context Window panel in
Antigravity Desktop.

## Opening the Panel

If the `agy-context-plugin` plugin and its `context_window` sidecar are enabled,
present this clickable pill so the user can toggle the right-hand side panel
(`AUX_PANE`):

[Context Window](sidecar://agy-context-plugin/context_window/)

Users can also:
- Click the **Toggle Panel** button in the top-right title bar of Antigravity Desktop.
- Open **Plugins → Context Window** in the left sidebar for the full-width dashboard (`/full`).

## If Not Enabled Yet

If the sidecar is not running yet, guide the user to enable it:

1. Open [Context Window](customization://agy-context-plugin) under **Customizations → Installed**.
2. Enable both the **Context Window** plugin and its **Context Window** sidecar.
3. Click the **Context** tab in the top-right side panel or **Plugins → Context Window** in the left sidebar.

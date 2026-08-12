---
name: herdr-browser
description: Connect browser automation tools to a Chromium view rendered inside a Herdr browser pane.
---

# Herdr Browser

Use this skill when the user wants Browser Use, PinchTab, Playwright, Chrome
DevTools MCP, or another CDP client to control the browser visible in Herdr.

Do not install `herdr-browser` globally. Discover the installed or linked plugin
root by running:

```bash
herdr plugin list --plugin official.browser --json
```

Read `result.plugins[0].plugin_root` from the JSON response. Run the CLI with
Bun from any working directory:

```bash
bun run "<plugin_root>/src/cli.ts"
```

## Required visible-view bootstrap

A Herdr pane labeled `Browser` may still be an ordinary shell pane. Running a
CDP client from that shell controls Chromium but leaves only the command prompt
visible. Create the plugin-owned viewer pane first:

```bash
herdr plugin pane open \
  --plugin official.browser \
  --entrypoint browser \
  --workspace "$HERDR_WORKSPACE_ID" \
  --placement tab \
  --focus
```

The command returns the plugin pane ID. Use
`herdr plugin pane focus <pane_id>` if the rendered viewer is not visible.
`--placement tab` is the reliable path when starting from an existing Herdr
tab; do not repurpose a regular terminal pane with the label `Browser`.

Then connect the automation client from any Herdr shell pane. For
browser-harness, use the installed wrapper when the current project does not
provide `./scripts/bh-herdr`:

```bash
BH_HERDR="$HOME/.claude/skills/browser-harness/scripts/bh-herdr"
"$BH_HERDR" run -c $'reuse_tab("https://example.com")\nwait_for_load()\nprint(page_info())'
```

Use Bash ANSI-C quoting (`$'...'`) for multi-line Python. Do not put literal
`\\n` inside ordinary single quotes: Python receives the backslash and raises
`SyntaxError: unexpected character after line continuation character`.

### Inspect and connect workflows

For a first-class, view-scoped connection (and to open/focus the viewer when
needed), use:

```bash
herdr-browser inspect
herdr-browser inspect --view <view-id>
```

`inspect` selects the sole live view or opens exactly one plugin-owned viewer
pane. It prints the gateway HTTP endpoint, browser/page WebSocket URLs, and
ready-to-copy CDP client snippets. `chrome-devtools-mcp` and Playwright MCP
are automation clients, not browser windows; attaching them will not render a
native Chrome tab. A remote CDP target also cannot be imported into another
Chrome process as an ordinary native tab.

State is session-scoped. If a plugin pane and shell resolve different state
files, pass the same path explicitly with `HERDR_BROWSER_DAEMON_STATE` (the
`inspect` command does this for newly opened panes).

List live browser views before connecting:

```bash
bun run "<plugin_root>/src/cli.ts" views
```

Select the intended view from its `view_id`, `pane_id`, URL, title, and tabs.
Never guess when more than one view is present. Connect with:

```bash
bun run "<plugin_root>/src/cli.ts" connect --view <view_id>
```

The response contains a view-scoped `cdp_http_url`, `browser_ws_url`, and the
currently active target. Use the browser-level endpoint so the automation tool
can create, inspect, select, and close multiple tabs in that view.

Standard CDP `Target.createTarget`, `Target.activateTarget`,
`Page.bringToFront`, and `Target.closeTarget` operations synchronize with the
Herdr tab strip and rendered target. A tool that changes only its own internal
selected-page state must also bring that page to front; local tool state is not
observable through CDP.

Tool bootstrap:

- Browser Use: set `BU_CDP_URL` to `cdp_http_url` or `BU_CDP_WS` to
  `browser_ws_url`.
- PinchTab: enable its external attach policy, then attach a bridge to
  `browser_ws_url` or `cdp_http_url`.
- Playwright: call `chromium.connectOverCDP(cdp_http_url)`.
- Playwright MCP: pass `--cdp-endpoint=<cdp_http_url>`.
- Chrome DevTools MCP: pass `--browser-url=<cdp_http_url>`.

Herdr Browser owns Chromium lifecycle. Closing a connected automation client
disconnects it from the gateway without terminating Chromium. Closing the Herdr
browser pane closes its view and gateway.

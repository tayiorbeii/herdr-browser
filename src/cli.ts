#!/usr/bin/env bun

import { resolve } from "node:path";

import {
  captureScreenshot,
  createBrowserSession,
  evaluate,
  navigate,
  pageTitle,
} from "./browser";
import { parseArgs } from "./args";
import { loadConfig } from "./config";
import { openBrowserPane } from "./herdr";
import { daemonStateFile } from "./paths";
import {
  automation,
  back,
  clickMouse,
  consoleEntries,
  evalExpression,
  ensureView,
  forward,
  metrics,
  listViews,
  selectSoleView,
  openUrl,
  pageText,
  reload,
  screenshotData,
  selectorClick,
  selectorPress,
  selectorType,
  status,
  stopDaemon,
  stopLoading,
  switchTab,
  waitForExpression,
  waitForViewHeartbeat,
  wheelMouse,
} from "./daemonClient";

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    printHelp();
    return;
  }

  if (args.command === "smoke") {
    const url = args.positionals[0] ?? "data:text/html,<title>herdr-browser</title><h1>ok</h1>";
    await withSession(async (session) => {
      await navigate(session, url);
      const title = await pageTitle(session);
      if (args.output) {
        await captureScreenshot(session, resolve(args.output));
      }
      console.log(JSON.stringify({
        ok: true,
        url,
        title,
        screenshot: args.output ? resolve(args.output) : null,
      }, null, 2));
    });
    return;
  }

  if (args.command === "views") {
    console.log(JSON.stringify(await listViews(), null, 2));
    return;
  }

  if (args.command === "inspect") {
    console.log(JSON.stringify(await inspectView(args.view), null, 2));
    return;
  }

  if (args.command === "connect") {
    const viewId = await resolveExistingView(args.view ?? process.env.HERDR_BROWSER_VIEW_ID?.trim());
    console.log(JSON.stringify(await automation(viewId), null, 2));
    return;
  }

  if (args.command !== "stop") {
    await ensureView();
  }

  if (args.command === "eval") {
    const [first, second] = args.positionals;
    requireArg(first, "missing expression or URL");
    if (second) {
      await openUrl(first);
      console.log(JSON.stringify(await evalExpression(second), null, 2));
    } else {
      console.log(JSON.stringify(await evalExpression(first), null, 2));
    }
    return;
  }

  if (args.command === "screenshot") {
    const [url] = args.positionals;
    requireArg(args.output, "missing --output PATH");
    if (url) {
      await openUrl(url);
    }
    const data = await screenshotData();
    await Bun.write(resolve(args.output), Buffer.from(data, "base64"));
    console.log(JSON.stringify({ ok: true, output: resolve(args.output) }, null, 2));
    return;
  }

  if (args.command === "open") {
    const [url] = args.positionals;
    requireArg(url, "missing URL");
    console.log(JSON.stringify(await openUrl(url), null, 2));
    return;
  }

  if (args.command === "back") {
    console.log(JSON.stringify(await back(), null, 2));
    return;
  }

  if (args.command === "forward") {
    console.log(JSON.stringify(await forward(), null, 2));
    return;
  }

  if (args.command === "reload") {
    console.log(JSON.stringify(await reload(), null, 2));
    return;
  }

  if (args.command === "stop-loading") {
    console.log(JSON.stringify(await stopLoading(), null, 2));
    return;
  }

  if (args.command === "click") {
    const [rawX, rawY] = args.positionals;
    const x = parseCoordinate(rawX, "missing x");
    const y = parseCoordinate(rawY, "missing y");
    console.log(JSON.stringify(await clickMouse(x, y), null, 2));
    return;
  }

  if (args.command === "wheel") {
    const [rawX, rawY, rawDeltaY, rawDeltaX] = args.positionals;
    const x = parseCoordinate(rawX, "missing x");
    const y = parseCoordinate(rawY, "missing y");
    const deltaY = parseSignedNumber(rawDeltaY, "missing deltaY");
    const deltaX = rawDeltaX === undefined ? 0 : parseSignedNumber(rawDeltaX, "missing deltaX");
    console.log(JSON.stringify(await wheelMouse(x, y, deltaY, deltaX), null, 2));
    return;
  }

  if (args.command === "text") {
    console.log(JSON.stringify(await pageText(), null, 2));
    return;
  }

  if (args.command === "console") {
    console.log(JSON.stringify(await consoleEntries(), null, 2));
    return;
  }

  if (args.command === "metrics") {
    console.log(JSON.stringify(await metrics(), null, 2));
    return;
  }

  if (args.command === "selector-click") {
    const [selector] = args.positionals;
    requireArg(selector, "missing selector");
    console.log(JSON.stringify(await selectorClick(selector), null, 2));
    return;
  }

  if (args.command === "type") {
    const [selector, ...textParts] = args.positionals;
    requireArg(selector, "missing selector");
    const text = textParts.join(" ");
    requireArg(text, "missing text");
    console.log(JSON.stringify(await selectorType(selector, text), null, 2));
    return;
  }

  if (args.command === "press") {
    const [first, second] = args.positionals;
    requireArg(first, "missing key or selector");
    const selector = second ? first : null;
    const key = second ?? first;
    console.log(JSON.stringify(await selectorPress(selector, key), null, 2));
    return;
  }

  if (args.command === "wait") {
    const [expression, rawTimeoutMs] = args.positionals;
    requireArg(expression, "missing expression");
    const timeoutMs = rawTimeoutMs === undefined ? 5_000 : parsePositiveInteger(rawTimeoutMs, "invalid timeout");
    console.log(JSON.stringify(await waitForExpression(expression, timeoutMs), null, 2));
    return;
  }

  if (args.command === "status") {
    console.log(JSON.stringify(await status(), null, 2));
    return;
  }

  if (args.command === "tabs") {
    const response = await status();
    console.log(JSON.stringify({ ok: true, tabs: response.tabs }, null, 2));
    return;
  }

  if (args.command === "switch-tab") {
    const [targetId] = args.positionals;
    requireArg(targetId, "missing targetId");
    console.log(JSON.stringify(await switchTab(targetId), null, 2));
    return;
  }

  if (args.command === "automation") {
    console.log(JSON.stringify(await automation(), null, 2));
    return;
  }

  if (args.command === "stop") {
    console.log(JSON.stringify({ ok: true, stopped: await stopDaemon() }, null, 2));
    return;
  }

  throw new Error(`unknown command: ${args.command}`);
}

async function resolveExistingView(requestedViewId?: string): Promise<string> {
  const response = await listViews();
  if (requestedViewId) {
    if (!response.views.some((view) => view.view_id === requestedViewId)) {
      throw new Error(`requested browser view is missing or closed: ${requestedViewId}`);
    }
    return requestedViewId;
  }
  if (response.views.length === 0) {
    throw new Error("no live browser views; run `herdr-browser inspect` to open one");
  }
  if (response.views.length > 1) {
    const summary = response.views.map((view) =>
      `${view.view_id} (${view.title || "untitled"}, ${view.url || "about:blank"})`,
    ).join(", ");
    throw new Error(`multiple live browser views; specify --view: ${summary}`);
  }
  return response.views[0]!.view_id;
}

async function inspectView(requestedViewId?: string) {
  const statePath = daemonStateFile();
  let viewId = requestedViewId;
  let views = (await listViews()).views;

  if (viewId) {
    if (!views.some((view) => view.view_id === viewId)) {
      throw new Error(`requested browser view is missing or closed: ${viewId} (state: ${statePath})`);
    }
  } else if (views.length > 1) {
    const summary = views.map((view) =>
      `${view.view_id} (${view.title || "untitled"}, ${view.url || "about:blank"})`,
    ).join(", ");
    throw new Error(`multiple live browser views; specify --view: ${summary}`);
  } else if (views.length === 1) {
    viewId = views[0]!.view_id;
  } else {
    // Create the daemon/view first, then open exactly one plugin-owned pane
    // against the same state path. The viewer heartbeat is the readiness gate.
    const created = await ensureView();
    viewId = created;
    views = (await listViews()).views;
  }

  const selectedViewId = requestedViewId ? null : await selectSoleView();
  if (selectedViewId) {
    viewId = selectedViewId;
  }
  const view = views.find((candidate) => candidate.view_id === viewId);
  if (!view?.pane_id) {
    const pane = openBrowserPane({ ...(await loadConfig()), focusOnOpen: true }, viewId, statePath);
    if (!pane.attempted) {
      throw new Error(`cannot open the Herdr browser viewer: ${pane.reason ?? "HERDR_BIN_PATH is not set"}`);
    }
    if (!pane.ok) {
      throw new Error(`failed to open the Herdr browser viewer: ${pane.stderr ?? pane.reason ?? "unknown error"}`);
    }
    await waitForViewHeartbeat(viewId);
  }

  return await automation(viewId);
}

async function withSession(callback: (session: Awaited<ReturnType<typeof createBrowserSession>>) => Promise<void>) {
  const session = await createBrowserSession();
  try {
    await callback(session);
  } finally {
    await session.close();
  }
}

function requireArg<T>(value: T | undefined, message: string): asserts value is T {
  if (value === undefined || value === "") {
    throw new Error(message);
  }
}

function printHelp() {
  console.log(`herdr-browser

Usage:
  herdr-browser smoke [url] [--output path]
  herdr-browser open <url>
  herdr-browser back
  herdr-browser forward
  herdr-browser reload
  herdr-browser stop-loading
  herdr-browser eval [url] <expression>
  herdr-browser click <x> <y>
  herdr-browser wheel <x> <y> <deltaY> [deltaX]
  herdr-browser selector-click <selector>
  herdr-browser type <selector> <text>
  herdr-browser press [selector] <key>
  herdr-browser wait <expression> [timeoutMs]
  herdr-browser text
  herdr-browser console
  herdr-browser metrics
  herdr-browser views
  herdr-browser inspect [--view <viewId>]
  herdr-browser connect [--view <viewId>]
  herdr-browser automation
  herdr-browser screenshot [url] --output path
  herdr-browser status
  herdr-browser tabs
  herdr-browser switch-tab <targetId>
  herdr-browser stop

Environment:
  HERDR_BROWSER_CHROME  Chrome/Chromium executable path
  HERDR_BROWSER_DISPLAY  headless (default) or headful (requires a graphical display)
  HERDR_BROWSER_DAEMON_STATE  daemon state file override
`);
}

function parseCoordinate(value: string | undefined, message: string): number {
  requireArg(value, message);
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`invalid coordinate: ${value}`);
  }
  const coordinate = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(coordinate)) {
    throw new Error(`invalid coordinate: ${value}`);
  }
  return coordinate;
}

function parseSignedNumber(value: string | undefined, message: string): number {
  requireArg(value, message);
  if (!/^-?[0-9]+(?:\.[0-9]+)?$/.test(value)) {
    throw new Error(`invalid number: ${value}`);
  }
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) {
    throw new Error(`invalid number: ${value}`);
  }
  return number;
}

function parsePositiveInteger(value: string | undefined, message: string): number {
  const number = parseCoordinate(value, message);
  if (number < 1) {
    throw new Error(`invalid positive integer: ${value}`);
  }
  return number;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

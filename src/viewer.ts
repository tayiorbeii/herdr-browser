#!/usr/bin/env bun

import { StringDecoder } from "node:string_decoder";

import {
  back,
  clickMouse,
  closeTab,
  closeView,
  createTab,
  createView,
  ensureView,
  forward,
  heartbeatView,
  isDaemonGoneError,
  metrics as daemonMetrics,
  moveMouse,
  openUrl,
  reload,
  screenshotData,
  sendKey,
  setViewport,
  startGraphicsStream,
  status,
  stopLoading,
  stopGraphicsStream,
  switchTab,
  wheelMouse,
} from "./daemonClient";
import { nextBrowserZoom, viewportGeometry } from "./browserZoom";
import { daemonStateDiagnostics } from "./paths";
import {
  configuredCaptureBackend,
  configuredCaptureScale,
  scaledCaptureSize,
  type ScreencastCaptureSize,
} from "./captureBackend";
import { configuredScreencastPollMs } from "./screencastPoll";
import {
  configuredGraphicsTransport,
  type GraphicsTransport,
} from "./graphicsTransport";
import {
  clearPaneGraphicsLayer,
  PaneGraphicsStream,
  paneGraphicsInfo,
  paneGraphicsTargetFromEnv,
  pngSizeFromBuffer,
  setPaneGraphicsLayer,
  type PaneGraphicsPlacement,
  type PaneGraphicsTarget,
} from "./herdrGraphics";
import { encodeKittyPng, terminalImageSize } from "./kitty";
import { parseSgrMouseInput, type MouseMove, type SgrMouseEvent, type TerminalKeyInput } from "./mouse";
import type { BrowserTabInfo, DaemonMetrics, DaemonStatus } from "./daemonProtocol";
import { loadConfig, saveBrowserZoom } from "./config";
import { WheelDispatcher } from "./wheelDispatcher";

const TOOLBAR_ROWS = 2;
const RESIZE_POLL_MS = 250;
const RESIZE_DEBOUNCE_MS = 150;
const MIN_RENDER_INTERVAL_MS = 50;
const STATUS_POLL_MS = 1_000;
const CELL_METRICS_TTL_MS = 1_000;
const HOVER_THROTTLE_MS = 40;
const FALLBACK_CELL_PIXELS = {
  width: 10,
  height: 20,
};
let cleanupStarted = false;
let alternateScreenActive = false;
let mouseReportingActive = false;

type TerminalSize = {
  columns: number;
  rows: number;
};

type RenderState = {
  size: TerminalSize;
  imageRows: number;
  viewport: ViewportMetrics;
  url: string;
  title: string;
  tabs: BrowserTabInfo[];
  toolbar: ToolbarLayout;
};

type RenderOptions = {
  clearScreen: boolean;
  deletePrevious: boolean;
  // Force a fresh status()/metrics() fetch instead of reusing the render
  // context's cached poll data. Only actions that can actually change
  // url/title/tabs (navigation, tab switches) or the first render need this;
  // most rerenders (keystrokes, hover, wheel) redraw with the last known data.
  refreshStatus?: boolean;
};

type RenderContext = {
  viewId: string;
  graphicsTransport: GraphicsTransport;
  browserZoom: number;
  showDiagnostics: boolean;
  stopInteractiveInput: (() => void) | null;
  appliedViewport: ViewportMetrics | null;
  cellMetrics: {
    size: TerminalSize;
    value: ConfiguredCellPixels | null;
    expiresAt: number;
  } | null;
  paneGraphics: {
    target: PaneGraphicsTarget;
    disabled: boolean;
    active: boolean;
    stream: PaneGraphicsStream | null;
    streamDisabled: boolean;
    directDisabled: boolean;
    transport: "daemon-stream" | "stream" | "api" | null;
    // Last placement/capture successfully POSTed to /graphics-stream while
    // active, so unchanged rerenders (e.g. every keystroke) can skip re-POSTing.
    lastStreamParams: {
      placement: PaneGraphicsPlacement;
      capture: ScreencastCaptureSize | null;
    } | null;
  } | null;
  // Latest status()/metrics() poll data, refreshed by the 1s status poll or
  // by a render that explicitly asks for fresh data (RenderOptions.refreshStatus).
  // Most rerenders reuse this instead of re-fetching from the daemon.
  latestStatus: DaemonStatus | null;
  latestMetrics: DaemonMetrics | null;
  // Set once the daemon or this view is confirmed gone (410 / no-daemon
  // error). Polling stops and the pane shows a fixed "session ended" screen
  // instead of silently retrying forever.
  sessionEnded: boolean;
  pollHandles: {
    heartbeat: ReturnType<typeof setInterval> | null;
    status: ReturnType<typeof setInterval> | null;
    screencast: ReturnType<typeof setInterval> | null;
  };
};

type UrlInputState = {
  focused: boolean;
  value: string;
  selectedAll: boolean;
};

type ToolbarAction =
  | { kind: "back" }
  | { kind: "forward" }
  | { kind: "reload" }
  | { kind: "stop" }
  | { kind: "zoom-in" }
  | { kind: "zoom-out" }
  | { kind: "new-tab" }
  | { kind: "close-tab"; targetId: string }
  | { kind: "focus-url" }
  | { kind: "switch-tab"; targetId: string };

type ToolbarLayout = {
  actions: Array<{
    row: number;
    startColumn: number;
    endColumn: number;
    action: ToolbarAction;
  }>;
  urlRow: number;
  urlStartColumn: number;
};

type ViewportMetrics = {
  width: number;
  height: number;
  rasterWidth: number;
  rasterHeight: number;
  browserZoom: number;
  source: "env-viewport" | "terminal-cell" | "herdr-cell" | "env-cell" | "fallback-cell";
  cellPixels: {
    width: number;
    height: number;
  } | null;
};

type ConfiguredCellPixels = {
  width: number;
  height: number;
  source: "herdr-cell" | "env-cell";
};

async function main() {
  const interactive = shouldWatchResize();
  if (interactive) {
    enterAlternateScreen();
    process.once("exit", cleanupTerminal);
  }
  const config = await loadConfig();
  const initialUrl = process.env.HERDR_BROWSER_INITIAL_URL?.trim() || undefined;
  const viewId = process.env.HERDR_BROWSER_VIEW_ID?.trim()
    ? await ensureView()
    : (await createView(initialUrl)).viewId;
  await heartbeatView(viewId, process.env.HERDR_PANE_ID?.trim() || undefined);
  const input: UrlInputState = {
    focused: false,
    value: "",
    selectedAll: false,
  };
  const paneGraphicsTarget = paneGraphicsTargetFromEnv();
  const renderContext: RenderContext = {
    viewId,
    graphicsTransport: configuredGraphicsTransport(),
    browserZoom: config.browserZoom,
    showDiagnostics: config.showDiagnostics,
    stopInteractiveInput: null,
    appliedViewport: null,
    cellMetrics: null,
    paneGraphics: paneGraphicsTarget
      ? {
        target: paneGraphicsTarget,
        disabled: false,
        active: false,
        stream: null,
        streamDisabled: false,
        directDisabled: false,
        transport: null,
        lastStreamParams: null,
      }
      : null,
    latestStatus: null,
    latestMetrics: null,
    sessionEnded: false,
    pollHandles: {
      heartbeat: null,
      status: null,
      screencast: null,
    },
  };
  const state = await renderOnce({
    clearScreen: true,
    deletePrevious: true,
    refreshStatus: true,
  }, input, renderContext);

  if (interactive) {
    await watchResize(state, input, renderContext);
    return;
  }

  if (shouldHold()) {
    await holdProcess();
  }
}

async function renderOnce(
  options: RenderOptions,
  input: UrlInputState,
  context: RenderContext,
): Promise<RenderState> {
  const size = terminalImageSize();
  const imageRows = pageRows(size.rows, context.showDiagnostics);
  const imageSize = {
    columns: size.columns,
    rows: imageRows,
  };
  const viewport = await terminalViewport(imageSize, context);
  if (!sameViewport(context.appliedViewport, viewport)) {
    await setViewport(viewport.width, viewport.height, viewport.browserZoom, 1);
    context.appliedViewport = viewport;
  }
  const info = options.refreshStatus || !context.latestStatus
    ? await refreshStatus(context)
    : context.latestStatus;
  const url = info.url || "about:blank";
  const metrics = options.refreshStatus
    ? await refreshMetrics(context)
    : context.latestMetrics;
  const toolbar = renderToolbar({
    columns: size.columns,
    url,
    input,
    tabs: info.tabs,
  });

  process.stdout.write(options.clearScreen ? "\x1b[2J\x1b[H" : "\x1b[H");
  process.stdout.write(toolbar.text);
  const renderedViaDirectStream = shouldWatchResize()
    ? await renderDaemonGraphicsStream(context, {
      columns: size.columns,
      rows: imageRows,
    }, scaledCaptureSize(viewport.rasterWidth, viewport.rasterHeight, configuredCaptureScale()))
    : false;
  let transport = "daemon-stream";
  if (!renderedViaDirectStream) {
    const png = await screenshotData();
    const renderedViaPaneGraphics = await renderPaneGraphics(context, png, {
      columns: size.columns,
      rows: imageRows,
    });
    transport = renderedViaPaneGraphics
      ? context.paneGraphics?.transport ?? "native"
      : "kitty-pty";
    if (!renderedViaPaneGraphics) {
      process.stdout.write(`\x1b[${TOOLBAR_ROWS + 1};1H`);
      process.stdout.write(encodeKittyPng(png, {
        columns: size.columns,
        rows: imageRows,
        deletePrevious: options.deletePrevious,
      }));
    }
  }
  writeDiagnosticsLine(context, size, renderStatusLine({
    title: info.title,
    url,
    viewport,
    columns: size.columns,
    imageRows,
    transport,
    metrics,
  }));

  return {
    size,
    imageRows,
    viewport,
    url,
    title: info.title,
    tabs: info.tabs,
    toolbar: toolbar.layout,
  };
}

async function renderDaemonGraphicsStream(
  context: RenderContext,
  imageSize: { columns: number; rows: number },
  capture: ScreencastCaptureSize | null,
): Promise<boolean> {
  if (context.graphicsTransport === "direct-kitty") {
    return false;
  }
  if (!context.paneGraphics || context.paneGraphics.disabled || context.paneGraphics.directDisabled) {
    return false;
  }
  const placement: PaneGraphicsPlacement = {
    viewportCol: 0,
    viewportRow: TOOLBAR_ROWS,
    gridCols: imageSize.columns,
    gridRows: imageSize.rows,
  };
  // Every rerender (including ones driven by a keystroke or hover move) calls
  // this; skip the POST when the stream is already active with the same
  // placement/capture instead of re-establishing it every time. The status
  // poll detects stream loss (metrics.graphics_stream.active === false) and
  // resets `active`/`directDisabled`, which forces the POST below again.
  if (
    context.paneGraphics.active &&
    context.paneGraphics.transport === "daemon-stream" &&
    sameStreamParams(context.paneGraphics.lastStreamParams, placement, capture)
  ) {
    return true;
  }
  try {
    await startGraphicsStream({
      target: context.paneGraphics.target,
      placement,
      capture,
    });
    context.paneGraphics.active = true;
    context.paneGraphics.transport = "daemon-stream";
    context.paneGraphics.lastStreamParams = { placement, capture };
    return true;
  } catch (error) {
    context.paneGraphics.directDisabled = true;
    context.paneGraphics.lastStreamParams = null;
    await stopGraphicsStream().catch(() => {});
    process.stderr.write(
      `daemon graphics stream disabled: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return false;
  }
}

export function sameStreamParams(
  last: { placement: PaneGraphicsPlacement; capture: ScreencastCaptureSize | null } | null,
  placement: PaneGraphicsPlacement,
  capture: ScreencastCaptureSize | null,
): boolean {
  if (!last) {
    return false;
  }
  return (
    last.placement.viewportCol === placement.viewportCol &&
    last.placement.viewportRow === placement.viewportRow &&
    last.placement.gridCols === placement.gridCols &&
    last.placement.gridRows === placement.gridRows &&
    sameCapture(last.capture, capture)
  );
}

function sameCapture(left: ScreencastCaptureSize | null, right: ScreencastCaptureSize | null): boolean {
  if (left === right) {
    return true;
  }
  return Boolean(left && right && left.maxWidth === right.maxWidth && left.maxHeight === right.maxHeight);
}

async function renderPaneGraphics(
  context: RenderContext,
  png: string,
  imageSize: { columns: number; rows: number },
): Promise<boolean> {
  if (context.graphicsTransport === "direct-kitty") {
    return false;
  }
  if (!context.paneGraphics) {
    return false;
  }
  if (context.paneGraphics.disabled) {
    await clearPaneGraphicsIfActive(context);
    return false;
  }
  const pngBuffer = Buffer.from(png, "base64");
  const image = pngSizeFromBuffer(pngBuffer);
  if (!image) {
    await clearPaneGraphicsIfActive(context);
    return false;
  }
  const frame = {
    png: pngBuffer,
    image,
    placement: {
      viewportCol: 0,
      viewportRow: TOOLBAR_ROWS,
      gridCols: imageSize.columns,
      gridRows: imageSize.rows,
    },
  };
  if (!context.paneGraphics.streamDisabled) {
    try {
      context.paneGraphics.stream ??= await PaneGraphicsStream.open({
        target: context.paneGraphics.target,
      });
      await context.paneGraphics.stream.sendFrame(frame);
      context.paneGraphics.active = true;
      context.paneGraphics.transport = "stream";
      return true;
    } catch (error) {
      context.paneGraphics.stream?.destroy();
      context.paneGraphics.stream = null;
      context.paneGraphics.streamDisabled = true;
      process.stderr.write(
        `pane graphics stream disabled: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  try {
    await setPaneGraphicsLayer({
      target: context.paneGraphics.target,
      pngBase64: png,
      image,
      placement: frame.placement,
    });
    context.paneGraphics.active = true;
    context.paneGraphics.transport = "api";
    return true;
  } catch (error) {
    await clearPaneGraphicsIfActive(context);
    context.paneGraphics.disabled = true;
    process.stderr.write(
      `pane graphics disabled: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return false;
  }
}

async function clearPaneGraphicsIfActive(context: RenderContext): Promise<void> {
  if (!context.paneGraphics?.active) {
    return;
  }
  const transport = context.paneGraphics.transport;
  context.paneGraphics.active = false;
  context.paneGraphics.transport = null;
  context.paneGraphics.lastStreamParams = null;
  context.paneGraphics.stream?.close();
  context.paneGraphics.stream = null;
  if (transport === "daemon-stream") {
    await stopGraphicsStream().catch(() => {});
  }
  try {
    await clearPaneGraphicsLayer({
      target: context.paneGraphics.target,
    });
  } catch {
    // Best-effort cleanup only; pane close or next render will clear stale state.
  }
}

async function watchResize(
  initial: RenderState,
  input: UrlInputState,
  context: RenderContext,
): Promise<never> {
  let current = initial;
  let rendering = false;
  let pendingRender: RenderOptions | null = null;
  let mouseInput = "";
  // Stateful across chunks: a multi-byte UTF-8 character (e.g. pasted or
  // typed non-ASCII text) can split across two stdin reads. A plain
  // chunk.toString("utf8") per chunk would decode the split halves as
  // separate (invalid) sequences and corrupt the character; StringDecoder
  // buffers a dangling partial sequence until the rest arrives.
  const stdinDecoder = new StringDecoder("utf8");
  let escapeTimer: ReturnType<typeof setTimeout> | null = null;
  let nativeSelectPopupOpen = false;
  let lastRenderAt = Date.now();
  enableMouseReporting();
  setupCleanup(context);
  const screencastPoll = shouldPollScreencast(context) ? startScreencastRenderPoll(() => {
    void rerender({
      clearScreen: false,
      deletePrevious: false,
    });
  }) : null;
  context.pollHandles.screencast = screencastPoll;
  if (screencastPoll) {
    process.once("exit", () => clearInterval(screencastPoll));
  }
  const statusPoll = setInterval(() => {
    void refreshStatusLine();
  }, STATUS_POLL_MS);
  context.pollHandles.status = statusPoll;
  process.once("exit", () => clearInterval(statusPoll));
  const hover = createHoverDispatcher((move) => moveMouse(move.x, move.y));
  const wheel = new WheelDispatcher(
    (event) => wheelMouse(event.x, event.y, event.deltaY, event.deltaX),
    {
      onError: (error) => {
        process.stderr.write(`mouse wheel failed: ${error instanceof Error ? error.message : String(error)}\n`);
      },
      afterDispatch: async () => {
        if (context.paneGraphics?.transport !== "daemon-stream") {
          await rerender({ clearScreen: false, deletePrevious: false });
        }
      },
    },
  );
  context.stopInteractiveInput = () => wheel.stop();
  process.once("exit", () => wheel.stop());
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on("data", (chunk) => {
    if (escapeTimer) {
      clearTimeout(escapeTimer);
      escapeTimer = null;
    }
    if (hasByte(chunk, 0x03)) {
      void cleanupAndExit(context, 130);
      return;
    }
    if (context.sessionEnded) {
      return;
    }
    if (input.focused && chunk.toString("utf8") === "\x1b") {
      mouseInput = "";
      input.focused = false;
      input.selectedAll = false;
      nativeSelectPopupOpen = false;
      void rerender({
        clearScreen: false,
        deletePrevious: false,
      });
      return;
    }
    const rawInput = mouseInput + stdinDecoder.write(chunk);
    const parsed = parseSgrMouseInput(rawInput, {
      columns: current.size.columns,
      rows: current.imageRows,
      rowOffset: TOOLBAR_ROWS,
      viewport: current.viewport,
    });
    mouseInput = parsed.remainder;
    if (mouseInput === "\x1b") {
      escapeTimer = setTimeout(() => {
        escapeTimer = null;
        mouseInput = "";
        void sendKey({ kind: "key", key: "Escape" })
          .then(() => rerender({ clearScreen: false, deletePrevious: false }))
          .catch((error) => {
            process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
          });
      }, 25);
      return;
    }
    const toolbarActions = toolbarActionsFromMouseEvents(parsed.mouseEvents, current.toolbar);
    if (
      toolbarActions.length === 0 &&
      parsed.clicks.length === 0 &&
      parsed.wheels.length === 0 &&
      parsed.moves.length === 0 &&
      parsed.keys.length === 0
    ) {
      return;
    }
    void dispatchInputs(toolbarActions, parsed).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    });
  });

  async function dispatchInputs(toolbarActions: ToolbarAction[], parsed: {
    clicks: Array<{ x: number; y: number }>;
    wheels: Array<{ x: number; y: number; deltaX: number; deltaY: number }>;
    moves: MouseMove[];
    keys: TerminalKeyInput[];
  }) {
    const hasWheels = parsed.wheels.length > 0;
    const blurredUrlInput = hasWheels && input.focused;
    if (hasWheels) {
      wheel.queue(parsed.wheels);
    }
    let rerenderNeeded = toolbarActions.length > 0 || blurredUrlInput;
    // Only actions that can actually change url/title/tabs (navigation, tab
    // switches) force a fresh status()/metrics() fetch on the resulting
    // render; everything else (page clicks, hover, wheel, zoom, typing)
    // reuses the last polled data.
    let statusChanged = false;
    if (toolbarActions.length > 0) {
      nativeSelectPopupOpen = false;
    }
    for (const action of toolbarActions) {
      const changed = await dispatchToolbarAction(action, input, current, context);
      statusChanged = statusChanged || changed;
    }

    if (!input.focused && parsed.moves.length > 0) {
      hover.queue(parsed.moves);
    }

    if (input.focused) {
      for (const key of parsed.keys) {
        const result = await handleUrlInputKey(key, input);
        rerenderNeeded = result.rerender || rerenderNeeded;
        statusChanged = statusChanged || result.navigated;
      }
      if (parsed.clicks.length > 0 || parsed.wheels.length > 0) {
        input.focused = false;
        input.selectedAll = false;
        rerenderNeeded = await dispatchPointerInputs(parsed) || rerenderNeeded;
      }
    } else {
      rerenderNeeded = await dispatchPointerInputs(parsed) || rerenderNeeded;
      for (const key of parsed.keys) {
        await sendKey(key);
        rerenderNeeded = true;
        if (
          nativeSelectPopupOpen &&
          key.kind === "key" &&
          (key.key === "Escape" || key.key === "Enter")
        ) {
          nativeSelectPopupOpen = false;
        }
      }
    }

    if (!rerenderNeeded) {
      return;
    }
    await rerender({
      clearScreen: false,
      deletePrevious: false,
      refreshStatus: statusChanged,
    });
  }

  async function rerender(options: RenderOptions) {
    if (context.sessionEnded) {
      return;
    }
    if (rendering) {
      pendingRender = mergeRenderOptions(pendingRender, options);
      return;
    }

    rendering = true;
    try {
      let nextOptions: RenderOptions | null = options;
      do {
        pendingRender = null;
        const renderDelayMs = Math.max(0, MIN_RENDER_INTERVAL_MS - (Date.now() - lastRenderAt));
        if (renderDelayMs > 0) {
          await sleep(renderDelayMs);
        }
        current = await renderOnce(nextOptions, input, context);
        lastRenderAt = Date.now();
        nextOptions = pendingRender;
      } while (nextOptions);
    } catch (error) {
      if (isDaemonGoneError(error)) {
        handleDaemonGone(context);
        return;
      }
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      rendering = false;
    }
  }

  async function refreshStatusLine() {
    if (rendering || context.sessionEnded) {
      return;
    }
    try {
      const info = await refreshStatus(context);
      const metrics = await refreshMetrics(context);
      if (
        context.paneGraphics?.transport === "daemon-stream" &&
        metrics &&
        !metrics.graphics_stream.active
      ) {
        context.paneGraphics.active = false;
        context.paneGraphics.transport = null;
        context.paneGraphics.directDisabled = false;
        await rerender({ clearScreen: false, deletePrevious: false });
        return;
      }
      if (info.url !== current.url || info.title !== current.title || !sameTabs(info.tabs, current.tabs)) {
        await rerender({
          clearScreen: false,
          deletePrevious: false,
        });
        return;
      }
      writeDiagnosticsLine(context, current.size, renderStatusLine({
        title: info.title,
        url: info.url,
        viewport: current.viewport,
        columns: current.size.columns,
        imageRows: current.imageRows,
        transport: context.paneGraphics?.transport ?? "none",
        metrics,
      }));
    } catch (error) {
      if (isDaemonGoneError(error)) {
        handleDaemonGone(context);
        return;
      }
      // Status refresh is diagnostic only; render/input errors are handled elsewhere.
    }
  }

  async function dispatchPointerInputs(input: {
    clicks: Array<{ x: number; y: number }>;
  }): Promise<boolean> {
    let dispatched = false;
    for (const click of input.clicks) {
      if (nativeSelectPopupOpen) {
        await clickMouse(click.x, click.y);
        nativeSelectPopupOpen = false;
        dispatched = true;
        continue;
      }

      // The daemon does the native-<select> hit test and the click in one
      // request/CDP turn instead of a separate probe request before the click.
      const result = await clickMouse(click.x, click.y, true);
      nativeSelectPopupOpen = result.nativeSelect;
      dispatched = true;
    }
    return dispatched;
  }

  while (true) {
    await sleep(RESIZE_POLL_MS);
    const nextSize = terminalImageSize();
    if (sameSize(current.size, nextSize)) {
      continue;
    }
    await waitForStableTerminalSize(nextSize);
    await rerender({
      clearScreen: true,
      deletePrevious: true,
    });
  }
}

// Returns whether the action can have changed url/title/tabs, so the caller
// knows whether the resulting render needs a fresh status()/metrics() fetch
// or can reuse the last polled data.
async function dispatchToolbarAction(
  action: ToolbarAction,
  input: UrlInputState,
  current: RenderState,
  context: RenderContext,
): Promise<boolean> {
  if (action.kind === "focus-url") {
    input.focused = true;
    input.value = current.url;
    input.selectedAll = true;
    return false;
  }

  input.focused = false;
  input.selectedAll = false;
  if (action.kind === "zoom-in" || action.kind === "zoom-out") {
    context.browserZoom = nextBrowserZoom(
      context.browserZoom,
      action.kind === "zoom-in" ? "in" : "out",
    );
    await saveBrowserZoom(context.browserZoom);
    return false;
  }
  try {
    if (action.kind === "back") {
      await back();
    } else if (action.kind === "forward") {
      await forward();
    } else if (action.kind === "reload") {
      await reload();
    } else if (action.kind === "stop") {
      await stopLoading();
    } else if (action.kind === "new-tab") {
      await createTab();
    } else if (action.kind === "close-tab") {
      await closeTab(action.targetId);
    } else {
      await switchTab(action.targetId);
    }
    return true;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return false;
  }
}

type UrlInputKeyResult = {
  rerender: boolean;
  // True when this key triggered navigation (Enter), so the caller knows the
  // resulting render needs a fresh status()/metrics() fetch instead of the
  // last polled data.
  navigated: boolean;
};

async function handleUrlInputKey(key: TerminalKeyInput, input: UrlInputState): Promise<UrlInputKeyResult> {
  if (key.kind === "text") {
    if (input.selectedAll) {
      input.value = "";
      input.selectedAll = false;
    }
    input.value += key.text;
    return { rerender: true, navigated: false };
  }

  if (key.key === "Backspace") {
    if (input.selectedAll) {
      input.value = "";
      input.selectedAll = false;
    } else {
      input.value = input.value.slice(0, -1);
    }
    return { rerender: true, navigated: false };
  }

  if (key.key === "Escape") {
    input.focused = false;
    input.selectedAll = false;
    return { rerender: true, navigated: false };
  }

  if (key.key === "Enter") {
    const url = normalizedUrl(input.value);
    input.focused = false;
    input.selectedAll = false;
    let navigated = false;
    if (url) {
      input.value = url;
      try {
        await openUrl(url);
        navigated = true;
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    return { rerender: true, navigated };
  }

  return { rerender: false, navigated: false };
}

function normalizedUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) || /^(about|data|blob|file):/i.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

export function toolbarActionsFromMouseEvents(events: SgrMouseEvent[], layout: ToolbarLayout): ToolbarAction[] {
  const actions: ToolbarAction[] = [];
  for (const event of events) {
    if (
      !event.released ||
      (event.button & 3) !== 0 ||
      (event.button & 64) === 64
    ) {
      continue;
    }
    const action = toolbarActionAt(event.row, event.column, layout);
    if (action) {
      actions.push(action);
    }
  }
  return actions;
}

function toolbarActionAt(row: number, column: number, layout: ToolbarLayout): ToolbarAction | null {
  const button = layout.actions.find((candidate) =>
    candidate.row === row && column >= candidate.startColumn && column <= candidate.endColumn
  );
  if (button) {
    return button.action;
  }
  return row === layout.urlRow && column >= layout.urlStartColumn
    ? { kind: "focus-url" }
    : null;
}

function mergeRenderOptions(
  left: RenderOptions | null,
  right: RenderOptions,
): RenderOptions {
  return {
    clearScreen: Boolean(left?.clearScreen || right.clearScreen),
    deletePrevious: Boolean(left?.deletePrevious || right.deletePrevious),
    refreshStatus: Boolean(left?.refreshStatus || right.refreshStatus),
  };
}

function hasByte(buffer: Buffer | string, byte: number): boolean {
  if (typeof buffer === "string") {
    return buffer.includes(String.fromCharCode(byte));
  }
  for (const value of buffer) {
    if (value === byte) {
      return true;
    }
  }
  return false;
}

function enableMouseReporting() {
  if (mouseReportingActive) {
    return;
  }
  mouseReportingActive = true;
  process.stdout.write("\x1b[?1000h\x1b[?1003h\x1b[?1006h");
}

function disableMouseReporting() {
  if (!mouseReportingActive) {
    return;
  }
  mouseReportingActive = false;
  process.stdout.write("\x1b[?1006l\x1b[?1003l\x1b[?1000l");
}

function enterAlternateScreen() {
  if (alternateScreenActive) {
    return;
  }
  alternateScreenActive = true;
  process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
}

function leaveAlternateScreen() {
  if (!alternateScreenActive) {
    return;
  }
  alternateScreenActive = false;
  process.stdout.write("\x1b[?1049l");
}

function cleanupTerminal() {
  disableMouseReporting();
  process.stdin.setRawMode?.(false);
  leaveAlternateScreen();
}

async function cleanupAndExit(context: RenderContext, code: number): Promise<never> {
  if (cleanupStarted) {
    return await new Promise(() => {});
  }
  cleanupStarted = true;
  context.stopInteractiveInput?.();
  cleanupTerminal();
  await clearPaneGraphicsIfActive(context);
  await closeView(context.viewId);
  process.exit(code);
}

function setupCleanup(context: RenderContext) {
  const heartbeat = setInterval(() => {
    void heartbeatView(
      context.viewId,
      process.env.HERDR_PANE_ID?.trim() || undefined,
    ).catch((error) => {
      // A dead daemon/view must not be silently retried forever: the
      // heartbeat would otherwise keep hitting ensureDaemon-style respawn
      // logic every 2s, spawning a new daemon + Chrome that immediately
      // idles out with no views and gets respawned again on the next tick.
      if (isDaemonGoneError(error)) {
        handleDaemonGone(context);
      }
    });
  }, 2_000);
  context.pollHandles.heartbeat = heartbeat;
  heartbeat.unref();
  process.once("exit", () => clearInterval(heartbeat));
  process.once("SIGHUP", () => {
    void cleanupAndExit(context, 129);
  });
  process.once("SIGINT", () => {
    void cleanupAndExit(context, 130);
  });
  process.once("SIGTERM", () => {
    void cleanupAndExit(context, 143);
  });
}

// Called once the daemon or this view is confirmed gone. Stops all polling
// (so nothing keeps hitting the dead daemon or triggers a respawn loop) and
// freezes the pane on a clear message instead of leaving stale content on
// screen or crashing. Ctrl+C still exits normally.
function handleDaemonGone(context: RenderContext): void {
  if (context.sessionEnded) {
    return;
  }
  context.sessionEnded = true;
  if (context.pollHandles.heartbeat) {
    clearInterval(context.pollHandles.heartbeat);
  }
  if (context.pollHandles.status) {
    clearInterval(context.pollHandles.status);
  }
  if (context.pollHandles.screencast) {
    clearInterval(context.pollHandles.screencast);
  }
  context.stopInteractiveInput?.();
  void clearPaneGraphicsIfActive(context).catch(() => {});
  renderSessionEndedScreen();
}

function renderSessionEndedScreen(): void {
  const size = terminalImageSize();
  const lines = [
    "Browser session ended.",
    "The herdr-browser daemon is no longer running.",
    `State: ${daemonStateDiagnostics().path}`,
    "Close this pane, or run `herdr-browser inspect` to start a new session.",
  ];
  process.stdout.write("\x1b[2J\x1b[H");
  lines.forEach((line, index) => {
    process.stdout.write(`\x1b[${TOOLBAR_ROWS + 1 + index};1H${statusText(line, size.columns)}\r`);
  });
}

function sameSize(
  left: TerminalSize,
  right: TerminalSize,
): boolean {
  return left.columns === right.columns && left.rows === right.rows;
}

function sameTabs(left: BrowserTabInfo[], right: BrowserTabInfo[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftTab = left[index];
    const rightTab = right[index];
    if (
      leftTab.targetId !== rightTab.targetId ||
      leftTab.title !== rightTab.title ||
      leftTab.url !== rightTab.url ||
      leftTab.active !== rightTab.active
    ) {
      return false;
    }
  }
  return true;
}

async function waitForStableTerminalSize(initial: TerminalSize): Promise<TerminalSize> {
  let previous = initial;
  while (true) {
    await sleep(RESIZE_DEBOUNCE_MS);
    const next = terminalImageSize();
    if (sameSize(previous, next)) {
      return next;
    }
    previous = next;
  }
}

function sameViewport(
  left: ViewportMetrics | null,
  right: ViewportMetrics,
): boolean {
  return Boolean(
    left &&
    left.width === right.width &&
    left.height === right.height &&
    left.rasterWidth === right.rasterWidth &&
    left.rasterHeight === right.rasterHeight &&
    left.browserZoom === right.browserZoom,
  );
}

function startScreencastRenderPoll(render: () => void): ReturnType<typeof setInterval> | null {
  if (configuredCaptureBackend() !== "screencast") {
    return null;
  }
  return setInterval(render, configuredScreencastPollMs());
}

function createHoverDispatcher(
  dispatch: (move: MouseMove) => Promise<unknown>,
): {
  queue: (moves: MouseMove[]) => void;
} {
  let lastCell: { column: number; row: number } | null = null;
  let pending: MouseMove | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let lastSentAt = 0;

  function queue(moves: MouseMove[]) {
    const latest = moves[moves.length - 1];
    if (!latest || sameMouseCell(latest, lastCell)) {
      return;
    }
    pending = latest;
    schedule();
  }

  function schedule() {
    if (timer) {
      return;
    }
    const delay = Math.max(0, HOVER_THROTTLE_MS - (Date.now() - lastSentAt));
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delay);
  }

  async function flush() {
    if (inFlight || !pending) {
      return;
    }
    const move = pending;
    pending = null;
    inFlight = true;
    try {
      await dispatch(move);
      lastCell = {
        column: move.column,
        row: move.row,
      };
      lastSentAt = Date.now();
    } catch (error) {
      process.stderr.write(`mouse move failed: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      inFlight = false;
      if (pending) {
        schedule();
      }
    }
  }

  return { queue };
}

function sameMouseCell(
  move: MouseMove,
  cell: { column: number; row: number } | null,
): boolean {
  return Boolean(cell && move.column === cell.column && move.row === cell.row);
}

async function safeDaemonMetrics(): Promise<DaemonMetrics | null> {
  try {
    return await daemonMetrics();
  } catch {
    return null;
  }
}

async function refreshStatus(context: RenderContext): Promise<DaemonStatus> {
  const info = await status();
  context.latestStatus = info;
  return info;
}

async function refreshMetrics(context: RenderContext): Promise<DaemonMetrics | null> {
  const value = await safeDaemonMetrics();
  context.latestMetrics = value;
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminalViewport(
  size: { columns: number; rows: number },
  context: RenderContext,
): Promise<ViewportMetrics> {
  const pixelWidth = Number.parseInt(process.env.HERDR_BROWSER_VIEWPORT_WIDTH ?? "", 10);
  const pixelHeight = Number.parseInt(process.env.HERDR_BROWSER_VIEWPORT_HEIGHT ?? "", 10);

  if (Number.isFinite(pixelWidth) && pixelWidth > 0 && Number.isFinite(pixelHeight) && pixelHeight > 0) {
    return {
      ...viewportGeometry(
        pixelWidth,
        pixelHeight,
        context.browserZoom,
      ),
      source: "env-viewport",
      cellPixels: null,
    };
  }

  const configuredCell = await configuredCellPixels(context, size);
  if (configuredCell) {
    return {
      ...viewportGeometry(
        size.columns * configuredCell.width,
        size.rows * configuredCell.height,
        context.browserZoom,
      ),
      source: configuredCell.source,
      cellPixels: {
        width: configuredCell.width,
        height: configuredCell.height,
      },
    };
  }

  const cellPixels = await queryTerminalCellPixelSize();
  if (cellPixels) {
    return {
      ...viewportGeometry(
        size.columns * cellPixels.width,
        size.rows * cellPixels.height,
        context.browserZoom,
      ),
      source: "terminal-cell",
      cellPixels,
    };
  }

  return {
    ...viewportGeometry(
      size.columns * FALLBACK_CELL_PIXELS.width,
      size.rows * FALLBACK_CELL_PIXELS.height,
      context.browserZoom,
    ),
    source: "fallback-cell",
    cellPixels: {
      width: FALLBACK_CELL_PIXELS.width,
      height: FALLBACK_CELL_PIXELS.height,
    },
  };
}

async function queryTerminalCellPixelSize(): Promise<{ width: number; height: number } | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return null;
  }

  const stdin = process.stdin;
  const setRawMode = stdin.setRawMode?.bind(stdin);
  let previousRawMode = false;
  try {
    previousRawMode = stdin.isRaw;
    setRawMode?.(true);
    stdin.resume();
    process.stdout.write("\x1b[16t");

    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, 80);

      function onData(chunk: Buffer) {
        const match = chunk.toString("utf8").match(/\x1b\[6;([0-9]+);([0-9]+)t/);
        if (!match) {
          return;
        }
        cleanup();
        resolve({
          height: Number.parseInt(match[1], 10),
          width: Number.parseInt(match[2], 10),
        });
      }

      function cleanup() {
        clearTimeout(timer);
        stdin.off("data", onData);
        setRawMode?.(previousRawMode);
        if (!previousRawMode) {
          stdin.pause();
        }
      }

      stdin.on("data", onData);
    });
  } catch {
    setRawMode?.(previousRawMode);
    return null;
  }
}

async function configuredCellPixels(
  context: RenderContext,
  size: TerminalSize,
): Promise<ConfiguredCellPixels | null> {
  const now = Date.now();
  if (
    context.cellMetrics &&
    context.cellMetrics.size.columns === size.columns &&
    context.cellMetrics.size.rows === size.rows &&
    context.cellMetrics.expiresAt > now
  ) {
    return context.cellMetrics.value;
  }

  const value = await loadConfiguredCellPixels();
  context.cellMetrics = {
    size: { ...size },
    value,
    expiresAt: Date.now() + CELL_METRICS_TTL_MS,
  };
  return value;
}

async function loadConfiguredCellPixels(): Promise<ConfiguredCellPixels | null> {
  const target = paneGraphicsTargetFromEnv();
  if (target) {
    try {
      const info = await paneGraphicsInfo({ target });
      return {
        width: info.cellWidthPx,
        height: info.cellHeightPx,
        source: "herdr-cell",
      };
    } catch {
      // Older Herdr versions fall through to explicit configuration or terminal probing.
    }
  }

  const herdrWidth = Number.parseInt(process.env.HERDR_CELL_WIDTH_PX ?? "", 10);
  const herdrHeight = Number.parseInt(process.env.HERDR_CELL_HEIGHT_PX ?? "", 10);
  if (
    Number.isFinite(herdrWidth) &&
    herdrWidth > 0 &&
    Number.isFinite(herdrHeight) &&
    herdrHeight > 0
  ) {
    return {
      width: herdrWidth,
      height: herdrHeight,
      source: "herdr-cell",
    };
  }

  const width = Number.parseInt(process.env.HERDR_BROWSER_CELL_WIDTH ?? "", 10);
  const height = Number.parseInt(process.env.HERDR_BROWSER_CELL_HEIGHT ?? "", 10);
  const hasWidth = Number.isFinite(width) && width > 0;
  const hasHeight = Number.isFinite(height) && height > 0;
  if (hasWidth || hasHeight) {
    return {
      width: hasWidth ? width : FALLBACK_CELL_PIXELS.width,
      height: hasHeight ? height : FALLBACK_CELL_PIXELS.height,
      source: "env-cell",
    };
  }
  return null;
}

function statusText(value: string, maxColumns: number): string {
  const sanitized = value.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").trim();
  const width = Math.max(0, maxColumns);
  if (sanitized.length <= width) {
    return sanitized.padEnd(width, " ");
  }
  return sanitized.slice(0, Math.max(0, width - 1)).padEnd(width, " ");
}

function writeDiagnosticsLine(
  context: RenderContext,
  size: TerminalSize,
  value: string,
): void {
  if (!context.showDiagnostics) {
    return;
  }
  process.stdout.write(`\x1b[${size.rows};1H${statusText(value, size.columns)}\r`);
}

export function renderToolbar(options: {
  columns: number;
  url: string;
  input: UrlInputState;
  tabs: BrowserTabInfo[];
}): {
  text: string;
  layout: ToolbarLayout;
} {
  const tabParts: string[] = [];
  const controlParts: string[] = [];
  const actions: ToolbarLayout["actions"] = [];
  let tabColumn = 1;
  let controlColumn = 1;

  const addButton = (
    row: number,
    parts: string[],
    label: string,
    action: ToolbarAction,
  ) => {
    let column = row === 1 ? tabColumn : controlColumn;
    if (column > 1) {
      parts.push(" ");
      column += 1;
    }
    const startColumn = column;
    parts.push(label);
    column += label.length;
    actions.push({
      row,
      startColumn,
      endColumn: column - 1,
      action,
    });
    if (row === 1) {
      tabColumn = column;
    } else {
      controlColumn = column;
    }
  };

  const newTabWidth = 4;
  const maxTabEnd = Math.max(1, options.columns - newTabWidth);
  const range = visibleTabRange(options.tabs, maxTabEnd);
  if (range.start > 0) {
    tabParts.push("[..]");
    tabColumn += 4;
  }
  for (let index = range.start; index <= range.end; index += 1) {
    const tab = options.tabs[index];
    const label = tabButtonLabel(tab, index);
    const closeLabel = "[x]";
    addButton(1, tabParts, label, { kind: "switch-tab", targetId: tab.targetId });
    const closeStart = tabColumn;
    tabParts.push(closeLabel);
    tabColumn += closeLabel.length;
    actions.push({
      row: 1,
      startColumn: closeStart,
      endColumn: tabColumn - 1,
      action: { kind: "close-tab", targetId: tab.targetId },
    });
  }
  if (range.end < options.tabs.length - 1) {
    if (tabColumn > 1) {
      tabParts.push(" ");
      tabColumn += 1;
    }
    tabParts.push("[..]");
    tabColumn += 4;
  }
  addButton(1, tabParts, "[+]", { kind: "new-tab" });

  addButton(2, controlParts, "[<]", { kind: "back" });
  addButton(2, controlParts, "[>]", { kind: "forward" });
  addButton(2, controlParts, "[R]", { kind: "reload" });
  addButton(2, controlParts, "[Stop]", { kind: "stop" });
  addButton(2, controlParts, "[-]", { kind: "zoom-out" });
  addButton(2, controlParts, "[+]", { kind: "zoom-in" });

  controlParts.push(" ");
  controlColumn += 1;
  const urlStartColumn = controlColumn;
  const value = options.input.focused
    ? `${options.input.value}${options.input.selectedAll ? " <all>" : "_"}`
    : options.url;
  return {
    text: `${statusText(tabParts.join(""), options.columns)}\r\n${statusText(`${controlParts.join("")}${value}`, options.columns)}`,
    layout: {
      actions,
      urlRow: 2,
      urlStartColumn,
    },
  };
}

function visibleTabRange(tabs: BrowserTabInfo[], maxWidth: number): {
  start: number;
  end: number;
} {
  if (tabs.length === 0) {
    return { start: 0, end: -1 };
  }
  const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.active));
  let best = { start: activeIndex, end: activeIndex, count: 1 };
  for (let start = 0; start <= activeIndex; start += 1) {
    for (let end = activeIndex; end < tabs.length; end += 1) {
      if (tabRangeWidth(tabs, start, end) > maxWidth) {
        break;
      }
      const count = end - start + 1;
      if (count > best.count || (count === best.count && start < best.start)) {
        best = { start, end, count };
      }
    }
  }
  return { start: best.start, end: best.end };
}

function tabRangeWidth(tabs: BrowserTabInfo[], start: number, end: number): number {
  let width = start > 0 ? 4 : 0;
  for (let index = start; index <= end; index += 1) {
    if (width > 0) {
      width += 1;
    }
    width += tabButtonLabel(tabs[index], index).length + 3;
  }
  if (end < tabs.length - 1) {
    width += (width > 0 ? 1 : 0) + 4;
  }
  return width;
}

export function pageRows(totalRows: number, showDiagnostics: boolean): number {
  return Math.max(1, totalRows - TOOLBAR_ROWS - (showDiagnostics ? 1 : 0));
}

function tabButtonLabel(tab: BrowserTabInfo, index: number): string {
  const marker = tab.active ? "*" : "";
  const rawLabel = tab.title || tab.url || "blank";
  const label = compactText(rawLabel, 14);
  return `[${index + 1}${marker} ${label}]`;
}

function compactText(value: string, maxLength: number): string {
  const sanitized = value.replace(/[\x00-\x1f\x7f-\x9f\[\]]+/g, " ").trim();
  if (sanitized.length <= maxLength) {
    return sanitized;
  }
  if (maxLength <= 1) {
    return sanitized.slice(0, maxLength);
  }
  return `${sanitized.slice(0, maxLength - 1)}.`;
}

function renderStatusLine(options: {
  title: string;
  url: string;
  viewport: ViewportMetrics;
  columns: number;
  imageRows: number;
  transport: string;
  metrics?: DaemonMetrics | null;
}): string {
  const label = options.title || options.url || "about:blank";
  const cell = options.viewport.cellPixels
    ? ` cell=${options.viewport.cellPixels.width}x${options.viewport.cellPixels.height}`
    : "";
  const stream = options.metrics
    ? ` fps=${streamFps(options.metrics)} sent=${options.metrics.graphics_stream.frames_sent}/${options.metrics.graphics_stream.frames_received} drop=${options.metrics.graphics_stream.frames_dropped} coal=${options.metrics.graphics_stream.frames_coalesced} write=${options.metrics.graphics_stream.last_write_ms}ms bytes=${formatBytes(options.metrics.graphics_stream.last_bytes)}`
    : "";
  const error = options.metrics?.graphics_stream.last_error
    ? ` error=${options.metrics.graphics_stream.last_error}`
    : "";
  return `transport=${options.transport}${stream}${error} viewport=${options.viewport.width}x${options.viewport.height} raster=${options.viewport.rasterWidth}x${options.viewport.rasterHeight} zoom=${Math.round(options.viewport.browserZoom * 100)}% cells=${options.columns}x${options.imageRows} source=${options.viewport.source}${cell} | ${label}`;
}

function streamFps(metrics: DaemonMetrics): string {
  const startedAt = metrics.graphics_stream.started_at
    ? Date.parse(metrics.graphics_stream.started_at)
    : NaN;
  if (!Number.isFinite(startedAt)) {
    return "0";
  }
  const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
  return (metrics.graphics_stream.frames_sent / elapsedSeconds).toFixed(1);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)}KB`;
  }
  return `${bytes}B`;
}

function shouldHold(): boolean {
  return process.env.HERDR_BROWSER_VIEWER_HOLD === "1";
}

function shouldWatchResize(): boolean {
  return (
    process.env.HERDR_BROWSER_VIEWER_WATCH_RESIZE === "1" ||
    process.env.HERDR_PLUGIN_ENTRYPOINT_ID === "browser"
  );
}

function legacyRenderPollEnabled(): boolean {
  return process.env.HERDR_BROWSER_LEGACY_RENDER === "1";
}

function shouldPollScreencast(context: RenderContext): boolean {
  return context.graphicsTransport === "direct-kitty" || legacyRenderPollEnabled();
}

async function holdProcess(): Promise<never> {
  return await new Promise(() => {
    setInterval(() => {}, 60_000);
  });
}

if (import.meta.main) {
  main().catch((error) => {
    cleanupTerminal();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

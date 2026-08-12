import { access, open, readFile, rm, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";

import {
  daemonScriptPath,
  daemonStateFile,
  daemonStateDiagnostics,
  chromeProfileDir,
  ensurePrivateParentDir,
} from "./paths";
import { DEFAULT_CAPTURE_BACKEND, configuredCaptureBackend } from "./captureBackend";
import {
  DEFAULT_SCREENCAST_EVERY_NTH_FRAME,
  configuredScreencastEveryNthFrame,
} from "./screencastCadence";
import type {
  AutomationResponse,
  BrowserViewResponse,
  BrowserViewListResponse,
  BrowserViewSelectionResponse,
  DaemonHealth,
  DaemonState,
  DaemonStatus,
  DaemonMetrics,
  ErrorResponse,
  EvalResponse,
  ConsoleResponse,
  GraphicsStreamRequest,
  GraphicsStreamResponse,
  KeyResponse,
  MouseMoveResponse,
  MouseResponse,
  NativeSelectAtPointResponse,
  NavigationResponse,
  OpenResponse,
  PageTextResponse,
  SelectorClickResponse,
  SelectorPressResponse,
  SelectorTypeResponse,
  ScreenshotResponse,
  TabResponse,
  ViewportResponse,
  WaitResponse,
  WheelResponse,
} from "./daemonProtocol";
import type { BrowserKeyboardInput } from "./browser";
import { applyBrowserConfigEnv, loadConfig } from "./config";
import { reapStaleChrome } from "./staleChrome";

const DAEMON_REQUEST_TIMEOUT_MS = 10_000;
let defaultViewId: string | null = process.env.HERDR_BROWSER_VIEW_ID?.trim() || null;
let browserConfigApplied: Promise<void> | null = null;

function selectView(viewId: string): void {
  defaultViewId = viewId;
}

export async function createView(initialUrl?: string): Promise<BrowserViewResponse> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const state = await ensureDaemon();
    try {
      const response = await request<BrowserViewResponse>(state, "POST", "/views", {
        initialUrl,
      });
      selectView(response.viewId);
      return response;
    } catch (error) {
      if (attempt === 1 || !isRetiringDaemonError(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("failed to create browser view");
}

export async function ensureView(initialUrl?: string): Promise<string> {
  if (defaultViewId) {
    try {
      await heartbeatView(defaultViewId);
      return defaultViewId;
    } catch {
      defaultViewId = null;
    }
  }
  const state = await ensureDaemon();
  const selection = await request<BrowserViewSelectionResponse>(
    state,
    "GET",
    "/views/select",
    undefined,
    DAEMON_REQUEST_TIMEOUT_MS,
    null,
  );
  if (selection.viewId) {
    selectView(selection.viewId);
    return selection.viewId;
  }
  return (await createView(initialUrl)).viewId;
}

export async function heartbeatView(viewId: string, paneId?: string): Promise<void> {
  const state = await requireRunningDaemon();
  await request(
    state,
    "POST",
    "/views/heartbeat",
    paneId ? { paneId } : {},
    DAEMON_REQUEST_TIMEOUT_MS,
    viewId,
  );
}

export async function waitForViewHeartbeat(
  viewId: string,
  timeoutMs = DAEMON_REQUEST_TIMEOUT_MS,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await listViews();
    const view = response.views.find((candidate) => candidate.view_id === viewId);
    if (view?.pane_id) {
      selectView(viewId);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for viewer heartbeat for view ${viewId}; state: ${daemonStateFile()}`);
}

export async function selectSoleView(): Promise<string | null> {
  const state = await requireRunningDaemon();
  const selection = await request<BrowserViewSelectionResponse>(
    state,
    "GET",
    "/views/select",
    undefined,
    DAEMON_REQUEST_TIMEOUT_MS,
    null,
  );
  if (selection.viewId) {
    selectView(selection.viewId);
  }
  return selection.viewId;
}

export async function listViews(): Promise<BrowserViewListResponse> {
  const state = await readDaemonState();
  if (!state || !await isAlive(state)) {
    return { ok: true, views: [] };
  }
  return await request<BrowserViewListResponse>(
    state,
    "GET",
    "/views",
    undefined,
    DAEMON_REQUEST_TIMEOUT_MS,
    null,
  );
}

export async function closeView(viewId: string): Promise<void> {
  const state = await readDaemonState();
  if (!state) {
    return;
  }
  await request(state, "POST", "/views/close", undefined, DAEMON_REQUEST_TIMEOUT_MS, viewId).catch(() => {});
  if (defaultViewId === viewId) {
    defaultViewId = null;
  }
}

export async function status(): Promise<DaemonStatus> {
  const state = await requireRunningDaemon();
  return await request<DaemonStatus>(state, "GET", "/status");
}

export async function health(): Promise<DaemonHealth> {
  const state = await ensureDaemon();
  return await request<DaemonHealth>(state, "GET", "/health", undefined, DAEMON_REQUEST_TIMEOUT_MS, null);
}

export async function switchTab(targetId: string): Promise<TabResponse> {
  const state = await ensureDaemon();
  return await request<TabResponse>(state, "POST", "/tabs/switch", { targetId });
}

export async function createTab(): Promise<TabResponse> {
  const state = await ensureDaemon();
  return await request<TabResponse>(state, "POST", "/tabs");
}

export async function closeTab(targetId: string): Promise<TabResponse> {
  const state = await ensureDaemon();
  return await request<TabResponse>(state, "POST", "/tabs/close", { targetId });
}

export async function automation(viewId = defaultViewId): Promise<AutomationResponse> {
  if (!viewId) {
    throw new Error("browser view is required");
  }
  const state = await requireRunningDaemon();
  return await request<AutomationResponse>(
    state,
    "GET",
    "/automation",
    undefined,
    DAEMON_REQUEST_TIMEOUT_MS,
    viewId,
  );
}

export async function openUrl(url: string): Promise<OpenResponse> {
  const state = await ensureDaemon();
  return await request<OpenResponse>(state, "POST", "/open", { url });
}

export async function back(): Promise<NavigationResponse> {
  const state = await ensureDaemon();
  return await request<NavigationResponse>(state, "POST", "/back");
}

export async function forward(): Promise<NavigationResponse> {
  const state = await ensureDaemon();
  return await request<NavigationResponse>(state, "POST", "/forward");
}

export async function reload(): Promise<NavigationResponse> {
  const state = await ensureDaemon();
  return await request<NavigationResponse>(state, "POST", "/reload");
}

export async function stopLoading(): Promise<NavigationResponse> {
  const state = await ensureDaemon();
  return await request<NavigationResponse>(state, "POST", "/stop-loading");
}

export async function evalExpression(expression: string): Promise<EvalResponse> {
  const state = await ensureDaemon();
  return await request<EvalResponse>(state, "POST", "/eval", { expression });
}

export async function screenshotData(): Promise<string> {
  const state = await ensureDaemon();
  const response = await request<ScreenshotResponse>(state, "POST", "/screenshot");
  return response.data;
}

export async function setViewport(
  width: number,
  height: number,
  deviceScaleFactor?: number,
  pageScaleFactor?: number,
): Promise<ViewportResponse> {
  const state = await ensureDaemon();
  return await request<ViewportResponse>(state, "POST", "/viewport", {
    width,
    height,
    deviceScaleFactor,
    pageScaleFactor,
  });
}

export async function startGraphicsStream(
  options: GraphicsStreamRequest,
): Promise<GraphicsStreamResponse> {
  const state = await ensureDaemon();
  return await request<GraphicsStreamResponse>(state, "POST", "/graphics-stream", options);
}

export async function stopGraphicsStream(): Promise<GraphicsStreamResponse> {
  const state = await ensureDaemon();
  return await request<GraphicsStreamResponse>(state, "POST", "/graphics-stream/stop");
}

export async function clickMouse(
  x: number,
  y: number,
  probeNativeSelect = false,
): Promise<MouseResponse> {
  const state = await ensureDaemon();
  return await request<MouseResponse>(state, "POST", "/mouse", { x, y, probeNativeSelect });
}

export async function moveMouse(x: number, y: number): Promise<MouseMoveResponse> {
  const state = await ensureDaemon();
  return await request<MouseMoveResponse>(state, "POST", "/mouse-move", { x, y });
}

export async function nativeSelectAtPoint(x: number, y: number): Promise<NativeSelectAtPointResponse> {
  const state = await ensureDaemon();
  return await request<NativeSelectAtPointResponse>(state, "POST", "/native-select-at", { x, y });
}

export async function wheelMouse(
  x: number,
  y: number,
  deltaY: number,
  deltaX = 0,
): Promise<WheelResponse> {
  const state = await ensureDaemon();
  return await request<WheelResponse>(state, "POST", "/wheel", {
    x,
    y,
    deltaX,
    deltaY,
  });
}

export async function sendKey(input: BrowserKeyboardInput): Promise<KeyResponse> {
  const state = await ensureDaemon();
  return await request<KeyResponse>(state, "POST", "/key", input);
}

export async function pageText(): Promise<PageTextResponse> {
  const state = await ensureDaemon();
  return await request<PageTextResponse>(state, "GET", "/text");
}

export async function consoleEntries(): Promise<ConsoleResponse> {
  const state = await ensureDaemon();
  return await request<ConsoleResponse>(state, "GET", "/console");
}

export async function metrics(): Promise<DaemonMetrics> {
  const state = await requireRunningDaemon();
  return await request<DaemonMetrics>(state, "GET", "/metrics");
}

export async function selectorClick(selector: string): Promise<SelectorClickResponse> {
  const state = await ensureDaemon();
  return await request<SelectorClickResponse>(state, "POST", "/selector-click", {
    selector,
  });
}

export async function selectorType(
  selector: string,
  text: string,
): Promise<SelectorTypeResponse> {
  const state = await ensureDaemon();
  return await request<SelectorTypeResponse>(state, "POST", "/type", {
    selector,
    text,
  });
}

export async function selectorPress(
  selector: string | null,
  key: string,
): Promise<SelectorPressResponse> {
  const state = await ensureDaemon();
  return await request<SelectorPressResponse>(state, "POST", "/press", {
    selector,
    key,
  });
}

export async function waitForExpression(
  expression: string,
  timeoutMs: number,
): Promise<WaitResponse> {
  const state = await ensureDaemon();
  return await request<WaitResponse>(state, "POST", "/wait", {
    expression,
    timeout_ms: timeoutMs,
  }, timeoutMs + 1_000);
}

export async function stopDaemon(): Promise<boolean> {
  const state = await readDaemonState();
  if (!state) {
    return false;
  }
  await shutdownDaemonState(state);
  return true;
}

async function ensureDaemon(): Promise<DaemonState> {
  await ensureBrowserConfigApplied();
  const existing = await readDaemonState();
  if (existing && await canReuseDaemon(existing)) {
    return existing;
  }

  return await withStartLock(async () => {
    const lockedExisting = await readDaemonState();
    if (lockedExisting && await canReuseDaemon(lockedExisting)) {
      return lockedExisting;
    }
    if (lockedExisting && await isAlive(lockedExisting)) {
      await shutdownDaemonState(lockedExisting);
    } else if (lockedExisting) {
      await waitForProcessExit(lockedExisting.pid, 2_000);
    }

    // The state file is the only record of a crashed daemon's Chrome pid.
    // Reap that Chrome before deleting the file, or the orphan keeps holding
    // the profile SingletonLock and the replacement daemon fails to launch.
    await reapStaleChrome(daemonStateFile());
    await rm(daemonStateFile(), { force: true });
    await startDaemonProcess();
    return await waitForDaemon();
  });
}

async function ensureBrowserConfigApplied(): Promise<void> {
  browserConfigApplied ??= loadConfig().then((config) => {
    applyBrowserConfigEnv(config);
  });
  await browserConfigApplied;
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startDaemonProcess(): Promise<void> {
  const stateFile = daemonStateFile();
  await ensurePrivateParentDir(stateFile);

  const child = spawn(process.execPath, [
    daemonScriptPath(),
    "--state-file",
    stateFile,
  ], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      HERDR_BROWSER_DAEMON_STATE: stateFile,
    },
  });
  child.unref();
}

async function waitForDaemon(): Promise<DaemonState> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const state = await readDaemonState();
    if (state && await isAlive(state)) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for daemon state at ${daemonStateFile()}`);
}

async function withStartLock(callback: () => Promise<DaemonState>): Promise<DaemonState> {
  const lockFile = `${daemonStateFile()}.lock`;
  await ensurePrivateParentDir(lockFile);
  const started = Date.now();

  while (Date.now() - started < 10_000) {
    try {
      const handle = await open(lockFile, "wx", 0o600);
      try {
        await handle.writeFile(String(process.pid));
        return await callback();
      } finally {
        await handle.close();
        await unlink(lockFile).catch(() => {});
      }
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }

      const existing = await readDaemonState();
      if (existing && await canReuseDaemon(existing)) {
        return existing;
      }

      if (await removeStaleLock(lockFile)) {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error(`timed out waiting for daemon startup lock at ${lockFile}`);
}

// A lock file survives its owner's death (crash, kill -9) with no chance to
// clean up after itself. Only remove it once we can prove the pid it names is
// dead; a lock whose owner is still alive is left alone so we keep waiting.
export async function removeStaleLock(lockFile: string): Promise<boolean> {
  let pidText: string;
  try {
    pidText = await readFile(lockFile, "utf8");
  } catch {
    return false;
  }
  const pid = Number.parseInt(pidText.trim(), 10);
  if (!Number.isInteger(pid) || isProcessAlive(pid)) {
    return false;
  }
  await unlink(lockFile).catch(() => {});
  return true;
}

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

async function isAlive(state: DaemonState): Promise<boolean> {
  try {
    await request<DaemonHealth>(state, "GET", "/health");
    return true;
  } catch {
    return false;
  }
}

// Callers that must not resurrect a stopped daemon (heartbeats, status polls,
// metrics) use this instead of ensureDaemon: it reads the last known state
// and fails cleanly rather than spawning a new daemon + Chrome.
async function requireRunningDaemon(): Promise<DaemonState> {
  const state = await readDaemonState();
  if (!state || !await isAlive(state)) {
    const diagnostics = daemonStateDiagnostics();
    const stateIssue = state ? "health check failed" :
      await hasStateFile(diagnostics.path) ? "state file is invalid" : "state file is missing";
    throw new Error(
      `browser daemon is not running (${stateIssue}; state: ${diagnostics.path}; ` +
      `source: ${diagnostics.source}; session: ${diagnostics.session ?? "default"}; ` +
      `profile: ${diagnostics.profileDir})`,
    );
  }
  return state;
}

// True when a request failed because the daemon process is gone or the
// specific view it tracked was already closed/reaped. Callers on the polling
// path (heartbeat, status) use this to stop retrying and surface a clear
// "session ended" state instead of silently respawning the daemon.
export function isDaemonGoneError(error: unknown): boolean {
  return error instanceof Error && (
    error.message.startsWith("browser daemon is not running") ||
    error.message === "browser view is missing or closed"
  );
}

async function canReuseDaemon(state: DaemonState): Promise<boolean> {
  if (!await isAlive(state)) {
    return false;
  }
  if (daemonConfigMatches(state)) {
    return true;
  }
  // A config mismatch only justifies replacing an idle daemon. A CLI run
  // from a plain shell loads different config than a pane viewer (no
  // HERDR_PLUGIN_CONFIG_DIR in its environment), and replacing the daemon
  // out from under live views strands their viewers: heartbeats follow the
  // state file to the replacement, come back "view is missing", and the
  // panes freeze on the session-ended screen. Mismatched config takes
  // effect on the next start after the daemon goes idle.
  return await hasLiveViews(state);
}

async function hasLiveViews(state: DaemonState): Promise<boolean> {
  try {
    const response = await request<BrowserViewListResponse>(
      state,
      "GET",
      "/views",
      undefined,
      DAEMON_REQUEST_TIMEOUT_MS,
      null,
    );
    return response.views.length > 0;
  } catch {
    // A healthy daemon whose view listing is temporarily unavailable is
    // still owned by live panes. Replacing it would strand those viewers.
    return true;
  }
}

async function shutdownDaemonState(state: DaemonState): Promise<void> {
  try {
    await request(state, "POST", "/shutdown");
    const started = Date.now();
    while (Date.now() - started < 5_000 && await isAlive(state)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } catch {
    // A dead daemon cannot acknowledge shutdown; ownership is checked below.
  }
  await removeDaemonStateIfOwned(state);
}

async function removeDaemonStateIfOwned(owner: DaemonState): Promise<void> {
  const current = await readDaemonState();
  if (current?.instanceId === owner.instanceId) {
    await rm(daemonStateFile(), { force: true });
  }
}

export function daemonConfigMatches(state: DaemonState): boolean {
  const captureBackendMatches = process.env.HERDR_BROWSER_CAPTURE_BACKEND === undefined ||
    (state.captureBackend ?? DEFAULT_CAPTURE_BACKEND) === configuredCaptureBackend();
  const cadenceMatches =
    (state.screencastEveryNthFrame ?? DEFAULT_SCREENCAST_EVERY_NTH_FRAME) ===
    configuredScreencastEveryNthFrame();
  const profileMatches = state.profileDir === chromeProfileDir();
  const displayModeMatches = process.env.HERDR_BROWSER_DISPLAY === undefined ||
    (state.displayMode ?? "headless") === process.env.HERDR_BROWSER_DISPLAY;
  return captureBackendMatches && cadenceMatches && profileMatches && displayModeMatches;
}

async function hasStateFile(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readDaemonState(): Promise<DaemonState | null> {
  try {
    const text = await readFile(daemonStateFile(), "utf8");
    const parsed = JSON.parse(text) as Partial<DaemonState>;
    if (
      typeof parsed.instanceId === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.baseUrl === "string" &&
      typeof parsed.token === "string" &&
      typeof parsed.startedAt === "string"
    ) {
      return parsed as DaemonState;
    }
    return null;
  } catch {
    return null;
  }
}

async function request<T = unknown>(
  state: DaemonState,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = DAEMON_REQUEST_TIMEOUT_MS,
  viewId = defaultViewId,
): Promise<T> {
  const response = await fetch(`${state.baseUrl}${path}`, {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      authorization: `Bearer ${state.token}`,
      ...(viewId ? { "x-herdr-browser-view": viewId } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json() as T | ErrorResponse;
  if (!response.ok || isErrorResponse(payload)) {
    throw new Error(isErrorResponse(payload) ? payload.error : `daemon request failed: ${response.status}`);
  }
  return payload as T;
}

function isRetiringDaemonError(error: unknown): boolean {
  return error instanceof Error && (
    error.message.includes("daemon is shutting down") ||
    error.message.includes("browser runtime is closed")
  );
}

function isErrorResponse(value: unknown): value is ErrorResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

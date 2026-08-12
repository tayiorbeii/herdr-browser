#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";

import {
  automationDescriptor,
  claimTab,
  consoleEntries,
  clickMouse,
  captureFrameData,
  cachedPageInfo,
  cachedTabs,
  closeTab,
  createBrowserRuntime,
  createBrowserView,
  createTab,
  currentPageInfo,
  evaluate,
  goBack,
  goForward,
  listTabs,
  moveMouse,
  navigate,
  nativeSelectAtPoint,
  onScreencastFrame,
  ownsTarget,
  pageText,
  reloadPage,
  selectorClick,
  selectorPress,
  selectorType,
  sendKeyboardInput,
  setScreencastCapacityGate,
  setViewport,
  startScreencast,
  stopLoading,
  stopScreencast,
  switchTab,
  waitForExpression,
  wheelMouse,
  type BrowserKey,
  type BrowserKeyboardInput,
  type BrowserSession,
  type BrowserRuntime,
} from "./browser";
import { startCdpViewGateway, type CdpViewGateway } from "./cdpGateway";
import { configuredCaptureBackend } from "./captureBackend";
import { reapStaleChrome } from "./staleChrome";
import { configuredScreencastEveryNthFrame } from "./screencastCadence";
import { chromeProfileDir, daemonStateFile, ensurePrivateParentDir } from "./paths";
import { DEFAULT_DEVICE_SCALE_FACTOR, validDeviceScaleFactor } from "./deviceScale";
import { SerialQueue } from "./serialQueue";
import {
  PaneGraphicsStream,
  pngSizeFromBuffer,
  type PaneGraphicsPlacement,
  type PaneGraphicsTarget,
} from "./herdrGraphics";
import type {
  DaemonState,
  DaemonStatus,
  DaemonMetrics,
  AutomationResponse,
  BrowserViewResponse,
  BrowserViewListResponse,
  BrowserViewSelectionResponse,
  DaemonHealth,
  ErrorResponse,
  EvalResponse,
  ConsoleResponse,
  GraphicsStreamRequest,
  GraphicsStreamResponse,
  KeyResponse,
  NavigationResponse,
  OpenResponse,
  MouseMoveResponse,
  MouseResponse,
  NativeSelectAtPointResponse,
  PageTextResponse,
  SelectorClickResponse,
  SelectorPressResponse,
  SelectorTypeResponse,
  ScreenshotResponse,
  TabResponse,
  WaitResponse,
  ViewportResponse,
  WheelResponse,
} from "./daemonProtocol";

const VIEW_LEASE_MS = 10_000;
const VIEW_SWEEP_MS = 2_000;
const ZERO_VIEW_GRACE_MS = 3_000;

type DaemonView = {
  session: BrowserSession;
  queue: SerialQueue;
  // Mouse/wheel/key input gets its own queue so it never waits behind slow
  // capture (screenshot/screencast fallback) or status work sharing `queue`.
  // CDP ordering per session is already guaranteed by the websocket, so
  // input only needs to stay ordered relative to other input.
  inputQueue: SerialQueue;
  metrics: Omit<DaemonMetrics, "ok">;
  graphicsStream: ActiveGraphicsStream | null;
  automationGateway: CdpViewGateway | null;
  automationGatewayPromise: Promise<CdpViewGateway> | null;
  paneId: string | null;
  createdAt: string;
  leaseExpiresAt: number;
};

async function main() {
  const stateFile = parseStateFileArg(process.argv.slice(2)) ?? daemonStateFile();
  await reapStaleChrome(stateFile);
  const token = randomUUID();
  const instanceId = randomUUID();
  const runtime = await createBrowserRuntime();
  const views = new Map<string, DaemonView>();
  let shuttingDown = false;
  let zeroViewTimer: ReturnType<typeof setTimeout> | null = null;
  let server: ReturnType<typeof Bun.serve> | undefined;

  const scheduleZeroViewShutdown = (): void => {
    if (views.size !== 0 || shuttingDown || zeroViewTimer) {
      return;
    }
    zeroViewTimer = setTimeout(() => {
      void shutdown(0);
    }, ZERO_VIEW_GRACE_MS);
    zeroViewTimer.unref();
  };

  const closeView = async (viewId: string): Promise<void> => {
    const view = views.get(viewId);
    if (!view) {
      return;
    }
    views.delete(viewId);
    const gateway = view.automationGateway ?? await view.automationGatewayPromise?.catch(() => null);
    await gateway?.close();
    view.automationGateway = null;
    view.automationGatewayPromise = null;
    view.graphicsStream?.stop();
    view.graphicsStream = null;
    await view.session.close();
    scheduleZeroViewShutdown();
  };

  const ensureAutomationGateway = async (view: DaemonView): Promise<CdpViewGateway> => {
    if (view.automationGateway) {
      return view.automationGateway;
    }
    if (view.automationGatewayPromise) {
      return await view.automationGatewayPromise;
    }
    const session = view.session;
    const run = <T>(callback: () => Promise<T>): Promise<T> => {
      view.leaseExpiresAt = Date.now() + VIEW_LEASE_MS;
      return view.queue.run(callback);
    };
    const startup = startCdpViewGateway({
      viewId: session.id,
      cdpHttpUrl: `http://127.0.0.1:${session.chrome.port}`,
      browserWebSocketUrl: session.chrome.browserWebSocketUrl,
      listTabs: () => run(() => listTabs(session)),
      ownsTarget: (targetId) => ownsTarget(session, targetId),
      claimTarget: (targetId, activate) => run(() => claimTab(session, targetId, activate)),
      activateTarget: (targetId) => run(() => switchTab(session, targetId)),
      closeTarget: (targetId) => run(() => closeTab(session, targetId)),
      createTarget: (url) => run(() => createTab(session, url)),
      disposeBrowserContext: (browserContextId) => run(() =>
        session.cdp.send("Target.disposeBrowserContext", { browserContextId })
      ),
    });
    view.automationGatewayPromise = startup;
    try {
      const gateway = await startup;
      if (!views.has(session.id) || session.closed) {
        await gateway.close();
        throw new Error("browser view closed while automation gateway was starting");
      }
      view.automationGateway = gateway;
      return gateway;
    } finally {
      if (view.automationGatewayPromise === startup) {
        view.automationGatewayPromise = null;
      }
    }
  };

  const shutdown = async (exitCode: number): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    if (zeroViewTimer) {
      clearTimeout(zeroViewTimer);
      zeroViewTimer = null;
    }
    for (const viewId of [...views.keys()]) {
      await closeView(viewId);
    }
    await runtime.close();
    await removeOwnedStateFile(stateFile, instanceId);
    server?.stop(true);
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  };

  // A daemon crash must not orphan Chrome: it holds the profile SingletonLock
  // and breaks the next launch. Run the normal shutdown path (which closes
  // Chrome) before exiting instead of letting the process die uncleanly.
  process.on("uncaughtException", (error) => {
    console.error("herdr-browser daemon: uncaught exception:", error instanceof Error ? error.message : String(error));
    void shutdown(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("herdr-browser daemon: unhandled rejection:", reason instanceof Error ? reason.message : String(reason));
    void shutdown(1);
  });

  // The browser-level CDP socket closing, or the Chrome process exiting, means
  // the browser is gone and every in-flight/future request would just time
  // out with a generic 500 while the view lease keeps the daemon alive. Both
  // conditions are treated as fatal so the client's retry-on-retiring-daemon
  // path can recover with a fresh daemon + Chrome. `shuttingDown` guards
  // against reacting to our own intentional shutdown closing these down.
  runtime.cdp.onClose((error) => {
    if (shuttingDown) {
      return;
    }
    console.error("herdr-browser daemon: browser CDP connection closed unexpectedly", error?.message ?? "");
    void shutdown(1);
  });
  runtime.chrome.process.once("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    console.error(
      `herdr-browser daemon: chrome process exited unexpectedly (code=${code}, signal=${signal})`,
      runtime.chrome.recentStderr(),
    );
    void shutdown(1);
  });

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      try {
        if (!authorized(request, token)) {
          return json({ ok: false, error: "unauthorized" }, 401);
        }
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/health") {
          if (shuttingDown) {
            return json({ ok: false, error: "daemon is shutting down" }, 503);
          }
          return json({
            ok: true,
            pid: process.pid,
            chrome_pid: runtime.chrome.process.pid ?? null,
            views: views.size,
          } satisfies DaemonHealth);
        }

        if (request.method === "POST" && url.pathname === "/views") {
          if (shuttingDown) {
            return json({ ok: false, error: "daemon is shutting down" }, 503);
          }
          const body = await request.json().catch(() => ({})) as { initialUrl?: string };
          const viewId = randomUUID();
          const session = await createBrowserView(
            runtime,
            viewId,
            typeof body.initialUrl === "string" && body.initialUrl ? body.initialUrl : "about:blank",
          );
          if (zeroViewTimer) {
            clearTimeout(zeroViewTimer);
            zeroViewTimer = null;
          }
          views.set(viewId, {
            session,
            queue: new SerialQueue(),
            inputQueue: new SerialQueue(),
            metrics: createMetrics(),
            graphicsStream: null,
            automationGateway: null,
            automationGatewayPromise: null,
            paneId: null,
            createdAt: new Date().toISOString(),
            leaseExpiresAt: Date.now() + VIEW_LEASE_MS,
          });
          return json({ ok: true, viewId } satisfies BrowserViewResponse, 201);
        }

        if (request.method === "GET" && url.pathname === "/views/select") {
          if (views.size > 1) {
            return json({
              ok: false,
              error: "multiple browser views are open; set HERDR_BROWSER_VIEW_ID",
            }, 409);
          }
          return json({
            ok: true,
            viewId: views.keys().next().value ?? null,
          } satisfies BrowserViewSelectionResponse);
        }

        if (request.method === "GET" && url.pathname === "/views") {
          const viewInfos = await Promise.all([...views.values()].map((view) => view.queue.run(async () => {
            const info = await currentPageInfo(view.session);
            return {
              view_id: view.session.id,
              pane_id: view.paneId,
              created_at: view.createdAt,
              active_target_id: view.session.targetId,
              url: info.url,
              title: info.title,
              tabs: await listTabs(view.session),
            };
          })));
          return json({ ok: true, views: viewInfos } satisfies BrowserViewListResponse);
        }

        if (request.method === "POST" && url.pathname === "/shutdown") {
          queueMicrotask(() => void shutdown(0));
          return json({ ok: true });
        }

        const viewId = request.headers.get("x-herdr-browser-view");
        const view = viewId ? views.get(viewId) : undefined;
        if (!view) {
          return json({ ok: false, error: "browser view is missing or closed" }, 410);
        }
        if (request.method === "POST" && url.pathname === "/views/heartbeat") {
          const body = await request.json().catch(() => ({})) as { paneId?: unknown };
          if (typeof body.paneId === "string" && body.paneId.trim()) {
            view.paneId = body.paneId.trim();
          }
          view.leaseExpiresAt = Date.now() + VIEW_LEASE_MS;
          return json({ ok: true });
        }
        if (request.method === "POST" && url.pathname === "/views/close") {
          await closeView(viewId as string);
          return json({ ok: true });
        }

        view.leaseExpiresAt = Date.now() + VIEW_LEASE_MS;
        const session = view.session;
        const metrics = view.metrics;
        const activeSession = <T>(callback: () => Promise<T>): Promise<T> => view.queue.run(callback);
        // Input never waits behind capture/status work sharing `queue`; it
        // only needs to stay ordered relative to other input on this view.
        const activeInput = <T>(callback: () => Promise<T>): Promise<T> => view.inputQueue.run(callback);
        metrics.requests += 1;
        if (request.method === "GET" && url.pathname === "/status") {
          // Served entirely from locally cached target info (kept current by
          // Target.targetInfoChanged) so the 1s poll never touches CDP: no
          // Page.getNavigationHistory/Runtime.evaluate round trip and no
          // /json/list fetch, and it never contends with the capture/status
          // queue or the input queue.
          const info = cachedPageInfo(session);
          return json({
            ok: true,
            pid: process.pid,
            chrome_pid: session.chrome.process.pid ?? null,
            chrome_executable: session.chrome.executable,
            chrome_cdp_port: session.chrome.port,
            url: info.url,
            title: info.title,
            captureBackend: configuredCaptureBackend(),
            display_mode: process.env.HERDR_BROWSER_DISPLAY === "headful" ? "headful" : "headless",
            tabs: cachedTabs(session),
          } satisfies DaemonStatus);
        }

        if (request.method === "POST" && url.pathname === "/tabs/switch") {
          const body = await request.json() as { targetId?: string };
          if (!body.targetId) {
            return json({ ok: false, error: "missing targetId" }, 400);
          }
          return json(await activeSession(async () => ({
            ok: true,
            ...await switchTab(session, body.targetId as string),
          } satisfies TabResponse)));
        }

        if (request.method === "POST" && url.pathname === "/tabs") {
          return json(await activeSession(async () => ({
            ok: true,
            ...await createTab(session),
          } satisfies TabResponse)), 201);
        }

        if (request.method === "POST" && url.pathname === "/tabs/close") {
          const body = await request.json() as { targetId?: string };
          if (!body.targetId) {
            return json({ ok: false, error: "missing targetId" }, 400);
          }
          return json(await activeSession(async () => ({
            ok: true,
            ...await closeTab(session, body.targetId as string),
          } satisfies TabResponse)));
        }

        if (request.method === "GET" && url.pathname === "/automation") {
          const gateway = await ensureAutomationGateway(view);
          return json(await activeSession(async () => ({
            ok: true,
            ...await automationDescriptor(session, {
              cdpHttpUrl: gateway.httpUrl,
              browserWebSocketUrl: gateway.browserWebSocketUrl,
              pageWebSocketUrl: gateway.pageWebSocketUrl,
            }),
          } satisfies AutomationResponse)));
        }

        if (request.method === "POST" && url.pathname === "/open") {
          const body = await request.json() as { url?: string };
          if (!body.url) {
            return json({ ok: false, error: "missing url" }, 400);
          }
          const result = await activeSession(() => navigate(session, body.url as string));
          return json({
            ok: true,
            url: result.url,
            title: result.title,
            navigated: result.navigated,
            timed_out: result.timed_out,
          } satisfies OpenResponse);
        }

        if (request.method === "POST" && url.pathname === "/back") {
          return json(await activeSession(async () => ({ ok: true, ...await goBack(session) } satisfies NavigationResponse)));
        }

        if (request.method === "POST" && url.pathname === "/forward") {
          return json(await activeSession(async () => ({ ok: true, ...await goForward(session) } satisfies NavigationResponse)));
        }

        if (request.method === "POST" && url.pathname === "/reload") {
          return json(await activeSession(async () => ({ ok: true, ...await reloadPage(session) } satisfies NavigationResponse)));
        }

        if (request.method === "POST" && url.pathname === "/stop-loading") {
          return json(await activeSession(async () => ({ ok: true, ...await stopLoading(session) } satisfies NavigationResponse)));
        }

        if (request.method === "POST" && url.pathname === "/eval") {
          const body = await request.json() as { expression?: string };
          if (!body.expression) {
            return json({ ok: false, error: "missing expression" }, 400);
          }
          const value = await activeSession(() => evaluate(session, body.expression as string));
          return json({ ok: true, value } satisfies EvalResponse);
        }

        if (request.method === "POST" && url.pathname === "/screenshot") {
          const started = performance.now();
          const frame = await activeSession(() => captureFrameData(session));
          metrics.screenshots.count += 1;
          metrics.screenshots.last_ms = Math.round(performance.now() - started);
          metrics.screenshots.total_ms += metrics.screenshots.last_ms;
          metrics.screenshots.last_bytes = Buffer.byteLength(frame.data, "base64");
          metrics.screenshots.backend = frame.backend;
          return json({ ok: true, data: frame.data } satisfies ScreenshotResponse);
        }

        if (request.method === "GET" && url.pathname === "/text") {
          return json(await activeSession(async () => ({ ok: true, text: await pageText(session) } satisfies PageTextResponse)));
        }

        if (request.method === "GET" && url.pathname === "/console") {
          return json({ ok: true, entries: consoleEntries(session) } satisfies ConsoleResponse);
        }

        if (request.method === "GET" && url.pathname === "/metrics") {
          return json({ ok: true, ...metrics } satisfies DaemonMetrics);
        }

        if (request.method === "POST" && url.pathname === "/viewport") {
          const body = await request.json() as {
            width?: number;
            height?: number;
            deviceScaleFactor?: number;
            pageScaleFactor?: number;
          };
          const width = normalizedInteger(body.width, 1);
          const height = normalizedInteger(body.height, 1);
          const deviceScaleFactor = normalizedDeviceScaleFactor(body.deviceScaleFactor);
          const pageScaleFactor = normalizedDeviceScaleFactor(body.pageScaleFactor);
          if (width === null || height === null || deviceScaleFactor === null || pageScaleFactor === null) {
            return json({ ok: false, error: "missing valid viewport payload" }, 400);
          }
          const viewport = {
            width,
            height,
            deviceScaleFactor,
            pageScaleFactor,
          };
          await activeSession(() => setViewport(session, viewport));
          metrics.viewport_updates += 1;
          return json({ ok: true, ...viewport } satisfies ViewportResponse);
        }

        if (request.method === "POST" && url.pathname === "/graphics-stream") {
          const body = await request.json() as Partial<GraphicsStreamRequest>;
          const graphicsRequest = normalizedGraphicsStreamRequest(body);
          if (!graphicsRequest) {
            return json({ ok: false, error: "missing valid graphics stream payload" }, 400);
          }
          await activeSession(async () => {
            const needsInitialFrame = !view.graphicsStream ||
              !view.graphicsStream.matches(graphicsRequest) ||
              !view.graphicsStream.hasPlacement(graphicsRequest.placement);
            try {
              if (!view.graphicsStream || !view.graphicsStream.matches(graphicsRequest)) {
                view.graphicsStream?.stop();
                view.graphicsStream = await ActiveGraphicsStream.start(
                  session,
                  graphicsRequest,
                  metrics.graphics_stream,
                );
              } else {
                view.graphicsStream.update(graphicsRequest);
              }
              const screencastRestarted = await startScreencast(
                session,
                graphicsRequest.capture,
              );
              if (needsInitialFrame && !screencastRestarted) {
                const initialFrame = await captureFrameData(session, graphicsRequest.capture);
                await view.graphicsStream.sendBase64Frame(initialFrame.data);
              }
            } catch (error) {
              view.graphicsStream?.stop();
              view.graphicsStream = null;
              await stopScreencast(session);
              throw error;
            }
          });
          return json({
            ok: true,
            active: true,
            transport: "daemon-stream",
          } satisfies GraphicsStreamResponse);
        }

        if (request.method === "POST" && url.pathname === "/graphics-stream/stop") {
          await activeSession(async () => {
            view.graphicsStream?.stop();
            view.graphicsStream = null;
            await stopScreencast(session);
          });
          return json({
            ok: true,
            active: false,
            transport: "daemon-stream",
          } satisfies GraphicsStreamResponse);
        }

        if (request.method === "POST" && url.pathname === "/mouse") {
          const body = await request.json() as {
            x?: number;
            y?: number;
            probeNativeSelect?: boolean;
          };
          const x = normalizedInteger(body.x, 0);
          const y = normalizedInteger(body.y, 0);
          if (x === null || y === null) {
            return json({ ok: false, error: "missing valid x/y" }, 400);
          }
          // Folds the native-<select> hit test into the click request itself
          // (one HTTP round trip instead of a probe request followed by a
          // click request) so the viewer only pays for it when it actually
          // needs to decide whether a native select popup just opened.
          const nativeSelect = await activeInput(async () => {
            const hit = body.probeNativeSelect
              ? await nativeSelectAtPoint(session, { x, y })
              : null;
            await clickMouse(session, { x, y });
            return hit?.nativeSelect ?? false;
          });
          metrics.mouse_clicks += 1;
          return json({ ok: true, x, y, nativeSelect } satisfies MouseResponse);
        }

        if (request.method === "POST" && url.pathname === "/mouse-move") {
          const body = await request.json() as {
            x?: number;
            y?: number;
          };
          const x = normalizedInteger(body.x, 0);
          const y = normalizedInteger(body.y, 0);
          if (x === null || y === null) {
            return json({ ok: false, error: "missing valid x/y" }, 400);
          }
          await activeInput(() => moveMouse(session, { x, y }));
          metrics.mouse_moves += 1;
          return json({ ok: true, x, y } satisfies MouseMoveResponse);
        }

        if (request.method === "POST" && url.pathname === "/native-select-at") {
          const body = await request.json() as {
            x?: number;
            y?: number;
          };
          const x = normalizedInteger(body.x, 0);
          const y = normalizedInteger(body.y, 0);
          if (x === null || y === null) {
            return json({ ok: false, error: "missing valid x/y" }, 400);
          }
          return json(await activeInput(async () => ({
            ok: true,
            ...await nativeSelectAtPoint(session, { x, y }),
          } satisfies NativeSelectAtPointResponse)));
        }

        if (request.method === "POST" && url.pathname === "/wheel") {
          const body = await request.json() as {
            x?: number;
            y?: number;
            deltaX?: number;
            deltaY?: number;
          };
          const x = normalizedInteger(body.x, 0);
          const y = normalizedInteger(body.y, 0);
          if (x === null || y === null || !validNumber(body.deltaX) || !validNumber(body.deltaY)) {
            return json({ ok: false, error: "missing valid wheel payload" }, 400);
          }
          const wheel = { x, y, deltaX: body.deltaX, deltaY: body.deltaY };
          await activeInput(() => wheelMouse(session, wheel));
          metrics.mouse_wheels += 1;
          return json({ ok: true, ...wheel } satisfies WheelResponse);
        }

        if (request.method === "POST" && url.pathname === "/key") {
          const body = await request.json() as Partial<BrowserKeyboardInput>;
          const input = normalizedKeyboardInput(body);
          if (!input) {
            return json({ ok: false, error: "missing valid key payload" }, 400);
          }
          await activeInput(() => sendKeyboardInput(session, input));
          metrics.key_events += 1;
          return json({ ok: true } satisfies KeyResponse);
        }

        if (request.method === "POST" && url.pathname === "/selector-click") {
          const body = await request.json() as { selector?: string };
          if (!body.selector) {
            return json({ ok: false, error: "missing selector" }, 400);
          }
          const point = await activeSession(() => selectorClick(session, body.selector as string));
          metrics.mouse_clicks += 1;
          return json({ ok: true, selector: body.selector, ...point } satisfies SelectorClickResponse);
        }

        if (request.method === "POST" && url.pathname === "/type") {
          const body = await request.json() as { selector?: string; text?: string };
          if (!body.selector || typeof body.text !== "string") {
            return json({ ok: false, error: "missing selector/text" }, 400);
          }
          await activeSession(() => selectorType(session, body.selector as string, body.text as string));
          metrics.key_events += 1;
          return json({ ok: true, selector: body.selector, text: body.text } satisfies SelectorTypeResponse);
        }

        if (request.method === "POST" && url.pathname === "/press") {
          const body = await request.json() as { selector?: string | null; key?: string };
          if (!isBrowserKey(body.key)) {
            return json({ ok: false, error: "missing valid key" }, 400);
          }
          const key = body.key;
          await activeSession(() => selectorPress(session, body.selector ?? null, key));
          metrics.key_events += 1;
          return json({ ok: true, selector: body.selector ?? null, key } satisfies SelectorPressResponse);
        }

        if (request.method === "POST" && url.pathname === "/wait") {
          const body = await request.json() as { expression?: string; timeout_ms?: number };
          if (!body.expression) {
            return json({ ok: false, error: "missing expression" }, 400);
          }
          const timeoutMs = normalizedInteger(body.timeout_ms ?? 5_000, 1) ?? 5_000;
          const value = await activeSession(() => waitForExpression(session, body.expression as string, timeoutMs));
          return json({ ok: true, value } satisfies WaitResponse);
        }

        return json({ ok: false, error: "not found" }, 404);
      } catch (error) {
        return json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies ErrorResponse, 500);
      }
    },
  });

  // Chrome and the HTTP server are already up at this point; if any of this
  // setup throws (e.g. the state file write), the runtime must still be
  // closed so Chrome isn't orphaned holding the profile SingletonLock.
  try {
    const state: DaemonState = {
      instanceId,
      pid: process.pid,
      baseUrl: server.url.href.replace(/\/$/, ""),
      token,
      startedAt: new Date().toISOString(),
      captureBackend: configuredCaptureBackend(),
      screencastEveryNthFrame: configuredScreencastEveryNthFrame(),
      profileDir: chromeProfileDir(),
      chromePid: runtime.chrome.process.pid ?? null,
      displayMode: process.env.HERDR_BROWSER_DISPLAY === "headful" ? "headful" : "headless",
    };
    await ensurePrivateParentDir(stateFile);
    await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(stateFile, 0o600);
    scheduleZeroViewShutdown();

    const leaseSweep = setInterval(() => {
      const now = Date.now();
      for (const [viewId, view] of views) {
        if (view.leaseExpiresAt <= now && !view.queue.busy && !view.inputQueue.busy) {
          void closeView(viewId);
        }
      }
    }, VIEW_SWEEP_MS);
    leaseSweep.unref();

    process.on("SIGTERM", () => void shutdown(0));
    process.on("SIGINT", () => void shutdown(130));
  } catch (error) {
    console.error("herdr-browser daemon: startup failed:", error instanceof Error ? error.message : String(error));
    await shutdown(1);
    return;
  }

  await new Promise(() => {});
}

class ActiveGraphicsStream {
  private placement: PaneGraphicsPlacement;
  private stopped = false;
  private sending = false;
  private pendingFrame: string | null = null;
  private unsubscribeClose: () => void;
  private readonly drainListeners = new Set<() => void>();

  private constructor(
    private readonly session: BrowserSession,
    private readonly target: PaneGraphicsTarget,
    private readonly stream: PaneGraphicsStream,
    private readonly unsubscribe: () => void,
    private readonly metrics: Omit<DaemonMetrics, "ok">["graphics_stream"],
    request: GraphicsStreamRequest,
  ) {
    this.placement = request.placement;
    resetGraphicsStreamMetrics(this.metrics);
    this.metrics.active = true;
    this.metrics.started_at = new Date().toISOString();
    this.unsubscribeClose = stream.onClose((error) => {
      if (error) {
        this.metrics.errors += 1;
        this.metrics.last_error = error.message;
      }
      this.stop();
    });
  }

  static async start(
    session: BrowserSession,
    request: GraphicsStreamRequest,
    metrics: Omit<DaemonMetrics, "ok">["graphics_stream"],
  ): Promise<ActiveGraphicsStream> {
    const stream = await PaneGraphicsStream.open({
      target: request.target,
    });
    let active: ActiveGraphicsStream | null = null;
    const unsubscribe = onScreencastFrame(
      session,
      (data) => {
        metrics.frames_received += 1;
        void active?.sendBase64Frame(data).catch(() => {});
      },
    );
    active = new ActiveGraphicsStream(
      session,
      request.target,
      stream,
      unsubscribe,
      metrics,
      request,
    );
    setScreencastCapacityGate(session, {
      isSaturated: () => active!.isSaturated(),
      onDrain: (listener) => active!.onDrain(listener),
    });
    return active;
  }

  // Saturated means the write pipeline has no room left: one frame is being
  // written and the single coalescing slot behind it is already occupied.
  isSaturated(): boolean {
    return this.sending && this.pendingFrame !== null;
  }

  onDrain(listener: () => void): () => void {
    this.drainListeners.add(listener);
    return () => this.drainListeners.delete(listener);
  }

  private notifyDrain(): void {
    if (this.drainListeners.size === 0) {
      return;
    }
    for (const listener of [...this.drainListeners]) {
      listener();
    }
  }

  matches(request: GraphicsStreamRequest): boolean {
    return (
      !this.stopped &&
      this.target.socketPath === request.target.socketPath &&
      this.target.paneId === request.target.paneId
    );
  }

  hasPlacement(placement: PaneGraphicsPlacement): boolean {
    return sameGraphicsPlacement(this.placement, placement);
  }

  update(request: GraphicsStreamRequest): void {
    this.placement = request.placement;
  }

  async sendBase64Frame(data: string): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (this.sending) {
      this.metrics.frames_coalesced += 1;
      if (this.pendingFrame !== null) {
        this.metrics.frames_dropped += 1;
      }
      this.pendingFrame = data;
      return;
    }
    this.sending = true;
    try {
      let next: string | null = data;
      while (next && !this.stopped) {
        const hadPendingSlot = this.pendingFrame !== null;
        this.pendingFrame = null;
        if (hadPendingSlot) {
          this.notifyDrain();
        }
        await this.sendOneBase64Frame(next);
        next = this.pendingFrame;
      }
    } finally {
      this.sending = false;
      this.notifyDrain();
    }
  }

  private async sendOneBase64Frame(data: string): Promise<void> {
    const png = Buffer.from(data, "base64");
    const image = pngSizeFromBuffer(png);
    if (!image) {
      return;
    }
    try {
      const started = performance.now();
      await this.stream.sendFrame({
        png,
        image,
        placement: this.placement,
      });
      const writeMs = Math.max(0, Math.round(performance.now() - started));
      this.metrics.frames_sent += 1;
      this.metrics.last_bytes = png.length;
      this.metrics.total_bytes += png.length;
      this.metrics.last_write_ms = writeMs;
      this.metrics.total_write_ms += writeMs;
      this.metrics.max_write_ms = Math.max(this.metrics.max_write_ms, writeMs);
      this.metrics.last_frame_width = image.width;
      this.metrics.last_frame_height = image.height;
      this.metrics.last_frame_at = new Date().toISOString();
      this.metrics.last_error = null;
    } catch (error) {
      this.metrics.errors += 1;
      this.metrics.last_error = error instanceof Error ? error.message : String(error);
      this.stop();
      throw error;
    }
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    // Detach before unsubscribing so a held ack is released immediately
    // instead of waiting on a consumer that no longer exists.
    setScreencastCapacityGate(this.session, null);
    this.unsubscribe();
    this.unsubscribeClose();
    this.stream.close();
    this.metrics.active = false;
  }
}

function authorized(request: Request, token: string): boolean {
  return request.headers.get("authorization") === `Bearer ${token}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function parseStateFileArg(args: string[]): string | undefined {
  const index = args.indexOf("--state-file");
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

async function removeOwnedStateFile(path: string, instanceId: string): Promise<void> {
  try {
    const state = JSON.parse(await readFile(path, "utf8")) as Partial<DaemonState>;
    if (state.instanceId === instanceId) {
      await rm(path, { force: true });
    }
  } catch {
    // Missing or replaced state is already relinquished.
  }
}

function normalizedInteger(value: unknown, min: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    return null;
  }
  return Math.max(min, Math.floor(value));
}

function normalizedDeviceScaleFactor(value: unknown): number | null {
  if (value === undefined) {
    return DEFAULT_DEVICE_SCALE_FACTOR;
  }
  if (!validDeviceScaleFactor(value)) {
    return null;
  }
  return value;
}

function validNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizedKeyboardInput(value: Partial<BrowserKeyboardInput>): BrowserKeyboardInput | null {
  if (value.kind === "text" && typeof value.text === "string" && value.text.length > 0) {
    return {
      kind: "text",
      text: value.text,
    };
  }
  if (value.kind === "key" && isBrowserKey(value.key)) {
    return {
      kind: "key",
      key: value.key,
    };
  }
  return null;
}

function normalizedGraphicsStreamRequest(
  value: Partial<GraphicsStreamRequest>,
): GraphicsStreamRequest | null {
  const target = normalizedGraphicsTarget(value.target);
  const placement = normalizedGraphicsPlacement(value.placement);
  const capture = normalizedScreencastCapture(value.capture);
  if (!target || !placement || capture === undefined) {
    return null;
  }
  return {
    target,
    placement,
    capture,
  };
}

function normalizedScreencastCapture(
  value: unknown,
): GraphicsStreamRequest["capture"] | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "object") {
    return undefined;
  }
  const source = value as { maxWidth?: unknown; maxHeight?: unknown };
  const maxWidth = normalizedInteger(source.maxWidth, 1);
  const maxHeight = normalizedInteger(source.maxHeight, 1);
  if (maxWidth === null || maxHeight === null) {
    return undefined;
  }
  return { maxWidth, maxHeight };
}

function normalizedGraphicsTarget(value: unknown): PaneGraphicsTarget | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const source = value as Partial<PaneGraphicsTarget>;
  if (typeof source.socketPath !== "string" || !source.socketPath.trim()) {
    return null;
  }
  if (typeof source.paneId !== "string" || !source.paneId.trim()) {
    return null;
  }
  return {
    socketPath: source.socketPath,
    paneId: source.paneId,
  };
}

function normalizedGraphicsPlacement(value: unknown): PaneGraphicsPlacement | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const source = value as Partial<PaneGraphicsPlacement>;
  const viewportCol = normalizedInteger(source.viewportCol, 0);
  const viewportRow = normalizedInteger(source.viewportRow, 0);
  const gridCols = normalizedInteger(source.gridCols, 1);
  const gridRows = normalizedInteger(source.gridRows, 1);
  if (
    viewportCol === null ||
    viewportRow === null ||
    gridCols === null ||
    gridRows === null
  ) {
    return null;
  }
  return {
    viewportCol,
    viewportRow,
    gridCols,
    gridRows,
  };
}

function sameGraphicsPlacement(left: PaneGraphicsPlacement, right: PaneGraphicsPlacement): boolean {
  return (
    left.viewportCol === right.viewportCol &&
    left.viewportRow === right.viewportRow &&
    left.gridCols === right.gridCols &&
    left.gridRows === right.gridRows
  );
}

function isBrowserKey(value: unknown): value is BrowserKey {
  return (
    value === "Enter" ||
    value === "Tab" ||
    value === "Backspace" ||
    value === "Escape" ||
    value === "ArrowUp" ||
    value === "ArrowDown" ||
    value === "ArrowLeft" ||
    value === "ArrowRight"
  );
}

function createMetrics(): Omit<DaemonMetrics, "ok"> {
  const graphicsStream = createGraphicsStreamMetrics();
  return {
    started_at: new Date().toISOString(),
    requests: 0,
    errors: 0,
    screenshots: {
      count: 0,
      total_ms: 0,
      last_ms: 0,
      last_bytes: 0,
      backend: "screenshot",
    },
    graphics_stream: graphicsStream,
    viewport_updates: 0,
    mouse_clicks: 0,
    mouse_moves: 0,
    mouse_wheels: 0,
    key_events: 0,
  };
}

function createGraphicsStreamMetrics(): Omit<DaemonMetrics, "ok">["graphics_stream"] {
  return {
    active: false,
    started_at: null,
    frames_received: 0,
    frames_sent: 0,
    frames_coalesced: 0,
    frames_dropped: 0,
    errors: 0,
    last_error: null,
    last_bytes: 0,
    total_bytes: 0,
    last_write_ms: 0,
    total_write_ms: 0,
    max_write_ms: 0,
    last_frame_width: 0,
    last_frame_height: 0,
    last_frame_at: null,
  };
}

function resetGraphicsStreamMetrics(metrics: Omit<DaemonMetrics, "ok">["graphics_stream"]): void {
  Object.assign(metrics, createGraphicsStreamMetrics());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

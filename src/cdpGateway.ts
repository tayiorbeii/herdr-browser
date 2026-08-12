import type { BrowserTabInfo } from "./browser";
import { SerialQueue } from "./serialQueue";

type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: string };
};

type PendingRequest = {
  method: string;
  params: Record<string, unknown>;
};

// These methods expose or mutate browser-global state that cannot be proven to
// belong to one view. Keep the gateway useful for normal CDP automation while
// refusing cross-view metadata and window control.
const UNSCOPED_BROWSER_METHODS = new Set([
  "Browser.getBrowserCommandLine",
  "Browser.getHistograms",
  "Browser.getWindowBounds",
  "Browser.getWindowForTarget",
  "Browser.setWindowBounds",
  "Browser.setPermission",
  "Browser.grantPermissions",
  "Browser.resetPermissions",
]);

type GatewaySocketData = {
  upstreamUrl: string;
  pageTargetId: string | null;
  upstream: globalThis.WebSocket | null;
  queued: string[];
  pending: Map<number, PendingRequest>;
  sessionTargets: Map<string, string>;
  visibleTargets: Set<string>;
  pendingTargetEvents: Map<string, string[]>;
  upstreamQueue: SerialQueue;
  internalRequestIds: Set<number>;
  nextInternalRequestId: number;
};

type GatewaySocket = Bun.ServerWebSocket<GatewaySocketData>;

export type CdpViewGatewayController = {
  viewId: string;
  cdpHttpUrl: string;
  browserWebSocketUrl: string;
  listTabs: () => Promise<BrowserTabInfo[]>;
  ownsTarget: (targetId: string) => boolean;
  claimTarget: (targetId: string, activate: boolean) => Promise<BrowserTabInfo>;
  activateTarget: (targetId: string) => Promise<BrowserTabInfo>;
  closeTarget: (targetId: string) => Promise<BrowserTabInfo>;
  createTarget: (url: string) => Promise<BrowserTabInfo>;
  disposeBrowserContext: (browserContextId: string) => Promise<void>;
};

export type CdpViewGateway = {
  httpUrl: string;
  browserWebSocketUrl: string;
  pageWebSocketUrl: (targetId: string) => string;
  close: () => Promise<void>;
};

export async function startCdpViewGateway(controller: CdpViewGatewayController): Promise<CdpViewGateway> {
  const sockets = new Set<GatewaySocket>();
  const ownedBrowserContexts = new Set<string>();
  let closed = false;

  const server = Bun.serve<GatewaySocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      const pathname = normalizedPath(url.pathname);
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const pageTargetId = pageTargetFromPath(pathname);
        if (!isBrowserSocketPath(pathname) && !pageTargetId) {
          return new Response("not found", { status: 404 });
        }
        if (pageTargetId && !controller.ownsTarget(pageTargetId)) {
          return new Response("target not owned by this browser view", { status: 404 });
        }
        const data: GatewaySocketData = {
          upstreamUrl: pageTargetId
            ? `${webSocketOrigin(controller.browserWebSocketUrl)}/devtools/page/${encodeURIComponent(pageTargetId)}`
            : controller.browserWebSocketUrl,
          pageTargetId,
          upstream: null,
          queued: [],
          pending: new Map(),
          sessionTargets: new Map(),
          visibleTargets: new Set(pageTargetId ? [pageTargetId] : []),
          pendingTargetEvents: new Map(),
          upstreamQueue: new SerialQueue(),
          internalRequestIds: new Set(),
          nextInternalRequestId: 2_000_000_000,
        };
        return server.upgrade(request, { data })
          ? undefined
          : new Response("websocket upgrade failed", { status: 500 });
      }
      return handleHttpRequest(request, url, pathname);
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
        connectUpstream(socket, socket.data);
      },
      message(socket, message) {
        void forwardDownstreamMessage(socket, socket.data, messageText(message));
      },
      close(socket) {
        sockets.delete(socket);
        socket.data.upstream?.close();
      },
    },
  });
  const port = server.port;

  function connectUpstream(socket: GatewaySocket, data: GatewaySocketData): void {
    const upstream = new globalThis.WebSocket(data.upstreamUrl);
    data.upstream = upstream;
    upstream.addEventListener("open", () => {
      for (const message of data.queued.splice(0)) {
        upstream.send(message);
      }
    });
    upstream.addEventListener("message", (event) => {
      const message = messageText(event.data);
      void data.upstreamQueue.run(() => forwardUpstreamMessage(socket, data, message));
    });
    upstream.addEventListener("close", (event) => socket.close(event.code, event.reason));
    upstream.addEventListener("error", () => socket.close(1011, "upstream CDP connection failed"));
  }

  async function handleHttpRequest(
    request: Request,
    url: URL,
    pathname: string,
  ): Promise<Response> {
      if (pathname === "/" || pathname === "/json/version") {
        const upstream = await fetch(`${controller.cdpHttpUrl}/json/version`);
        const version = upstream.ok
          ? await upstream.json() as Record<string, unknown>
          : { Browser: "Herdr Browser", "Protocol-Version": "1.3" };
        return json({
          ...version,
          webSocketDebuggerUrl: browserWebSocketUrl(),
        });
      }
      if (pathname === "/json" || pathname === "/json/list") {
        return json(await targetDescriptors());
      }
      if (pathname === "/json/protocol") {
        return await fetch(`${controller.cdpHttpUrl}/json/protocol`);
      }
      if (pathname === "/json/new" && (request.method === "PUT" || request.method === "GET")) {
        const requestedUrl = url.searchParams.get("url") ?? (
          url.search.length > 1 ? decodeURIComponent(url.search.slice(1)) : "about:blank"
        );
        const tab = await controller.createTarget(requestedUrl);
        return json(targetDescriptor(tab));
      }

      const activateTargetId = targetIdFromHttpPath(pathname, "/json/activate/");
      if (activateTargetId) {
        await controller.activateTarget(activateTargetId);
        return new Response("Target activated");
      }
      const closeTargetId = targetIdFromHttpPath(pathname, "/json/close/");
      if (closeTargetId) {
        await controller.closeTarget(closeTargetId);
        return new Response("Target is closing");
      }
      return new Response("not found", { status: 404 });
  }

  function httpUrl(): string {
    return `http://127.0.0.1:${port}`;
  }

  function browserWebSocketUrl(): string {
    return `ws://127.0.0.1:${port}/devtools/browser/${encodeURIComponent(controller.viewId)}`;
  }

  function pageWebSocketUrl(targetId: string): string {
    return `ws://127.0.0.1:${port}/devtools/page/${encodeURIComponent(targetId)}`;
  }

  async function targetDescriptors(): Promise<Array<Record<string, unknown>>> {
    return (await controller.listTabs()).map(targetDescriptor);
  }

  function targetDescriptor(tab: BrowserTabInfo): Record<string, unknown> {
    return {
      description: "",
      // Chromium's discovery UI does not synthesize this URL from the page
      // WebSocket endpoint. Keep it gateway-scoped so DevTools can attach
      // without ever pointing at the upstream browser or another view.
      devtoolsFrontendUrl: `/devtools/inspector.html?ws=127.0.0.1:${port}/devtools/page/${encodeURIComponent(tab.targetId)}`,
      id: tab.targetId,
      title: tab.title,
      type: "page",
      url: tab.url,
      webSocketDebuggerUrl: pageWebSocketUrl(tab.targetId),
    };
  }

  async function forwardDownstreamMessage(
    socket: GatewaySocket,
    data: GatewaySocketData,
    text: string,
  ): Promise<void> {
    const message = parseMessage(text);
    if (!message?.method) {
      forwardToUpstream(data, text);
      return;
    }
    const params = message.params ?? {};

    try {
      if (UNSCOPED_BROWSER_METHODS.has(message.method)) {
        throw new Error("browser-wide CDP method is not available through a view-scoped gateway");
      }
      if (message.method === "Browser.close") {
        sendResult(socket, message.id, {});
        setTimeout(() => socket.close(1000, "automation client disconnected"), 10);
        return;
      }
      if (message.method === "Target.closeTarget") {
        const targetId = requiredTargetId(params);
        requireOwnedTarget(targetId);
        await controller.closeTarget(targetId);
        sendResult(socket, message.id, { success: true });
        return;
      }
      if (message.method === "Page.close") {
        const targetId = data.pageTargetId ?? (
          message.sessionId ? data.sessionTargets.get(message.sessionId) : undefined
        );
        if (!targetId) {
          throw new Error("Page.close target is not attached to this browser view");
        }
        requireOwnedTarget(targetId);
        await controller.closeTarget(targetId);
        sendResult(socket, message.id, {});
        return;
      }
      if (message.method === "Target.activateTarget") {
        const targetId = requiredTargetId(params);
        requireOwnedTarget(targetId);
        await controller.activateTarget(targetId);
      }
      if (message.method === "Page.bringToFront") {
        const targetId = data.pageTargetId ?? (
          message.sessionId ? data.sessionTargets.get(message.sessionId) : undefined
        );
        if (targetId) {
          requireOwnedTarget(targetId);
          await controller.activateTarget(targetId);
        }
      }
      const targetId = typeof params.targetId === "string" ? params.targetId : null;
      if (targetId) {
        requireOwnedTarget(targetId);
      }
      const browserContextId = typeof params.browserContextId === "string"
        ? params.browserContextId
        : null;
      if (browserContextId && !ownedBrowserContexts.has(browserContextId)) {
        throw new Error(`browser context is not owned by browser view ${controller.viewId}`);
      }
      if (
        message.sessionId &&
        !data.pageTargetId &&
        !data.sessionTargets.has(message.sessionId)
      ) {
        throw new Error(`CDP session is not owned by browser view ${controller.viewId}`);
      }
      const nestedSessionId = typeof params.sessionId === "string" ? params.sessionId : null;
      if (
        nestedSessionId &&
        (message.method === "Target.sendMessageToTarget" || message.method === "Target.detachFromTarget") &&
        !data.sessionTargets.has(nestedSessionId)
      ) {
        throw new Error(`CDP session is not owned by browser view ${controller.viewId}`);
      }
      if (message.id !== undefined) {
        data.pending.set(message.id, { method: message.method, params });
      }
      forwardToUpstream(data, text);
    } catch (error) {
      sendError(socket, message.id, error);
    }
  }

  async function forwardUpstreamMessage(
    socket: GatewaySocket,
    data: GatewaySocketData,
    text: string,
  ): Promise<void> {
    const message = parseMessage(text);
    if (!message) {
      return;
    }

    if (message.id !== undefined) {
      if (data.internalRequestIds.delete(message.id)) {
        return;
      }
      const pending = data.pending.get(message.id);
      data.pending.delete(message.id);
      if (!pending || message.error) {
        if (pending?.method === "Target.createTarget") {
          clearUnresolvedTargetEvents(data);
        }
        socket.send(text);
        return;
      }

      try {
        if (pending.method === "Target.getTargets") {
          const targetInfos = Array.isArray(message.result?.targetInfos)
            ? message.result.targetInfos.filter((value) => {
              const targetId = targetIdFromInfo(value);
              return Boolean(targetId && controller.ownsTarget(targetId));
            })
            : [];
          socket.send(JSON.stringify({ ...message, result: { ...message.result, targetInfos } }));
          return;
        }
        if (pending.method === "Target.getBrowserContexts") {
          const browserContextIds = Array.isArray(message.result?.browserContextIds)
            ? message.result.browserContextIds.filter((value) =>
              typeof value === "string" && ownedBrowserContexts.has(value)
            )
            : [];
          socket.send(JSON.stringify({ ...message, result: { ...message.result, browserContextIds } }));
          return;
        }
        if (pending.method === "Target.createBrowserContext") {
          const browserContextId = typeof message.result?.browserContextId === "string"
            ? message.result.browserContextId
            : null;
          if (!browserContextId) {
            throw new Error("Target.createBrowserContext returned no browser context id");
          }
          ownedBrowserContexts.add(browserContextId);
        }
        if (pending.method === "Target.disposeBrowserContext") {
          const browserContextId = typeof pending.params.browserContextId === "string"
            ? pending.params.browserContextId
            : null;
          if (browserContextId) {
            ownedBrowserContexts.delete(browserContextId);
          }
        }
        if (pending.method === "Target.createTarget") {
          const targetId = typeof message.result?.targetId === "string" ? message.result.targetId : null;
          if (!targetId) {
            throw new Error("Target.createTarget returned no target id");
          }
          const tab = await controller.claimTarget(targetId, pending.params.background !== true);
          data.visibleTargets.add(tab.targetId);
          const pendingEvents = data.pendingTargetEvents.get(targetId) ?? [];
          data.pendingTargetEvents.delete(targetId);
          for (const pendingEvent of pendingEvents) {
            await forwardUpstreamMessage(socket, data, pendingEvent);
          }
        }
        if (pending.method === "Target.attachToTarget") {
          const targetId = typeof pending.params.targetId === "string" ? pending.params.targetId : null;
          const sessionId = typeof message.result?.sessionId === "string" ? message.result.sessionId : null;
          if (targetId && sessionId) {
            data.sessionTargets.set(sessionId, targetId);
          }
        }
        socket.send(text);
      } catch (error) {
        sendError(socket, message.id, error);
      } finally {
        if (pending.method === "Target.createTarget") {
          clearUnresolvedTargetEvents(data);
        }
      }
      return;
    }

    const targetInfo = message.params?.targetInfo;
    const targetId = targetIdFromInfo(targetInfo) ?? targetIdFromParams(message.params);
    if (targetId && isTargetLifecycleEvent(message.method) && !controller.ownsTarget(targetId)) {
      const openerId = openerIdFromInfo(targetInfo);
      if (openerId && controller.ownsTarget(openerId)) {
        await controller.claimTarget(targetId, true).catch(() => {});
      }
      if (!controller.ownsTarget(targetId)) {
        if (message.method === "Target.targetDestroyed") {
          data.pendingTargetEvents.delete(targetId);
        } else if (hasPendingTargetCreation(data)) {
          const events = data.pendingTargetEvents.get(targetId) ?? [];
          events.push(text);
          data.pendingTargetEvents.set(targetId, events);
        } else if (message.method === "Target.attachedToTarget") {
          resumeAndDetachForeignTarget(data, message);
        }
        return;
      }
    }
    if (message.method === "Target.targetCreated" && targetId) {
      data.visibleTargets.add(targetId);
    }
    if (message.method === "Target.targetInfoChanged" && targetId) {
      if (!controller.ownsTarget(targetId) && !data.visibleTargets.has(targetId)) {
        return;
      }
    }
    if (message.method === "Target.targetDestroyed" && targetId) {
      if (!data.visibleTargets.delete(targetId)) {
        return;
      }
    }
    if (message.method === "Target.attachedToTarget") {
      const sessionId = typeof message.params?.sessionId === "string" ? message.params.sessionId : null;
      if (!targetId || !sessionId || !controller.ownsTarget(targetId)) {
        return;
      }
      data.sessionTargets.set(sessionId, targetId);
    }
    if (message.method === "Target.detachedFromTarget") {
      const sessionId = typeof message.params?.sessionId === "string" ? message.params.sessionId : null;
      if (sessionId && !data.sessionTargets.delete(sessionId)) {
        return;
      }
    }
    if (message.sessionId && !data.sessionTargets.has(message.sessionId)) {
      return;
    }
    socket.send(text);
  }

  function requireOwnedTarget(targetId: string): void {
    if (!controller.ownsTarget(targetId)) {
      throw new Error(`target is not owned by browser view ${controller.viewId}: ${targetId}`);
    }
  }

  return {
    httpUrl: httpUrl(),
    browserWebSocketUrl: browserWebSocketUrl(),
    pageWebSocketUrl,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      for (const socket of sockets) {
        socket.close(1001, "browser view closed");
      }
      sockets.clear();
      await Promise.all([...ownedBrowserContexts].map((browserContextId) =>
        controller.disposeBrowserContext(browserContextId).catch(() => {})
      ));
      ownedBrowserContexts.clear();
      server.stop(true);
    },
  };
}

function forwardToUpstream(data: GatewaySocketData, text: string): void {
  const upstream = data.upstream;
  if (upstream?.readyState === WebSocket.OPEN) {
    upstream.send(text);
    return;
  }
  data.queued.push(text);
}

function sendResult(
  socket: GatewaySocket,
  id: number | undefined,
  result: Record<string, unknown>,
): void {
  if (id !== undefined) {
    socket.send(JSON.stringify({ id, result }));
  }
}

function sendError(
  socket: GatewaySocket,
  id: number | undefined,
  error: unknown,
): void {
  if (id !== undefined) {
    socket.send(JSON.stringify({
      id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    }));
  }
}

function parseMessage(text: string): CdpMessage | null {
  try {
    return JSON.parse(text) as CdpMessage;
  } catch {
    return null;
  }
}

function messageText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new TextDecoder().decode(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(value);
  }
  return String(value);
}

function requiredTargetId(params: Record<string, unknown>): string {
  if (typeof params.targetId !== "string" || !params.targetId) {
    throw new Error("missing targetId");
  }
  return params.targetId;
}

function isTargetLifecycleEvent(method: string | undefined): boolean {
  return method === "Target.targetCreated" ||
    method === "Target.targetInfoChanged" ||
    method === "Target.targetDestroyed" ||
    method === "Target.attachedToTarget";
}

function hasPendingTargetCreation(data: GatewaySocketData): boolean {
  return [...data.pending.values()].some((pending) => pending.method === "Target.createTarget");
}

function clearUnresolvedTargetEvents(data: GatewaySocketData): void {
  if (!hasPendingTargetCreation(data)) {
    for (const events of data.pendingTargetEvents.values()) {
      for (const event of events) {
        const message = parseMessage(event);
        if (message?.method === "Target.attachedToTarget") {
          resumeAndDetachForeignTarget(data, message);
        }
      }
    }
    data.pendingTargetEvents.clear();
  }
}

function resumeAndDetachForeignTarget(data: GatewaySocketData, message: CdpMessage): void {
  const sessionId = typeof message.params?.sessionId === "string"
    ? message.params.sessionId
    : null;
  if (!sessionId) {
    return;
  }
  sendInternalCommand(data, "Runtime.runIfWaitingForDebugger", {}, sessionId);
  sendInternalCommand(data, "Target.detachFromTarget", { sessionId });
}

function sendInternalCommand(
  data: GatewaySocketData,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
): void {
  const id = data.nextInternalRequestId++;
  data.internalRequestIds.add(id);
  const message: CdpMessage = { id, method, params };
  if (sessionId) {
    message.sessionId = sessionId;
  }
  forwardToUpstream(data, JSON.stringify(message));
}

function targetIdFromInfo(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const targetId = (value as { targetId?: unknown }).targetId;
  return typeof targetId === "string" ? targetId : null;
}

function openerIdFromInfo(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const openerId = (value as { openerId?: unknown }).openerId;
  return typeof openerId === "string" ? openerId : null;
}

function targetIdFromParams(params: Record<string, unknown> | undefined): string | null {
  const targetId = params?.targetId;
  return typeof targetId === "string" ? targetId : null;
}

function pageTargetFromPath(pathname: string): string | null {
  return targetIdFromHttpPath(pathname, "/devtools/page/");
}

function isBrowserSocketPath(pathname: string): boolean {
  return pathname.startsWith("/devtools/browser/");
}

function targetIdFromHttpPath(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const value = pathname.slice(prefix.length);
  return value ? decodeURIComponent(value) : null;
}

function normalizedPath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

function webSocketOrigin(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
}

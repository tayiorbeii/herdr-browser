import { afterEach, describe, expect, test } from "bun:test";

import { CdpClient } from "./cdp";
import {
  startCdpViewGateway,
  type CdpViewGateway,
  type CdpViewGatewayController,
} from "./cdpGateway";
import type { BrowserTabInfo } from "./browser";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

describe("view-scoped CDP gateway", () => {
  test("filters discovery and synchronizes create, activate, and close", async () => {
    const upstream = fakeCdpServer();
    cleanups.push(() => upstream.stop(true));
    const owned = new Set(["owned-1"]);
    const tabs = new Map<string, BrowserTabInfo>([
      ["owned-1", tab("owned-1", true)],
    ]);
    const activated: string[] = [];
    const closed: string[] = [];
    const disposedContexts: string[] = [];
    const controller = fakeController(upstream, owned, tabs, activated, closed, disposedContexts);
    const gateway = await startCdpViewGateway(controller);
    cleanups.push(gateway.close);
    const client = await CdpClient.connect(gateway.browserWebSocketUrl);
    cleanups.push(() => client.close());

    const discovered = await client.send<{ targetInfos: Array<{ targetId: string }> }>("Target.getTargets");
    expect(discovered.targetInfos.map((target) => target.targetId)).toEqual(["owned-1"]);

    const autoAttached = client.waitFor("Target.attachedToTarget");
    const created = await client.send<{ targetId: string }>("Target.createTarget", {
      url: "https://example.com",
    });
    await expect(autoAttached).resolves.toMatchObject({ sessionId: "auto-session" });
    expect(created.targetId).toBe("external-new");
    expect(owned.has("external-new")).toBe(true);
    expect(activated).toContain("external-new");
    await expect(client.send("Runtime.evaluate", {
      expression: "1",
    }, "auto-session")).resolves.toEqual({});
    expect(upstream.receivedMethods).not.toContain("Runtime.runIfWaitingForDebugger");

    await client.send("Target.activateTarget", { targetId: "owned-1" });
    expect(activated.at(-1)).toBe("owned-1");

    const attached = await client.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: "external-new",
      flatten: true,
    });
    await client.send("Page.bringToFront", {}, attached.sessionId);
    expect(activated.at(-1)).toBe("external-new");

    const result = await client.send<{ success: boolean }>("Target.closeTarget", {
      targetId: "external-new",
    });
    expect(result.success).toBe(true);
    expect(closed).toEqual(["external-new"]);

    const context = await client.send<{ browserContextId: string }>("Target.createBrowserContext");
    expect(context.browserContextId).toBe("owned-context");
    const contexts = await client.send<{ browserContextIds: string[] }>("Target.getBrowserContexts");
    expect(contexts.browserContextIds).toEqual(["owned-context"]);
    await expect(client.send("Target.disposeBrowserContext", {
      browserContextId: "foreign-context",
    })).rejects.toThrow("browser context is not owned by browser view view-a");

    await client.send("Target.setAutoAttach", {
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: true,
    });
    await tick();
    expect(upstream.receivedMethods).toContain("Runtime.runIfWaitingForDebugger");
    expect(upstream.receivedMethods).toContain("Target.detachFromTarget");

    await expect(client.send("Browser.close")).resolves.toEqual({});
    await gateway.close();
    expect(disposedContexts).toEqual(["owned-context"]);
  });

  test("rejects cross-view target access and exposes only owned HTTP targets", async () => {
    const upstream = fakeCdpServer();
    cleanups.push(() => upstream.stop(true));
    const owned = new Set(["owned-1"]);
    const tabs = new Map([["owned-1", tab("owned-1", true)]]);
    const gateway = await startCdpViewGateway(fakeController(upstream, owned, tabs, [], []));
    cleanups.push(gateway.close);

    const response = await fetch(`${gateway.httpUrl}/json/list`);
    const targets = await response.json() as Array<{
      id: string;
      webSocketDebuggerUrl: string;
      devtoolsFrontendUrl: string;
    }>;
    expect(targets.map((target) => target.id)).toEqual(["owned-1"]);
    expect(targets[0]?.webSocketDebuggerUrl).toBe(gateway.pageWebSocketUrl("owned-1"));
    expect(targets[0]?.devtoolsFrontendUrl).toBe(
      `/devtools/inspector.html?ws=127.0.0.1:${new URL(gateway.httpUrl).port}/devtools/page/owned-1`,
    );
    expect((await fetch(`${gateway.httpUrl}/json/version/`)).status).toBe(200);

    const client = await CdpClient.connect(gateway.browserWebSocketUrl);
    cleanups.push(() => client.close());
    await expect(client.send("Target.attachToTarget", {
      targetId: "foreign-1",
      flatten: true,
    })).rejects.toThrow("target is not owned by browser view view-a");

    await expect(client.send("Browser.getBrowserCommandLine")).rejects.toThrow(
      "browser-wide CDP method is not available through a view-scoped gateway",
    );

    await expect(client.send("Runtime.evaluate", {
      expression: "1",
    }, "foreign-session")).rejects.toThrow("CDP session is not owned by browser view view-a");

    const page = await CdpClient.connect(gateway.pageWebSocketUrl("owned-1"));
    cleanups.push(() => page.close());
    await page.send("Page.close");
    expect(owned.has("owned-1")).toBe(false);
  });

  test("releases buffered auto-attached sessions when target claiming fails", async () => {
    const upstream = fakeCdpServer({ emitForeignDuringCreate: true });
    cleanups.push(() => upstream.stop(true));
    const owned = new Set(["owned-1"]);
    const tabs = new Map([["owned-1", tab("owned-1", true)]]);
    const controller = fakeController(upstream, owned, tabs, [], []);
    controller.claimTarget = async () => {
      throw new Error("claim failed");
    };
    const gateway = await startCdpViewGateway(controller);
    cleanups.push(gateway.close);
    const client = await CdpClient.connect(gateway.browserWebSocketUrl);
    cleanups.push(() => client.close());

    await expect(client.send("Target.createTarget", { url: "about:blank" }))
      .rejects.toThrow("claim failed");
    await tick();

    expect(upstream.receivedMethods).toContain("Runtime.runIfWaitingForDebugger");
    expect(upstream.receivedMethods).toContain("Target.detachFromTarget");
  });
});

function fakeController(
  upstream: ReturnType<typeof fakeCdpServer>,
  owned: Set<string>,
  tabs: Map<string, BrowserTabInfo>,
  activated: string[],
  closed: string[],
  disposedContexts: string[] = [],
): CdpViewGatewayController {
  return {
    viewId: "view-a",
    cdpHttpUrl: `http://127.0.0.1:${upstream.port}`,
    browserWebSocketUrl: `ws://127.0.0.1:${upstream.port}/devtools/browser/fake`,
    listTabs: async () => [...tabs.values()],
    ownsTarget: (targetId) => owned.has(targetId),
    claimTarget: async (targetId, activate) => {
      owned.add(targetId);
      const claimed = tab(targetId, activate);
      tabs.set(targetId, claimed);
      if (activate) {
        activated.push(targetId);
      }
      return claimed;
    },
    activateTarget: async (targetId) => {
      activated.push(targetId);
      return tabs.get(targetId) ?? tab(targetId, true);
    },
    closeTarget: async (targetId) => {
      closed.push(targetId);
      owned.delete(targetId);
      tabs.delete(targetId);
      return tabs.values().next().value ?? tab("replacement", true);
    },
    createTarget: async (url) => {
      const created = { ...tab("http-new", true), url };
      owned.add(created.targetId);
      tabs.set(created.targetId, created);
      return created;
    },
    disposeBrowserContext: async (browserContextId) => {
      disposedContexts.push(browserContextId);
    },
  };
}

function fakeCdpServer(options: { emitForeignDuringCreate?: boolean } = {}) {
  const receivedMethods: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (request.headers.get("upgrade") === "websocket" && server.upgrade(request)) {
        return;
      }
      if (new URL(request.url).pathname === "/json/protocol") {
        return Response.json({ version: { major: "1", minor: "3" }, domains: [] });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as {
          id: number;
          method: string;
        };
        receivedMethods.push(message.method);
        if (message.method === "Target.getTargets") {
          socket.send(JSON.stringify({
            id: message.id,
            result: {
              targetInfos: [
                { targetId: "owned-1", type: "page", title: "Owned", url: "about:blank" },
                { targetId: "foreign-1", type: "page", title: "Foreign", url: "about:blank" },
              ],
            },
          }));
          return;
        }
        if (message.method === "Target.createTarget") {
          socket.send(JSON.stringify({
            method: "Target.targetCreated",
            params: {
              targetInfo: {
                targetId: "external-new",
                type: "page",
                title: "",
                url: "https://example.com",
              },
            },
          }));
          socket.send(JSON.stringify({
            method: "Target.attachedToTarget",
            params: {
              sessionId: "auto-session",
              targetInfo: {
                targetId: "external-new",
                type: "page",
                title: "",
                url: "https://example.com",
              },
              waitingForDebugger: false,
            },
          }));
          if (options.emitForeignDuringCreate) {
            socket.send(JSON.stringify({
              method: "Target.attachedToTarget",
              params: {
                sessionId: "foreign-during-create",
                targetInfo: {
                  targetId: "foreign-1",
                  type: "page",
                  title: "Foreign",
                  url: "about:blank",
                },
                waitingForDebugger: true,
              },
            }));
          }
          socket.send(JSON.stringify({ id: message.id, result: { targetId: "external-new" } }));
          return;
        }
        if (message.method === "Target.attachToTarget") {
          socket.send(JSON.stringify({ id: message.id, result: { sessionId: "external-session" } }));
          return;
        }
        if (message.method === "Target.createBrowserContext") {
          socket.send(JSON.stringify({
            id: message.id,
            result: { browserContextId: "owned-context" },
          }));
          return;
        }
        if (message.method === "Target.getBrowserContexts") {
          socket.send(JSON.stringify({
            id: message.id,
            result: { browserContextIds: ["owned-context", "foreign-context"] },
          }));
          return;
        }
        if (message.method === "Target.setAutoAttach") {
          socket.send(JSON.stringify({
            method: "Target.attachedToTarget",
            params: {
              sessionId: "foreign-auto-session",
              targetInfo: {
                targetId: "foreign-1",
                type: "page",
                title: "Foreign",
                url: "about:blank",
              },
              waitingForDebugger: true,
            },
          }));
        }
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      },
    },
  });
  return Object.assign(server, { receivedMethods });
}

function tab(targetId: string, active: boolean): BrowserTabInfo {
  return {
    targetId,
    active,
    title: targetId,
    url: "about:blank",
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

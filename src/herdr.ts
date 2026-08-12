import { spawnSync } from "node:child_process";

import { applyBrowserConfigEnv, type BrowserPluginConfig } from "./config";
import { configuredGraphicsTransport } from "./graphicsTransport";

export type PaneOpenResult = {
  attempted: boolean;
  ok: boolean;
  reason?: string;
  stdout?: string;
  stderr?: string;
};

export function openBrowserPane(
  config: BrowserPluginConfig,
  viewId?: string,
  daemonState?: string,
): PaneOpenResult {
  const herdr = process.env.HERDR_BIN_PATH;
  if (!herdr) {
    return {
      attempted: false,
      ok: false,
      reason: "HERDR_BIN_PATH is not set",
    };
  }

  const args = browserPaneArgs(config, viewId, daemonState);

  const result = spawnSync(herdr, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return {
    attempted: true,
    ok: result.status === 0,
    reason: result.error?.message,
    stdout: result.stdout.trim() || undefined,
    stderr: result.stderr.trim() || undefined,
  };
}

export function browserPaneArgs(
  config: BrowserPluginConfig,
  viewId?: string,
  daemonState?: string,
): string[] {
  const args = [
    "plugin",
    "pane",
    "open",
    "--plugin",
    process.env.HERDR_PLUGIN_ID ?? "official.browser",
    "--entrypoint",
    "browser",
    "--placement",
    config.linkOpenPlacement,
  ];

  if (config.linkOpenPlacement === "split") {
    args.push("--direction", config.splitDirection);
  }
  const paneEnv: NodeJS.ProcessEnv = {};
  applyBrowserConfigEnv(config, paneEnv);
  for (const [key, value] of Object.entries(paneEnv)) {
    if (value !== undefined) {
      args.push("--env", `${key}=${value}`);
    }
  }
  args.push("--env", `HERDR_BROWSER_TRANSPORT=${configuredGraphicsTransport()}`);
  if (daemonState) {
    args.push("--env", `HERDR_BROWSER_DAEMON_STATE=${daemonState}`);
  }
  if (viewId) {
    args.push("--env", `HERDR_BROWSER_VIEW_ID=${viewId}`);
  }
  args.push(config.focusOnOpen ? "--focus" : "--no-focus");
  return args;
}

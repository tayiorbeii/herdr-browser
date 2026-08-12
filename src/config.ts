import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { projectRoot } from "./paths";
import {
  DEFAULT_BROWSER_ZOOM,
  validBrowserZoom,
} from "./browserZoom";
import {
  DEFAULT_CAPTURE_BACKEND,
  DEFAULT_CAPTURE_SCALE,
  parseCaptureBackend,
  validCaptureScale,
  type CaptureBackend,
} from "./captureBackend";
import { DEFAULT_SCREENCAST_POLL_MS, validScreencastPollMs } from "./screencastPoll";
import {
  DEFAULT_SCREENCAST_EVERY_NTH_FRAME,
  validScreencastEveryNthFrame,
} from "./screencastCadence";
import { SerialQueue } from "./serialQueue";

export type BrowserPluginConfig = {
  linkOpenPlacement: "split" | "overlay" | "tab" | "zoomed";
  splitDirection: "right" | "down";
  focusOnOpen: boolean;
  showDiagnostics: boolean;
  browserZoom: number;
  captureBackend: CaptureBackend;
  captureScale: number;
  screencastEveryNthFrame: 1 | 2;
  screencastPollMs: number;
  profileRoot: string | null;
  displayMode?: "headless" | "headful";
};

const DEFAULT_CONFIG: BrowserPluginConfig = {
  linkOpenPlacement: "split",
  splitDirection: "right",
  focusOnOpen: true,
  showDiagnostics: false,
  browserZoom: DEFAULT_BROWSER_ZOOM,
  captureBackend: DEFAULT_CAPTURE_BACKEND,
  captureScale: DEFAULT_CAPTURE_SCALE,
  screencastEveryNthFrame: DEFAULT_SCREENCAST_EVERY_NTH_FRAME,
  screencastPollMs: DEFAULT_SCREENCAST_POLL_MS,
  profileRoot: null,
};
const configWriteQueue = new SerialQueue();

export async function loadConfig(): Promise<BrowserPluginConfig> {
  const path = configPath();
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return { ...DEFAULT_CONFIG };
  }

  return normalizeConfig(raw);
}

export function normalizeConfig(raw: unknown): BrowserPluginConfig {
  if (typeof raw !== "object" || raw === null) {
    return { ...DEFAULT_CONFIG };
  }
  const source = raw as Record<string, unknown>;
  return {
    linkOpenPlacement: parsePlacement(source.linkOpenPlacement),
    splitDirection: parseDirection(source.splitDirection),
    focusOnOpen: typeof source.focusOnOpen === "boolean"
      ? source.focusOnOpen
      : DEFAULT_CONFIG.focusOnOpen,
    showDiagnostics: typeof source.showDiagnostics === "boolean"
      ? source.showDiagnostics
      : DEFAULT_CONFIG.showDiagnostics,
    browserZoom: configuredBrowserZoom(source),
    captureBackend: parseCaptureBackend(source.captureBackend),
    captureScale: validCaptureScale(source.captureScale)
      ? source.captureScale
      : DEFAULT_CONFIG.captureScale,
    screencastEveryNthFrame: validScreencastEveryNthFrame(source.screencastEveryNthFrame)
      ? source.screencastEveryNthFrame
      : DEFAULT_CONFIG.screencastEveryNthFrame,
    screencastPollMs: validScreencastPollMs(source.screencastPollMs)
      ? source.screencastPollMs
      : DEFAULT_CONFIG.screencastPollMs,
    profileRoot: typeof source.profileRoot === "string" && source.profileRoot.trim().length > 0
      ? source.profileRoot.trim()
      : DEFAULT_CONFIG.profileRoot,
    ...(source.displayMode === "headful" ? { displayMode: "headful" as const } : {}),
  };
}

export function applyBrowserConfigEnv(
  config: BrowserPluginConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  env.HERDR_BROWSER_CAPTURE_BACKEND = config.captureBackend;
  env.HERDR_BROWSER_CAPTURE_SCALE = String(config.captureScale);
  env.HERDR_BROWSER_SCREENCAST_EVERY_NTH_FRAME = String(config.screencastEveryNthFrame);
  env.HERDR_BROWSER_SCREENCAST_POLL_MS = String(config.screencastPollMs);
  if (config.profileRoot) {
    env.HERDR_BROWSER_PROFILE_ROOT = config.profileRoot;
  } else {
    delete env.HERDR_BROWSER_PROFILE_ROOT;
  }
  env.HERDR_BROWSER_DISPLAY = config.displayMode ?? "headless";
}

export function saveBrowserZoom(
  browserZoom: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!validBrowserZoom(browserZoom)) {
    return Promise.reject(new Error(`invalid browser zoom: ${browserZoom}`));
  }
  return configWriteQueue.run(async () => await writeBrowserZoom(browserZoom, env));
}

async function writeBrowserZoom(
  browserZoom: number,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const path = configPath(env);
  let source: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      source = { ...raw as Record<string, unknown> };
    }
  } catch {
    // A missing or invalid config is replaced with the persisted preference.
  }
  source.browserZoom = browserZoom;
  delete source.uiScale;
  delete source.deviceScaleFactor;

  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(source, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

function configuredBrowserZoom(source: Record<string, unknown>): number {
  if (validBrowserZoom(source.browserZoom)) {
    return source.browserZoom;
  }
  if (validBrowserZoom(source.uiScale)) {
    return source.uiScale;
  }
  return validBrowserZoom(source.deviceScaleFactor)
    ? source.deviceScaleFactor
    : DEFAULT_CONFIG.browserZoom;
}

function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HERDR_BROWSER_CONFIG) {
    return env.HERDR_BROWSER_CONFIG;
  }
  if (env.HERDR_PLUGIN_CONFIG_DIR) {
    return join(env.HERDR_PLUGIN_CONFIG_DIR, "browser.json");
  }
  return join(projectRoot(), ".herdr-browser", "config.json");
}

function parsePlacement(value: unknown): BrowserPluginConfig["linkOpenPlacement"] {
  if (
    value === "split" ||
    value === "overlay" ||
    value === "tab" ||
    value === "zoomed"
  ) {
    return value;
  }
  return DEFAULT_CONFIG.linkOpenPlacement;
}

function parseDirection(value: unknown): BrowserPluginConfig["splitDirection"] {
  if (value === "right" || value === "down") {
    return value;
  }
  return DEFAULT_CONFIG.splitDirection;
}

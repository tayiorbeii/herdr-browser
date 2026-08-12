import { chmod, mkdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function projectRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

export type DaemonStateDiagnostics = {
  path: string;
  stateDir: string;
  source: "override" | "plugin" | "standalone";
  session: string | null;
  profileDir: string;
};

export function daemonStateFile(env: NodeJS.ProcessEnv = process.env): string {
  return daemonStateDiagnostics(env).path;
}

/** Safe, non-secret information useful when a CLI and plugin disagree about state. */
export function daemonStateDiagnostics(
  env: NodeJS.ProcessEnv = process.env,
): DaemonStateDiagnostics {
  const override = env.HERDR_BROWSER_DAEMON_STATE?.trim();
  const stateDir = browserStateDir(env);
  const session = env.HERDR_SESSION?.trim() || null;
  const path = override || (session
    ? join(stateDir, `daemon-${safeFilenamePart(session)}.json`)
    : join(stateDir, "daemon.json"));
  return {
    path,
    stateDir,
    source: override ? "override" : env.HERDR_PLUGIN_STATE_DIR || env.HERDR_ENV === "1" ? "plugin" : "standalone",
    session,
    profileDir: chromeProfileDir(env),
  };
}

function herdrPluginStateDir(env: NodeJS.ProcessEnv): string {
  const herdrStateDir = env.XDG_STATE_HOME?.trim()
    ? join(env.XDG_STATE_HOME.trim(), "herdr")
    : join(homedir(), ".local", "state", "herdr");
  return join(herdrStateDir, "plugins", "official.browser");
}

export function chromeProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  const configuredRoot = env.HERDR_BROWSER_PROFILE_ROOT?.trim();
  const root = configuredRoot
    ? resolve(configuredRoot)
    : join(browserStateDir(env), "chrome-profiles");
  const session = safeFilenamePart(env.HERDR_SESSION?.trim() || "default");
  return join(root, session);
}

function browserStateDir(env: NodeJS.ProcessEnv): string {
  return env.HERDR_PLUGIN_STATE_DIR || (
    env.HERDR_ENV === "1" ? herdrPluginStateDir(env) : standaloneStateDir(env)
  );
}

function standaloneStateDir(env: NodeJS.ProcessEnv): string {
  return join(
    env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state"),
    "herdr-browser",
  );
}

function safeFilenamePart(value: string): string {
  const prefix = value
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 48) || "session";
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${prefix}-${hash}`;
}

export async function ensurePrivateParentDir(path: string): Promise<void> {
  await ensurePrivateDir(dirname(path));
}

export async function ensurePrivateDir(path: string): Promise<void> {
  const existed = await exists(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const pathStat = await stat(path);
  if (!pathStat.isDirectory()) {
    throw new Error(`state path is not a directory: ${path}`);
  }
  if (!existed && (!process.getuid || pathStat.uid === process.getuid())) {
    await chmod(path, 0o700);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function daemonScriptPath(): string {
  return join(projectRoot(), "src", "daemon.ts");
}

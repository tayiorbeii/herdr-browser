import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createServer } from "node:net";
import type { Readable } from "node:stream";

import { chromeProfileDir, ensurePrivateDir } from "./paths";

const CHROME_CANDIDATES = [
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
  "chrome",
];

export type ChromeInstance = {
  executable: string;
  port: number;
  profileDir: string;
  process: ChromeProcess;
  browserWebSocketUrl: string;
  /** Recent stderr lines kept for crash diagnostics; bounded, not the full history. */
  recentStderr: () => string;
  close: () => Promise<void>;
};

type ChromeProcess = ChildProcessByStdio<null, null, Readable>;

const STDERR_RING_BUFFER_MAX_LINES = 20;

export async function launchChrome(): Promise<ChromeInstance> {
  const executable = await findChromeExecutable();
  const displayMode = process.env.HERDR_BROWSER_DISPLAY === "headful" ? "headful" : "headless";
  if (displayMode === "headful" && process.platform === "linux" &&
      !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error(
      "headful Chrome requires DISPLAY or WAYLAND_DISPLAY on Linux; set HERDR_BROWSER_DISPLAY=headless or start a graphical session",
    );
  }
  const port = await findFreePort();
  const profileDir = chromeProfileDir();
  await ensurePrivateDir(profileDir);
  const chromeArgs = [
    ...(displayMode === "headless" ? ["--headless=new"] : []),
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-client-side-phishing-detection",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    // ElasticOverscroll: macOS trackpad momentum keeps delivering wheel notches
    // for ~2s after the fingers lift. At a scroll boundary each one rubber-bands
    // the page, which is a repaint with scrollY pinned, so the pane visibly
    // jitters while nothing is actually scrolling.
    "--disable-features=Translate,ElasticOverscroll",
    "--disable-hang-monitor",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    // Synthetic CDP wheel events carry non-precise deltas, so Chromium smooth-
    // scroll animates each one. A terminal delivers scrolling as a stream of
    // fixed notches; overlapping per-notch animations rubber-band visibly at
    // scroll boundaries. Instant application matches trackpad expectations.
    "--disable-smooth-scrolling",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    "about:blank",
  ];
  const chrome = spawn(executable, chromeArgs, {
    stdio: ["ignore", "ignore", "pipe"],
  });

  async function close() {
    if (!chrome.killed && !hasChromeExited(chrome)) {
      chrome.kill("SIGTERM");
    }
    if (await waitForChromeExit(chrome, 1_500)) {
      return;
    }
    chrome.kill("SIGKILL");
    if (!await waitForChromeExit(chrome, 5_000)) {
      throw new Error(`Chrome did not exit and may still hold profile lock: ${profileDir}`);
    }
  }

  let browserWebSocketUrl: string;
  try {
    browserWebSocketUrl = await waitForBrowserWebSocketUrl(port, chrome);
  } catch (error) {
    await close();
    throw error;
  }

  // The startup accumulator is detached once Chrome is up; this ring buffer
  // takes over so stderr doesn't grow unboundedly for the daemon's lifetime
  // while still keeping recent lines for crash diagnostics.
  const stderrRing = createStderrRingBuffer(STDERR_RING_BUFFER_MAX_LINES);
  chrome.stderr.on("data", (chunk: Buffer) => stderrRing.append(chunk.toString()));

  return {
    executable,
    port,
    profileDir,
    process: chrome,
    browserWebSocketUrl,
    recentStderr: () => stderrRing.snapshot(),
    close,
  };
}

function createStderrRingBuffer(maxLines: number): { append: (chunk: string) => void; snapshot: () => string } {
  const lines: string[] = [];
  let partial = "";
  return {
    append(chunk: string) {
      partial += chunk;
      const segments = partial.split("\n");
      partial = segments.pop() ?? "";
      for (const line of segments) {
        lines.push(line);
        if (lines.length > maxLines) {
          lines.shift();
        }
      }
    },
    snapshot() {
      return [...lines, ...(partial ? [partial] : [])].join("\n");
    },
  };
}

async function waitForChromeExit(chrome: ChromeProcess, timeoutMs: number): Promise<boolean> {
  if (hasChromeExited(chrome)) {
    return true;
  }
  return await new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      chrome.off("exit", onExit);
      resolve(hasChromeExited(chrome));
    }, timeoutMs);
    chrome.once("exit", onExit);
  });
}

export function hasChromeExited(
  chrome: Pick<ChromeProcess, "exitCode" | "signalCode">,
): boolean {
  return chrome.exitCode !== null || chrome.signalCode !== null;
}

async function findChromeExecutable(): Promise<string> {
  if (process.env.HERDR_BROWSER_CHROME) {
    return process.env.HERDR_BROWSER_CHROME;
  }

  if (process.platform === "darwin") {
    const applicationExecutables = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      join(homedir(), "Applications/Chromium.app/Contents/MacOS/Chromium"),
    ];
    for (const executable of applicationExecutables) {
      try {
        await access(executable);
        return executable;
      } catch {
        // Try the next standard application location.
      }
    }
  }

  for (const candidate of CHROME_CANDIDATES) {
    const result = Bun.spawnSync(["which", candidate], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode === 0) {
      const path = new TextDecoder().decode(result.stdout).trim();
      if (path.length > 0) {
        return path;
      }
    }
  }

  throw new Error(
    "could not find Chrome/Chromium; set HERDR_BROWSER_CHROME to the executable path",
  );
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close();
      if (address && typeof address === "object") {
        resolve(address.port);
      } else {
        reject(new Error("failed to allocate a local port"));
      }
    });
    server.on("error", reject);
  });
}

async function waitForBrowserWebSocketUrl(
  port: number,
  chrome: ChromeProcess,
): Promise<string> {
  let stderr = "";
  const onData = (chunk: Buffer) => {
    stderr += chunk.toString();
  };
  chrome.stderr.on("data", onData);

  try {
    const started = Date.now();
    while (Date.now() - started < 10_000) {
      if (hasChromeExited(chrome)) {
        throw new Error(`Chrome exited early: ${stderr.trim()}`);
      }

      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) {
          const body = await response.json() as { webSocketDebuggerUrl?: string };
          if (body.webSocketDebuggerUrl) {
            return body.webSocketDebuggerUrl;
          }
        }
      } catch {
        // Chrome is still starting.
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`timed out waiting for Chrome CDP endpoint: ${stderr.trim()}`);
  } finally {
    // Startup accumulation stops here regardless of outcome; the caller
    // attaches a small ring buffer for ongoing crash diagnostics on success.
    chrome.stderr.off("data", onData);
  }
}

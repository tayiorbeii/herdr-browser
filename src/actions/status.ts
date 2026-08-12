#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { join } from "node:path";

import { health } from "../daemonClient";
import { daemonStateDiagnostics } from "../paths";

const pluginRoot = process.env.HERDR_PLUGIN_ROOT ?? process.cwd();
const cliPath = join(pluginRoot, "src", "cli.ts");

try {
  const daemon = await health();
  console.log(JSON.stringify({
    ok: true,
    state: daemonStateDiagnostics(),
    plugin_id: process.env.HERDR_PLUGIN_ID ?? null,
    plugin_root: pluginRoot,
    cli: existsSync(cliPath) ? `bun run ${cliPath}` : null,
    state_dir: process.env.HERDR_PLUGIN_STATE_DIR ?? null,
    config_dir: process.env.HERDR_PLUGIN_CONFIG_DIR ?? null,
    chrome_override: process.env.HERDR_BROWSER_CHROME ?? null,
    daemon,
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

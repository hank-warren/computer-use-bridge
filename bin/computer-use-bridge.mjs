#!/usr/bin/env node
// computer-use-bridge: let other MCP clients use this Mac's apps through open-computer-use
// and its browser tabs through open-browser-use, over stdio or bearer-authenticated HTTP.
//
//   computer-use-bridge setup [--host IP|tailscale|localhost] [--tunnel HOST[:PORT],...] [--port N] [--allow IDS] [--yes] [--no-service]
//   computer-use-bridge status [--config FILE]
//   computer-use-bridge stdio [--approve-all] [--config FILE]
//   computer-use-bridge serve [--config FILE]
//
// Clients get typed tools for apps and agent tabs; no client-supplied code runs on the Mac
// (eval_tab runs in the page with side effects refused), and every call is limited to the
// allowApps bundle IDs.

import { VERSION, log, say } from "../src/common.mjs";
import { USAGE, loadConfig, parseArgs } from "../src/config.mjs";
import { runHttp, runStdio } from "../src/server.mjs";
import { setup, status, update } from "../src/setup.mjs";

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.mode === "help") say(USAGE);
  else if (opts.mode === "version") say(VERSION);
  else if (opts.mode === "setup") { await setup(opts); process.exit(0); }
  else if (opts.mode === "status") process.exit(await status(opts));
  else if (opts.mode === "update") { await update(); process.exit(0); }
  else {
    const cfg = loadConfig(opts);
    if (opts.mode === "serve") runHttp(cfg);
    else runStdio(cfg);
  }
} catch (e) {
  log(e.message);
  process.exit(2);
}

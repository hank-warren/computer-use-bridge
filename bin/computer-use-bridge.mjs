#!/usr/bin/env node
// computer-use-bridge: lets remote MCP clients use this machine's apps (macOS, through
// open-computer-use or agent-desktop) and browser tabs (through open-browser-use), over
// bearer-authenticated HTTP or stdio. Clients get typed tools, an app allowlist and their own tabs;
// no client-supplied code runs here (eval_tab runs in the page with side effects refused).
// Run with no arguments for the commands.

import { VERSION, log, say } from "../src/common.mjs";
import { USAGE, loadConfig, parseArgs } from "../src/config.mjs";
import { clientInfo, connect } from "../src/connect.mjs";
import { runHttp, runStdio } from "../src/server.mjs";
import { setup, status, update } from "../src/setup.mjs";

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.mode === "help") say(USAGE);
  else if (opts.mode === "version") say(VERSION);
  else if (opts.mode === "setup") process.exit(await setup(opts));
  else if (opts.mode === "status") process.exit(await status(opts));
  else if (opts.mode === "update") process.exit(await update(opts));
  else if (opts.mode === "connect") process.exit(await connect(opts));
  else if (opts.mode === "client-info") process.exit(await clientInfo(opts));
  else {
    const cfg = loadConfig(opts);
    if (opts.mode === "serve") runHttp(cfg);
    else runStdio(cfg);
  }
} catch (e) {
  log(e.message);
  process.exit(2);
}

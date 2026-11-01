#!/usr/bin/env node
// computer-use-bridge: serves this machine's open-computer-use (macOS apps) and open-browser-use
// (browser tabs) MCP tools, unchanged, to remote clients over bearer-authenticated HTTP or stdio,
// with an app allowlist.
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

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { expand } from "../common.mjs";
import { McpChild } from "./mcp-child.mjs";

// The npm global bin directories a launchd or systemd service's short PATH may lack.
export const binDirs = () => [...(process.env.PATH ?? "").split(":"), dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".npm-global/bin")].filter(Boolean);
const find = (cmd) => binDirs().map((d) => join(d, cmd)).find((f) => existsSync(f)) ?? cmd;

// open-computer-use (github.com/iFurySt/open-computer-use): Codex's computer-use tools for macOS apps.
export const findOcu = (cfg = {}) => (cfg.ocuCommand ? expand(cfg.ocuCommand) : find("open-computer-use"));

export const ocuChild = (cfg, label) => new McpChild({
  name: "open-computer-use",
  command: findOcu(cfg),
  args: ["mcp"],
  env: { OPEN_COMPUTER_USE_VISUAL_CURSOR: cfg.ocuVisualCursor === true ? "1" : "0" },
  label,
  missing: 'open-computer-use not found; run "computer-use-bridge setup" or set ocuCommand in the config',
});

// open-browser-use (github.com/iFurySt/open-browser-use): browser tabs through its extension.
export const findObu = (cfg = {}) => (cfg.obuCommand ? expand(cfg.obuCommand) : find("open-browser-use"));

// sessionId keys the tab group, so each client session gets its own and keeps it across restarts.
export const obuChild = (cfg, label, sessionId) => new McpChild({
  name: "open-browser-use",
  command: findObu(cfg),
  args: ["mcp", "--session-id", sessionId, ...(cfg.obuSocket ? ["--socket", expand(cfg.obuSocket)] : [])],
  label,
  missing: 'open-browser-use not found; run "computer-use-bridge setup" or set obuCommand in the config',
});

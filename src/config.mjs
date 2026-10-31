import { existsSync, readFileSync } from "node:fs";
import { APPS_SUPPORTED, BROWSERS, DEFAULT_CONFIG, HARD_DENY, NAME, TABS_ONLY_HINT, expand } from "./common.mjs";

// ---------- configuration ----------

export const USAGE = `usage: ${NAME} <command>

  setup    configure the HTTP server for this Mac and start it (interactive)
           [--host IP|tailscale|localhost] [--tunnel HOST[:PORT],...] [--port N] [--allow ID,ID]
           [--yes] [--no-service]
  status   check the engine, the config and the running server
  update   upgrade through Homebrew and restart the service
  serve    run the HTTP server (what the Homebrew service runs)
  stdio    speak MCP on stdin/stdout, e.g. over SSH [--approve-all]
  version  print the version

All commands take --config FILE (default ${DEFAULT_CONFIG}).`;

export function parseArgs(argv) {
  let [mode, ...rest] = argv;
  if (mode === "--version" || mode === "-v") mode = "version";
  if (mode === "--help" || mode === "-h" || mode === undefined) mode = "help";
  const opts = { mode, approveAll: false, config: DEFAULT_CONFIG, yes: false, service: true };
  const value = (i) => {
    if (rest[i + 1] === undefined) throw new Error(`${rest[i]} needs a value`);
    return rest[i + 1];
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--approve-all" && mode === "stdio") opts.approveAll = true;
    else if (a === "--config") opts.config = value(i++);
    else if (mode === "setup" && a === "--host") opts.host = value(i++);
    else if (mode === "setup" && a === "--tunnel") opts.tunnel = value(i++);
    else if (mode === "setup" && a === "--port") opts.port = value(i++);
    else if (mode === "setup" && a === "--allow") opts.allow = value(i++);
    else if (mode === "setup" && (a === "--yes" || a === "-y")) opts.yes = true;
    else if (mode === "setup" && a === "--no-service") opts.service = false;
    else throw new Error(`unknown argument: ${a}\n\n${USAGE}`);
  }
  if (!["stdio", "serve", "setup", "status", "update", "version", "help"].includes(mode)) throw new Error(`unknown command: ${mode}\n\n${USAGE}`);
  return opts;
}

// A reverse tunnel: ssh is a host alias or user@host, as typed after `ssh`.
export function checkTunnel(t) {
  if (typeof t?.ssh !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,252}$/.test(t.ssh)) throw new Error(`tunnel ssh must be a host or user@host (got ${JSON.stringify(t?.ssh)})`);
  if (!Number.isInteger(t.remotePort) || t.remotePort < 1024 || t.remotePort > 65535) throw new Error(`tunnel ${t.ssh}: remotePort must be 1024-65535`);
  return { ssh: t.ssh, remotePort: t.remotePort };
}

export function loadConfig(opts) {
  const file = expand(opts.config);
  const cfg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  if (opts.mode === "serve") {
    if (!cfg.host || !cfg.port || !cfg.tokenFile) throw new Error(`${file} needs host, port and tokenFile; run "${NAME} setup"`);
    if (cfg.approve === "all") throw new Error("serve only supports the allowlist");
    cfg.tunnels = (cfg.tunnels ?? []).map(checkTunnel);
    cfg.approve = "allowlist";
  } else {
    cfg.approve = opts.approveAll ? "all" : "allowlist";
  }
  cfg.allowApps = (cfg.allowApps ?? []).filter((id) => !HARD_DENY.has(id.toLowerCase()));
  const allowed = new Set(cfg.allowApps.map((id) => id.toLowerCase()));
  cfg.isAllowed = (id) => cfg.approve === "all" || (typeof id === "string" && allowed.has(id.toLowerCase()));
  cfg.appsOn = APPS_SUPPORTED;
  if (!cfg.appsOn && !BROWSERS.some(cfg.isAllowed)) throw new Error(`${file}: ${TABS_ONLY_HINT}`);
  cfg.idleMinutes ??= 30;
  cfg.maxSessions ??= 4;
  cfg.engineIdleMinutes ??= 10;
  if (cfg.engine !== undefined && cfg.engine !== "open-computer-use") {
    throw new Error(`engine "${cfg.engine}" is no longer supported: 0.5 runs only on open-computer-use; remove "engine" from ${file}`);
  }
  if (typeof cfg.engineIdleMinutes !== "number" || !(cfg.engineIdleMinutes >= 0)) throw new Error("engineIdleMinutes must be a number >= 0 (0 disables)");
  return cfg;
}

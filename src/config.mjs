import { existsSync, readFileSync } from "node:fs";
import { APPS_SUPPORTED, DEFAULT_CONFIG, HARD_DENY, NAME, expand } from "./common.mjs";

export const APP_ENGINES = ["open-computer-use", "agent-desktop"];
export const TAB_ENGINES = ["open-browser-use"];
// Browsers open-browser-use runs in, by the name the config uses.
export const BROWSER_IDS = { brave: "com.brave.Browser", chrome: "com.google.Chrome" };

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

// 0.x configs turned tabs on by listing a browser in allowApps; 1.0 has explicit apps and tabs.
export function migrateConfig(raw, appsSupported = APPS_SUPPORTED) {
  if (raw.apps !== undefined || raw.tabs !== undefined || raw.allowApps === undefined) return { cfg: raw, migrated: false };
  const cfg = { ...raw };
  const allow = cfg.allowApps;
  const has = (id) => allow.some((x) => x.toLowerCase() === id.toLowerCase());
  const browser = Object.keys(BROWSER_IDS).find((b) => has(BROWSER_IDS[b]));
  cfg.apps = appsSupported ? { engine: cfg.appEngine ?? "open-computer-use", allow } : { engine: "off" };
  cfg.tabs = browser ? { engine: "open-browser-use", browser } : { engine: "off" };
  delete cfg.allowApps;
  delete cfg.appEngine;
  if (cfg.engine === "open-computer-use") delete cfg.engine;
  return { cfg, migrated: true };
}

const oneOf = (v, list, what) => {
  if (!list.includes(v)) throw new Error(`${what} must be ${list.join(" or ")} (got ${JSON.stringify(v)})`);
  return v;
};

// Validates a config (either version) and adds the derived fields the server uses:
// appsOn, tabsOn, allowApps, isAllowed(id), appEngine and appEngineFor(id).
export function normalizeConfig(raw, { file = "config", approveAll = false, appsSupported = APPS_SUPPORTED } = {}) {
  const { cfg } = migrateConfig(structuredClone(raw), appsSupported);
  if (cfg.engine !== undefined) throw new Error(`${file}: "engine" is no longer supported; remove it and set apps.engine`);
  const apps = { engine: "off", allow: [], engineFor: {}, ...cfg.apps };
  const tabs = { engine: "off", browser: "brave", ...cfg.tabs };
  oneOf(apps.engine, [...APP_ENGINES, "off"], "apps.engine");
  oneOf(tabs.engine, [...TAB_ENGINES, "off"], "tabs.engine");
  oneOf(tabs.browser, Object.keys(BROWSER_IDS), "tabs.browser");
  if (!appsSupported && apps.engine !== "off") throw new Error(`${file}: app control needs macOS; set apps.engine to "off" (browser tabs work here)`);
  if (apps.engine === "off" && tabs.engine === "off") throw new Error(`${file}: apps and tabs are both off, so there is nothing to serve; run "${NAME} setup"`);
  if (!Array.isArray(apps.allow) || !apps.allow.every((x) => typeof x === "string")) throw new Error(`${file}: apps.allow must be a list of bundle IDs`);
  for (const [id, e] of Object.entries(apps.engineFor)) oneOf(e, APP_ENGINES, `apps.engineFor["${id}"]`);
  cfg.apps = apps;
  cfg.tabs = tabs;
  cfg.approve = approveAll ? "all" : "allowlist";
  cfg.appsOn = apps.engine !== "off";
  cfg.tabsOn = tabs.engine !== "off";
  cfg.allowApps = cfg.appsOn ? apps.allow.filter((id) => !HARD_DENY.has(id.toLowerCase())) : [];
  const allowed = new Set(cfg.allowApps.map((id) => id.toLowerCase()));
  cfg.isAllowed = (id) => cfg.appsOn && (cfg.approve === "all" || (typeof id === "string" && allowed.has(id.toLowerCase())));
  const engineFor = new Map(Object.entries(apps.engineFor).map(([id, e]) => [id.toLowerCase(), e]));
  cfg.appEngine = apps.engine;
  cfg.appEngineFor = (id) => engineFor.get(String(id).toLowerCase()) ?? apps.engine;
  cfg.appEngines = cfg.appsOn ? [...new Set([apps.engine, ...engineFor.values()])] : [];
  cfg.idleMinutes ??= 30;
  cfg.maxSessions ??= 4;
  cfg.engineIdleMinutes ??= 10;
  if (typeof cfg.engineIdleMinutes !== "number" || !(cfg.engineIdleMinutes >= 0)) throw new Error("engineIdleMinutes must be a number >= 0 (0 disables)");
  return cfg;
}

export function loadConfig(opts) {
  const file = expand(opts.config);
  if (!existsSync(file)) throw new Error(`no config at ${file}; run "${NAME} setup"`);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (opts.mode === "serve") {
    if (!raw.host || !raw.port || !raw.tokenFile) throw new Error(`${file} needs host, port and tokenFile; run "${NAME} setup"`);
    if (raw.approve === "all") throw new Error("serve only supports the allowlist");
  }
  const cfg = normalizeConfig(raw, { file, approveAll: opts.mode === "stdio" && opts.approveAll });
  cfg.tunnels = (cfg.tunnels ?? []).map(checkTunnel);
  return cfg;
}

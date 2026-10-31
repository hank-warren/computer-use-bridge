import { existsSync, readFileSync } from "node:fs";
import { APPS_SUPPORTED, DEFAULT_CONFIG, HARD_DENY, NAME, expand } from "./common.mjs";

export const APP_ENGINES = ["open-computer-use", "agent-desktop"];
export const TAB_ENGINES = ["open-browser-use"];
// Browsers open-browser-use runs in, by the name the config uses.
export const BROWSER_IDS = { brave: "com.brave.Browser", chrome: "com.google.Chrome" };

// ---------- configuration ----------

export const USAGE = `usage: ${NAME} <command> [options]

On the machine agents control (macOS: apps and browser tabs; Linux: browser tabs):
  setup     install the engines, write the config, install and start the service (asks;
            --yes takes defaults). Options:
              --apps open-computer-use|agent-desktop|off   engine for apps (macOS)
              --allow ID,ID                 bundle IDs agents may control
              --engine-for ID=ENGINE,...    per-app engine override
              --tabs brave|chrome|off       browser for open-browser-use tabs
              --host IP|tailscale|localhost  --port N  --tunnel SSH_HOST[:PORT],...
              --yes  --no-service  --no-install
  status    check engines, permissions, extension, service and server [--json]
  update    npm i -g ${NAME}@latest, then refresh engines and the service
  serve     run the HTTP server (what the service runs)
  stdio     speak MCP on stdin/stdout, e.g. over SSH [--approve-all]

On the client (where pi, Claude Code or Codex runs):
  connect SSH_HOST  copy the server's token over SSH and add it to pi's mcp.json
            [--name NAME] [--print] [--pi-config FILE] [--remote-config FILE] [--remote-bin PATH]
            [--tunnel-name SSH_HOST]

  version   print the version

setup, status, update, serve and stdio take --config FILE (default ${DEFAULT_CONFIG}).`;

const COMMANDS = ["setup", "status", "update", "serve", "stdio", "connect", "client-info", "version", "help"];
const FLAGS = {
  setup: { "--apps": "apps", "--allow": "allow", "--engine-for": "engineFor", "--tabs": "tabs", "--host": "host", "--port": "port", "--tunnel": "tunnel" },
  connect: { "--name": "name", "--pi-config": "piConfig", "--remote-config": "remoteConfig", "--tunnel-name": "tunnelName", "--remote-bin": "remoteBin" },
};
const SWITCHES = {
  setup: { "--yes": ["yes", true], "-y": ["yes", true], "--no-service": ["service", false], "--no-install": ["install", false] },
  update: { "--no-service": ["service", false] },
  status: { "--json": ["json", true] },
  stdio: { "--approve-all": ["approveAll", true] },
  connect: { "--print": ["print", true] },
  "client-info": { "--with-token": ["withToken", true] },
};

export function parseArgs(argv) {
  let [mode, ...rest] = argv;
  if (mode === "--version" || mode === "-v") mode = "version";
  if (mode === "--help" || mode === "-h" || mode === undefined) mode = "help";
  if (!COMMANDS.includes(mode)) throw new Error(`unknown command: ${mode}\n\n${USAGE}`);
  const opts = { mode, approveAll: false, config: DEFAULT_CONFIG, yes: false, service: true, install: true };
  const value = (i) => {
    if (rest[i + 1] === undefined || rest[i + 1].startsWith("--")) throw new Error(`${rest[i]} needs a value`);
    return rest[i + 1];
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const [flag, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const key = flag === "--config" && mode !== "connect" ? "config" : FLAGS[mode]?.[flag];
    if (key) opts[key] = inline ?? value(i++);
    else if (SWITCHES[mode]?.[flag] && inline === undefined) opts[SWITCHES[mode][flag][0]] = SWITCHES[mode][flag][1];
    else if (mode === "connect" && !a.startsWith("-") && opts.host === undefined) opts.host = a;
    else throw new Error(`unknown argument for ${mode}: ${a}\n\n${USAGE}`);
  }
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

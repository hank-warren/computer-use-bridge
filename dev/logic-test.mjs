#!/usr/bin/env node
// Engine-free tests: the native-tool pass-through and its app allowlist (with fake engines and a
// fake MCP server), config migration, CLI arguments, service files and permission parsing.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, migrateConfig, normalizeConfig, parseArgs } from "../src/config.mjs";
import { remoteCommand } from "../src/connect.mjs";
import { extensionCheck, ocuPermissions } from "../src/engines/install.mjs";
import { McpChild } from "../src/engines/mcp-child.mjs";
import { obuChild, ocuChild } from "../src/engines/native.mjs";
import { handle } from "../src/server.mjs";
import { launchdReload, plist, stableNode, unit, versionedNode } from "../src/service.mjs";
import { uninstall, uninstallFiles } from "../src/setup.mjs";
import { Session, parseAppLine } from "../src/session.mjs";

const assert = (c, m) => { if (!c) { console.log("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const macConfig = (raw) => normalizeConfig({ engineIdleMinutes: 0, ...raw }, { appsSupported: true });

// Fake engines with the native servers' shapes: open-computer-use tools take app; open-browser-use's do not.
const OCU_TOOLS = [
  { name: "list_apps", description: "List the apps.", inputSchema: { type: "object", properties: {} } },
  { name: "get_app_state", description: "Get the app's state.", inputSchema: { type: "object", properties: { app: { type: "string" }, max_tree_nodes: { type: "integer" } }, required: ["app"] } },
  { name: "click", description: "Click.", inputSchema: { type: "object", properties: { app: { type: "string" }, element_index: { type: "string" } }, required: ["app"] } },
  { name: "open_url", description: "A tool with no app to check.", inputSchema: { type: "object", properties: { url: { type: "string" } } } },
];
const OBU_TOOLS = [
  { name: "open_tab", description: "Open a tab.", inputSchema: { type: "object", properties: { url: { type: "string" } } } },
  { name: "cdp", description: "CDP.", inputSchema: { type: "object", properties: { method: { type: "string" } } } },
  { name: "click", description: "Clashes with open-computer-use.", inputSchema: { type: "object", properties: {} } },
];
const APPS = "Ghostty — com.mitchellh.ghostty [frontmost, running]\nBrave Browser — com.brave.Browser [running]\nDiscord — com.hnc.Discord [running]\nDisk Utility — com.apple.DiskUtility [last-used=2026-10-30]";
function fakeEngines() {
  const calls = [];
  const starts = { apps: 0, tabs: 0 };
  const engine = (kind) => ({
    dead: false, tools: kind === "apps" ? OCU_TOOLS : OBU_TOOLS, instructions: kind === "apps" ? "OCU says: get state first." : "",
    call: async (name, args) => {
      calls.push({ kind, name, args });
      if (name === "list_apps") return { content: [{ type: "text", text: APPS }], isError: false };
      return { content: [{ type: "text", text: `${kind}:${name}` }, { type: "image", mimeType: "image/png", data: "iVBO" }], structuredContent: { n: 1 }, isError: false };
    },
    close: async function () { this.dead = true; },
  });
  return { calls, starts, start: async (kind) => { starts[kind]++; return engine(kind); } };
}

// 1. Native tools pass through unchanged; open-computer-use tools that take no app stay hidden.
{
  const f = fakeEngines();
  const s = new Session(macConfig({ apps: { engine: "open-computer-use", allow: ["com.hnc.Discord", "com.brave.Browser"] }, tabs: { engine: "open-browser-use" } }), "t", { start: f.start });
  const tools = await s.listTools();
  assert(same(tools.map((t) => t.name), ["list_apps", "get_app_state", "click", "open_tab", "cdp"]), "the tools are the engines' own, minus app tools without app and clashing names");
  assert(same(tools.find((t) => t.name === "get_app_state"), OCU_TOOLS[1]) && same(tools.find((t) => t.name === "cdp"), OBU_TOOLS[1]), "names, descriptions and schemas are unchanged");
  const r = await s.callTool("cdp", { method: "Runtime.evaluate", params: { expression: "1" } });
  assert(same(f.calls.at(-1), { kind: "tabs", name: "cdp", args: { method: "Runtime.evaluate", params: { expression: "1" } } }), "tab tools get their arguments as sent");
  assert(r.content.some((c) => c.type === "image") && same(r.structuredContent, { n: 1 }), "results come back unchanged, images and structured content included");
  const ins = await s.instructions();
  assert(/Apps you may control: com.hnc.Discord, com.brave.Browser/.test(ins) && /OCU says: get state first/.test(ins), "instructions name the allowed apps and carry the engine's own");
  assert(f.starts.apps === 1 && f.starts.tabs === 1, "each engine starts once per session");
  assert(/unknown tool open_url/.test(text(await s.callTool("open_url", { url: "x" }))), "hidden tools cannot be called");
}

// 2. The allowlist: every open-computer-use call names an allowed app, by bundle ID or name.
{
  const f = fakeEngines();
  const s = new Session(macConfig({ apps: { engine: "open-computer-use", allow: ["com.hnc.Discord", "com.brave.Browser", "com.apple.Terminal"] }, tabs: { engine: "off" } }), "t", { start: f.start });
  const appOf = async (app) => { f.calls.length = 0; const r = await s.callTool("click", { app, element_index: "3" }); return { r, sent: f.calls.find((c) => c.name === "click")?.args }; };
  let x = await appOf("COM.HNC.DISCORD");
  assert(same(x.sent, { app: "com.hnc.Discord", element_index: "3" }), "a bundle ID matches case-insensitively and is sent as configured, other arguments untouched");
  x = await appOf("Brave");
  assert(x.sent?.app === "com.brave.Browser", "an app name prefix resolves through list_apps");
  x = await appOf("Disk");
  assert(!x.sent && x.r.isError && /app not allowed: Disk/.test(text(x.r)), "an ambiguous name is refused before the engine acts");
  x = await appOf("Ghostty");
  assert(!x.sent && /app not allowed: Ghostty \(com.mitchellh.ghostty\)/.test(text(x.r)), "an app outside the allowlist is refused");
  x = await appOf("com.apple.Terminal");
  assert(!x.sent && x.r.isError, "a hard-denied app stays refused even when listed");
  x = await appOf(undefined);
  assert(!x.sent && /app must be/.test(text(x.r)), "a call without app is refused");
  const apps = text(await s.callTool("list_apps", {}));
  assert(apps === "Brave Browser — com.brave.Browser [running]\nDiscord — com.hnc.Discord [running]", "list_apps shows allowed apps only");
  const all = new Session(normalizeConfig({ apps: { engine: "open-computer-use", allow: [] }, engineIdleMinutes: 0 }, { appsSupported: true, approveAll: true }), "t", { start: fakeEngines().start });
  assert(!/ghostty/i.test(text(await all.callTool("list_apps", {}))) && (await all.callTool("click", { app: "com.mitchellh.ghostty" })).isError, "--approve-all still keeps hard-denied apps out");
  assert((await all.callTool("click", { app: "Ghostty" })).isError && (await all.callTool("click", { app: "ghost" })).isError, "--approve-all checks hard-deny on the bundle ID a name resolves to");
  assert((await all.callTool("click", { app: "Terminal" })).isError && (await all.callTool("click", { app: "Terminal.app" })).isError, "--approve-all refuses names list_apps cannot resolve");
  const ok = fakeEngines();
  const all2 = new Session(normalizeConfig({ apps: { engine: "open-computer-use", allow: [] }, engineIdleMinutes: 0 }, { appsSupported: true, approveAll: true }), "t", { start: ok.start });
  await all2.callTool("click", { app: "Discord" });
  assert(ok.calls.find((c) => c.name === "click")?.args.app === "com.hnc.Discord", "--approve-all sends the resolved bundle ID");
  assert(parseAppLine("Brave Browser — com.brave.Browser [running, uses=3]")?.id === "com.brave.Browser" && !parseAppLine("header"), "list_apps lines parse");
}

// 3. Engines: tabs only off macOS, an engine that fails to start, idle stops, own tab groups.
{
  const f = fakeEngines();
  const t = new Session(normalizeConfig({ tabs: { engine: "open-browser-use" }, engineIdleMinutes: 0 }, { appsSupported: false }), "t", { start: f.start });
  assert(same((await t.listTools()).map((x) => x.name), ["open_tab", "cdp", "click"]) && f.starts.apps === 0, "tabs only: no app engine, and open-browser-use keeps all its tools");
  assert(/no app control here/.test(await t.instructions()), "tabs-only instructions say there is no app control");
  const broken = new Session(macConfig({ apps: { engine: "open-computer-use", allow: ["com.hnc.Discord"] }, tabs: { engine: "open-browser-use" } }), "t", {
    start: async (kind) => { if (kind === "tabs") throw new Error("open-browser-use not found"); return (await fakeEngines().start(kind)); },
  });
  assert(same((await broken.listTools()).map((x) => x.name), ["list_apps", "get_app_state", "click"]) && /Browser tabs unavailable: open-browser-use not found/.test(await broken.instructions()), "an engine that cannot start leaves the other's tools and says why");
  const idle = new Session(macConfig({ apps: { engine: "open-computer-use", allow: ["com.hnc.Discord"] }, tabs: { engine: "open-browser-use" } }), "t", { start: f.start });
  await idle.callTool("open_tab", { url: "https://example.com" });
  await idle.stopEngines("idle");
  await idle.callTool("open_tab", { url: "https://example.com" });
  assert(f.starts.tabs === 3 && idle.engines.size === 1, "a stopped engine restarts on the next call");
  const a = new Session(macConfig({ tabs: { engine: "open-browser-use" } }), "a");
  const b = new Session(macConfig({ tabs: { engine: "open-browser-use" } }), "b");
  const argsA = obuChild({ obuSocket: "~/s.sock" }, "a", a.obuSession).args;
  assert(a.obuSession !== b.obuSession && same(argsA.slice(0, 3), ["mcp", "--session-id", a.obuSession]) && argsA[3] === "--socket" && !argsA[4].includes("~"), "each session has its own open-browser-use session; obuSocket is passed on");
  assert(ocuChild({ ocuVisualCursor: true }, "x").env.OPEN_COMPUTER_USE_VISUAL_CURSOR === "1" && ocuChild({ ocuVisualCursor: false }, "x").env.OPEN_COMPUTER_USE_VISUAL_CURSOR === "0", "an explicit ocuVisualCursor sets the engine's own variable");
  assert(!("OPEN_COMPUTER_USE_VISUAL_CURSOR" in ocuChild({}, "x").env), "without ocuVisualCursor the engine keeps its own default (cursor on)");
  for (const s of [t, broken, idle, a, b]) await s.close();
  // Closed while an engine starts (HTTP eviction): the engine is stopped, and nothing starts later.
  let release;
  const gate = new Promise((r) => { release = r; });
  const made = [];
  const slow = new Session(macConfig({ apps: { engine: "open-computer-use", allow: ["com.hnc.Discord"] }, tabs: { engine: "open-browser-use" } }), "t", {
    start: async (kind) => { const e = { kind, dead: false, tools: [], close: async () => { e.dead = true; } }; made.push(e); await gate; return e; },
  });
  const listing = slow.listTools();
  await Promise.resolve();
  const closing = slow.close();
  release();
  await closing;
  await listing;
  assert(made.length === 1 && made[0].dead && slow.engines.size === 0, "an engine that finishes starting after close is stopped, and the other never starts");
  assert(/closed/.test(text(await slow.callTool("open_tab", {}))) || (await slow.callTool("open_tab", {})).isError, "a closed session starts no engines");
  assert(made.length === 1, "no engine started after close");
}

// 4. McpChild speaks MCP to a real child process: initialize, tools, calls, server pings, exits.
{
  const dir = mkdtempSync(join(tmpdir(), "cub-mcp-"));
  const server = join(dir, "server.mjs");
  writeFileSync(server, `
import { createInterface } from "node:readline";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") return out({ jsonrpc: "2.0", id: m.id, result: { serverInfo: { name: "fake", version: "9.9" }, instructions: "be nice", capabilities: { tools: {} } } });
  if (m.method === "tools/list") return out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } });
  if (m.method === "tools/call" && m.params.name === "die") process.exit(3);
  if (m.method === "tools/call") { out({ jsonrpc: "2.0", id: 99, method: "ping" }); return out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(m.params.arguments) }] } }); }
  if (m.id === 99) process.stderr.write("");
});
`);
  try {
    const c = await new McpChild({ name: "fake", command: process.execPath, args: [server] }).start();
    assert(c.version === "9.9" && c.instructions === "be nice" && c.tools[0].name === "echo", "start reads the server's version, instructions and tools");
    const [r1, r2] = await Promise.all([c.call("echo", { a: 1 }), c.call("echo", { b: 2 })]);
    assert(text(r1) === '{"a":1}' && text(r2) === '{"b":2}', "calls return the server's results, in order");
    let err = "";
    try { await c.call("die", {}); } catch (e) { err = e.message; }
    assert(/fake exited \(3\)/.test(err) && c.dead, "a server that exits fails its call and marks the child dead");
    // A server that answers the handshake with an error, or not at all, and stays up is stopped.
    const stubborn = join(dir, "stubborn.mjs");
    writeFileSync(stubborn, `
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (process.argv[2] === "error" && m.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -1, message: "not ready" } }) + "\\n");
});
setInterval(() => {}, 1000);
`);
    for (const mode of ["error", "silent"]) {
      const child = new McpChild({ name: "stubborn", command: process.execPath, args: [stubborn, mode], startTimeoutMs: 300 });
      let why = "";
      try { await child.start(); } catch (e) { why = e.message; }
      const exited = await new Promise((r) => (child.proc.exitCode !== null || child.proc.signalCode !== null ? r(true) : (child.proc.once("exit", () => r(true)), setTimeout(() => r(false), 2000))));
      assert((mode === "error" ? /not ready/ : /timed out/).test(why) && exited, `a child whose handshake ${mode === "error" ? "fails" : "times out"} is stopped`);
    }
    let missing = "";
    try { await new McpChild({ name: "x", command: join(dir, "nope"), missing: "x is missing; install it" }).start(); } catch (e) { missing = e.message; }
    assert(missing === "x is missing; install it", "a missing command says how to install it");
    const conn = await extensionCheck({ tabs: { browser: "brave" } }, () => ({ start: async () => ({ call: async () => ({ content: [{ type: "text", text: '{"result":{"name":"Brave","version":"1.1.0"}}' }], isError: false }), close: async () => {} }) }));
    const down = await extensionCheck({ tabs: { browser: "brave" } }, () => ({ start: async () => ({ call: async () => ({ content: [{ type: "text", text: "no browser connected" }], isError: true }), close: async () => {} }) }));
    assert(conn.ok && /Brave 1.1.0/.test(conn.what) && !down.ok && down.human && /no browser connected/.test(down.what), "the extension check asks open-browser-use's own server");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 4b. The MCP handshake: instructions from the session, tool errors as results.
{
  const s = new Session(macConfig({ apps: { engine: "open-computer-use", allow: ["com.hnc.Discord"] }, tabs: { engine: "off" } }), "t", { start: fakeEngines().start });
  const init = await handle(s, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert(init.result.protocolVersion === "2025-06-18" && /OCU says/.test(init.result.instructions), "initialize carries the instructions");
  const list = await handle(s, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const bad = await handle(s, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "click", arguments: { app: "Ghostty" } } });
  assert(list.result.tools.length === 3 && bad.result.isError, "tools/list and a refused call");
}

// 4c. Config: 0.x and 1.x files load as 2.0.
{
  const v0 = migrateConfig({ host: "1.2.3.4", allowApps: ["com.brave.Browser", "com.hnc.Discord"], appEngine: "agent-desktop" }, true);
  assert(v0.migrated && v0.cfg.apps.engine === "open-computer-use" && v0.cfg.apps.allow.length === 2 && v0.cfg.tabs.browser === "brave" && !("allowApps" in v0.cfg), "0.x configs migrate: Brave in allowApps turns tabs on");
  assert(migrateConfig({ allowApps: ["com.google.Chrome"] }, false).cfg.apps.engine === "off", "0.x Linux configs migrate to tabs only");
  const off = migrateConfig({ allowApps: ["com.brave.Browser"], appEngine: "off" }, true).cfg;
  assert(off.apps.engine === "off" && off.tabs.browser === "brave", "0.x appEngine off stays off: tabs without app control");
  const v1 = migrateConfig({ apps: { engine: "agent-desktop", allow: ["com.hnc.Discord"], engineFor: { "a.b": "open-computer-use" } }, tabs: { engine: "open-browser-use" }, treeMaxChars: 0, tabEval: false, obuCursor: false, adMaxDepth: 9, idleMinutes: 5 }, true);
  assert(v1.migrated && same(v1.cfg.apps, { engine: "open-computer-use", allow: ["com.hnc.Discord"] }) && !("treeMaxChars" in v1.cfg) && !("adMaxDepth" in v1.cfg) && v1.cfg.idleMinutes === 5, "1.x: agent-desktop and engineFor go, removed settings are dropped, the rest stays");
  assert(!migrateConfig({ apps: { engine: "off" }, tabs: { engine: "open-browser-use" } }, true).migrated, "2.0 configs are left alone");
  const bad = (raw, re, appsSupported = true) => { try { normalizeConfig(raw, { appsSupported }); return false; } catch (e) { return re.test(e.message); } };
  assert(bad({ apps: { engine: "off" }, tabs: { engine: "off" } }, /nothing to serve/), "both off is refused");
  assert(bad({ apps: { engine: "ocu" } }, /apps.engine must be/), "unknown app engine is refused");
  assert(bad({ apps: { engine: "open-computer-use" } }, /needs macOS/, false), "app control is refused off macOS");
  assert(bad({ tabs: { engine: "open-browser-use", browser: "firefox" } }, /tabs.browser/), "unknown browser is refused");
  const t = normalizeConfig({ tabs: { engine: "open-browser-use" } }, { appsSupported: false });
  assert(t.tabsOn && !t.appsOn && t.tabs.browser === "brave" && !t.isAllowed("com.brave.Browser"), "tabs only: no app is allowed");
}

// 5. CLI arguments, service files and the remote command connect runs.
{
  const o = parseArgs(["setup", "--apps", "open-computer-use", "--allow=com.hnc.Discord", "--tabs", "chrome", "--yes", "--no-install"]);
  assert(o.apps === "open-computer-use" && o.allow === "com.hnc.Discord" && o.tabs === "chrome" && o.yes && o.install === false && o.service, "setup flags, with = or a separate value");
  const c = parseArgs(["connect", "pikachu", "--name", "mac", "--print"]);
  assert(c.host === "pikachu" && c.name === "mac" && c.print, "connect takes a host and options");
  let threw = 0;
  for (const bad of [["setup", "--json"], ["status", "--apps", "x"], ["setup", "--apps"], ["bogus"], ["connect", "a", "b"], ["setup", "--engine-for", "a=b"]]) { try { parseArgs(bad); } catch { threw++; } }
  assert(threw === 6, "unknown, misplaced and valueless arguments are refused");
  assert(parseArgs(["status", "--json"]).json && parseArgs(["stdio", "--approve-all"]).approveAll, "status --json and stdio --approve-all");
  const p = plist("/opt/homebrew/opt/node/bin/node", "/x/bin/computer-use-bridge.mjs", "/u/a&b/config.json", ["/u/.npm-global/bin"]);
  assert(p.includes("<string>/opt/homebrew/opt/node/bin/node</string>") && p.includes("<string>/u/a&amp;b/config.json</string>") && p.includes("<string>serve</string>") && /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/opt\/node\/bin:\/u\/.npm-global\/bin:/.test(p), "the LaunchAgent runs node with the script, escaped, with node and npm's bin on PATH");
  const u = unit("/home/u/.nvm/versions/node/v24.1.0/bin/node", "/home/u/my app/bin/computer-use-bridge.mjs", "/home/u/.config/computer-use-bridge/config.json");
  assert(u.includes('ExecStart=/home/u/.nvm/versions/node/v24.1.0/bin/node "/home/u/my app/bin/computer-use-bridge.mjs" serve --config') && u.includes("Restart=always") && u.includes("WantedBy=default.target"), "the systemd unit quotes paths with spaces");
  assert(versionedNode("/home/u/.nvm/versions/node/v24.1.0/bin/node") && !versionedNode("/usr/bin/node"), "versioned node paths are recognized");
  assert(stableNode("/usr/bin/node") === "/usr/bin/node" && stableNode("/nowhere/Cellar/node/26.1.0/bin/node") === "/nowhere/Cellar/node/26.1.0/bin/node", "stableNode keeps paths without an opt link");
  // The remote command must parse in POSIX sh and find nothing gracefully.
  let out = "";
  try { execFileSync("/bin/sh", ["-c", remoteCommand(["client-info", "--config", "/tmp/it's here.json"])], { env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" }, stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { out = String(e.stderr); }
  assert(/is not installed there/.test(out), "the remote command runs in sh and reports a missing install");
}

// 5b. uninstall removes the config, its token and backups, keeps client tokens beside them, and
// leaves a service that runs another config alone.
{
  const dir = mkdtempSync(join(tmpdir(), "cub-un-"));
  try {
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ tokenFile: join(dir, "token"), tabs: { engine: "open-browser-use", browser: "brave" } }));
    for (const n of ["token", "config.json.bak.20260101-000000", "pikachu.token"]) writeFileSync(join(dir, n), "x");
    const names = uninstallFiles(file, JSON.parse(readFileSync(file, "utf8"))).map((f) => f.slice(dir.length + 1)).sort();
    assert(same(names, ["config.json", "config.json.bak.20260101-000000", "token"]), "uninstall targets the config, its token and backups, not client tokens");
    const log = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => { log.push(String(s)); return true; };
    let code;
    try { code = await uninstall({ config: file, yes: true }); } finally { process.stdout.write = write; }
    assert(code === 0 && !existsSync(file) && !existsSync(join(dir, "token")) && existsSync(join(dir, "pikachu.token")), "uninstall --yes removes them and keeps the client token");
    assert(!/the service \(/.test(log.join("")) && /npm rm -g computer-use-bridge/.test(log.join("")), "a service that runs another config is left alone, and what is left is listed");
    // The service itself, in a throwaway HOME: stopped through launchctl or systemctl and checked
    // before anything is removed; a scratch config keeps the token the installed service uses.
    const home = join(dir, "home");
    const svc = execFileSync(process.execPath, ["--input-type=module", "-e", `
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
const S = await import(${JSON.stringify(new URL("../src/service.mjs", import.meta.url).href)});
const U = await import(${JSON.stringify(new URL("../src/setup.mjs", import.meta.url).href)});
const mac = process.platform === "darwin";
const f = mac ? S.PLIST : S.UNIT;
const home = process.env.HOME;
const write = (cfg) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, mac ? S.plist("/n", "/s", cfg) : S.unit("/n", "/s", cfg)); };
const out = {};
// Stops, then removes.
write(join(home, "live.json"));
let calls = [];
const stopped = async (cmd, args) => { calls.push([cmd.split("/").pop(), ...args].join(" ")); return args.includes("print") ? { ok: false, code: 113, stderr: "Could not find service" } : args.includes("is-active") ? { ok: false, stdout: "inactive\\n" } : { ok: true }; };
out.removed = await S.removeService(stopped, async () => {});
out.gone = !existsSync(f);
out.calls = calls;
out.again = await S.removeService(stopped);
// Still running after the stop: throws and leaves the file.
write(join(home, "live.json"));
const running = async (cmd, args) => (args.includes("print") ? { ok: true } : args.includes("is-active") ? { ok: true, stdout: "active\\n" } : { ok: false, stderr: "busy", code: 1 });
try { await S.removeService(running, async () => {}); out.threw = false; } catch (e) { out.threw = /could not confirm/.test(e.message); }
out.kept = existsSync(f);
// Unknown state (no user bus, launchctl failing for another reason): also refused.
const unknown = async (cmd, args) => (args.includes("print") ? { ok: false, code: 5, stderr: "Input/output error" } : { ok: false, code: 1, stdout: "", stderr: "Failed to connect to bus" });
try { await S.removeService(unknown, async () => {}); out.unknownThrew = false; } catch (e) { out.unknownThrew = /could not confirm/.test(e.message); }
out.unknownKept = existsSync(f);
// A scratch config sharing the live service's token file leaves that token alone.
const token = join(home, "token");
writeFileSync(token, "t".repeat(64));
writeFileSync(join(home, "live.json"), JSON.stringify({ tokenFile: token, tabs: { engine: "open-browser-use" } }));
writeFileSync(join(home, "scratch.json"), JSON.stringify({ tokenFile: token, tabs: { engine: "open-browser-use" } }));
write(join(home, "live.json"));
const real = process.stdout.write.bind(process.stdout);
let said = "";
process.stdout.write = (x) => { said += x; return true; };
const code = await U.uninstall({ config: join(home, "scratch.json"), yes: true });
process.stdout.write = real;
out.scratch = { code, scratchGone: !existsSync(join(home, "scratch.json")), tokenKept: existsSync(token), serviceKept: existsSync(f), said: /Keeping .*token/.test(said) };
console.log(JSON.stringify(out));
`], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    const r = JSON.parse(svc.trim().split("\n").pop());
    const want = process.platform === "darwin"
      ? [/^launchctl bootout gui\/\d+\/com\.hank-warren\.computer-use-bridge$/, /^launchctl print gui\/\d+\/com\.hank-warren\.computer-use-bridge$/]
      : [/^systemctl --user disable --now computer-use-bridge\.service$/, /^systemctl --user is-active computer-use-bridge\.service$/, /^systemctl --user daemon-reload$/];
    assert(r.removed && r.gone && r.calls.length === want.length && want.every((re, i) => re.test(r.calls[i])) && r.again === false, "removeService stops the service, checks it stopped, deletes its file, and is a no-op once it is gone");
    assert(r.threw && r.kept, "a service still running after the stop is reported and left in place, so nothing is deleted");
    assert(r.unknownThrew && r.unknownKept, "a service whose state cannot be read counts as running, so nothing is deleted");
    assert(r.scratch.code === 0 && r.scratch.scratchGone && r.scratch.tokenKept && r.scratch.serviceKept && r.scratch.said, "uninstalling a scratch config keeps the token and service of the installed config");
    assert(parseArgs(["uninstall", "--yes"]).yes && parseArgs(["uninstall", "--config", "/x.json"]).config === "/x.json", "uninstall takes --yes and --config");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 6. Reloading the LaunchAgent waits for the old job to unload, retries bootstrap, and says when the
// service is left down.
{
  const fake = (printsLeft, bootstrapFails) => {
    const calls = [];
    const lc = async (args) => {
      calls.push(args[0]);
      if (args[0] === "print") return { ok: printsLeft-- > 0 };
      if (args[0] === "bootstrap") return bootstrapFails-- > 0 ? { ok: false, stderr: "Bootstrap failed: 5: Input/output error", code: 5 } : { ok: true };
      return { ok: true };
    };
    return { lc, calls };
  };
  const opts = { domain: "gui/501", plistFile: "/p.plist", wait: async () => {} };
  let f = fake(2, 1);
  await launchdReload(f.lc, opts);
  assert(f.calls.join() === "bootout,print,print,print,bootstrap,bootstrap", "waits for the old job and retries bootstrap, which starts it (RunAtLoad)");
  const still = async (args) => (args[0] === "bootstrap" ? { ok: false, stderr: "service already bootstrapped" } : { ok: args[0] !== "print" });
  const seen = [];
  await launchdReload(async (a) => { seen.push(a[0]); return still(a); }, opts);
  assert(seen.at(-1) === "kickstart", "a job that stayed loaded is restarted");
  f = fake(0, 9);
  let msg = "";
  try { await launchdReload(f.lc, opts); } catch (e) { msg = e.message; }
  assert(/not running; start it with: launchctl bootstrap gui\/501 \/p\.plist/.test(msg) && f.calls.filter((c) => c === "bootstrap").length === 5 && !f.calls.includes("kickstart"), "a bootstrap that keeps failing says the service is down and how to start it");
}

// 7. open-computer-use doctor output (JSON, or text from older versions): granted, missing and broken answers.
{
  const dir = mkdtempSync(join(tmpdir(), "cub-perm-"));
  const script = (name, body) => {
    const f = join(dir, name);
    writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return f;
  };
  try {
    const ocu = async (body) => ocuPermissions({ ocuCommand: script(`ocu${Math.random()}`, body) });
    let r = await ocu(`echo '{"accessibilityTrusted":true,"allGranted":true,"missingPermissions":[],"platform":"macos","screenCaptureGranted":true}'`);
    assert(r.ok && /Accessibility granted, Screen Recording granted/.test(r.what), "doctor --json: granted");
    r = await ocu(`echo '{"accessibilityTrusted":true,"allGranted":false,"screenCaptureGranted":false}'`);
    assert(!r.ok && r.human && /Screen Recording missing/.test(r.what), "doctor --json: missing Screen Recording needs a person");
    r = await ocu(`echo "Permissions: accessibility=granted, screenRecording=missing"`);
    assert(!r.ok && /Accessibility granted, Screen Recording missing/.test(r.what), "older doctor text output still parses");
    r = await ocu(`echo "segfault" >&2; exit 3`);
    assert(!r.ok && !r.human && /doctor failed: segfault/.test(r.what), "an unreadable doctor answer is a failure, not a permission prompt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert(configPath("./x.json") === join(process.cwd(), "x.json") && configPath("~/c.json").startsWith("/") && !configPath("~/c.json").includes("~"), "config paths become absolute for the service");
}


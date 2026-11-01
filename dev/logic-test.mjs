#!/usr/bin/env node
// Engine-free tests: tool definitions, result shaping, the tab tree, key mapping, and the
// rules that keep agents to allowed apps and their own tabs. Imports the modules and replaces
// open-computer-use and open-browser-use with fakes.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session.mjs";
import { configPath, migrateConfig, normalizeConfig, parseArgs } from "../src/config.mjs";
import { plist, stableNode, unit, versionedNode } from "../src/service.mjs";
import { remoteCommand } from "../src/connect.mjs";
import { execFileSync } from "node:child_process";
import { AdError, adKey, adSecondary, adTree } from "../src/engines/agent-desktop.mjs";
import { adPermissions, ocuPermissions } from "../src/engines/install.mjs";
import { ObuBrowser, cdpKey, pwKey } from "../src/engines/open-browser-use.mjs";
import { OcuChild, ocuKey, ocuRemap, ocuTypeKeys } from "../src/engines/open-computer-use.mjs";
import { toolDefs, toolSchema } from "../src/tools.mjs";

const assert = (c, m) => { if (!c) { console.log("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
// A 0.x-style config (browsers in allowApps turn tabs on), normalized as on macOS.
const config = (allowApps, extra = {}) => normalizeConfig({ allowApps, engineIdleMinutes: 0, ...extra }, { appsSupported: true });

// 1. Tool definitions.
{
  const all = toolDefs(true).map(toolSchema);
  const none = toolDefs(false).map(toolSchema);
  const names = (l) => l.map((t) => t.name);
  assert(names(all).includes("open_tab") && !names(none).includes("open_tab"), "tab tools only with an allowed browser");
  assert(none.every((t) => !t.inputSchema.properties.tab), "no tab parameter without tabs");
  assert(none.find((t) => t.name === "scroll").inputSchema.required.includes("element"), "app-only scroll needs an element");
  assert([...all, ...none].every((t) => t.inputSchema.required.every((k) => k in t.inputSchema.properties)), "every required parameter is defined");
  assert(!names(all).some((n) => n === "paste" || n === "select_text"), "no tools the engine cannot serve");
  const s = new Session({ ...config(["com.brave.Browser"]), tabEval: false }, "t");
  assert(!s.listTools().some((t) => t.name === "eval_tab") && s.listTools().some((t) => t.name === "read_tab"), "tabEval: false removes eval_tab only");
  assert(!new Session(config(["com.hnc.Discord"]), "t").tabsOn, "tabs off when no browser is allowed");
}

// 2. Result shaping: trees capped (surrogate-safe, focus lines kept), screenshots dropped unless asked for.
{
  const s = new Session(config(["com.hnc.Discord"]), "t");
  const tree = "x".repeat(99) + "😀" + "y".repeat(500) + "\nThe focused UI element is 4.";
  const r = await s.shape({ content: [{ type: "text", text: tree }, { type: "image", mimeType: "image/png", data: "" }] }, "a", { cap: 100, maxWidth: 1280 });
  const t = text(r);
  assert(t.includes("[Tree truncated: showing 99 of"), "cut before the surrogate pair");
  assert(t.endsWith("The focused UI element is 4."), "focus line kept after the cut");
  assert(!r.content.some((c) => c.type === "image"), "engine screenshot dropped by default");
  const whole = await s.shape({ content: [{ type: "text", text: tree }] }, "a", { cap: 0, maxWidth: 1280 });
  assert(text(whole) === tree, "cap 0 keeps the whole tree");
  const shot = await s.shape({ content: [{ type: "text", text: tree }, { type: "image", mimeType: "image/png", data: "" }] }, "a", { cap: 100, maxWidth: 1280, image: true, tree: false });
  assert(shot.content.length === 1 && shot.content[0].type === "image", "screenshot only, without the tree");
}

// 3. Apps: allowlist, names, and refusals before the engine is called.
{
  const s = new Session(config(["com.brave.Browser", "com.hnc.Discord"]), "t");
  s.apps = async () => [
    { id: "com.brave.Browser", displayName: "Brave Browser" }, { id: "com.hnc.Discord", displayName: "Discord" },
    { id: "com.apple.Terminal", displayName: "Terminal" },
  ];
  const calls = [];
  s.cua = async () => ({ call: async (name, args) => { calls.push([name, args]); return { content: [{ type: "text", text: "tree" }] }; } });
  assert(await s.resolveApp("brave") === "com.brave.Browser", "a unique name prefix finds the app");
  assert(await s.resolveApp("Discord") === "com.hnc.Discord", "an exact name finds the app");
  const r = await s.callTool("get_state", { app: "Terminal" });
  assert(r.isError && /app not allowed/.test(text(r)) && !calls.length, "a disallowed app is refused before the engine runs");
  const b = await s.callTool("batch", { app: "Discord", actions: [{ action: "click", element: 1 }, { action: "paste", text: "x" }] });
  assert(b.isError && /step 2/.test(text(b)) && !calls.length, "a batch is checked before any step runs");
  await s.callTool("click", { app: "Discord", element: 3 });
  assert(calls[0]?.[0] === "click" && calls[0][1].element_index === "3", "click maps to the engine's element_index");
  const both = await s.callTool("get_state", { app: "Discord", tab: "5" });
  assert(both.isError && /not both/.test(text(both)), "app and tab together are refused");
}

// 4. Tabs: agents act only on their own tabs.
const fakeBrowser = (cfg, agentIds, cdp = async () => ({})) => {
  const b = new ObuBrowser(cfg, "t");
  b.calls = [];
  b.request = async (method, params) => {
    b.calls.push(method);
    if (method === "getTabs") return agentIds.map((id) => ({ id, title: `agent ${id}`, url: "https://a/" }));
    if (method === "getUserTabs") return [...agentIds, 900].map((id) => ({ id, title: `t${id}`, url: "https://u/" }));
    if (method === "attach" || method === "detach") return {};
    if (method === "executeCdp") return cdp(params.method, params.commandParams);
    throw new Error(`unexpected ${method}`);
  };
  return b;
};
{
  const cfg = config(["com.brave.Browser"]);
  const s = new Session(cfg, "t");
  s.obu = fakeBrowser(cfg, [5], async () => { throw new Error("CDP must not run"); });
  const r = await s.callTool("get_state", { tab: "900" });
  assert(r.isError && /not an agent tab/.test(text(r)), "a user's tab is refused");
  assert(!s.obu.calls.includes("attach") && !s.obu.calls.includes("executeCdp"), "a user's tab is never attached");
  const l = JSON.parse(text(await s.callTool("list_tabs", {})));
  assert(l[0].tab === "5" && l[0].agent && l.length === 2 && !l[1].agent, "list_tabs marks agent tabs and lists the user's once");
  const e = await new Session(config(["com.hnc.Discord"]), "t").callTool("open_tab", { url: "https://a/" });
  assert(e.isError, "tab tools are refused without an allowed browser");
}

// 4b. Each session has its own open-browser-use session, kept across engine stops.
{
  const cfg = config(["com.brave.Browser"]);
  const wire = (b) => {
    const sent = [];
    b.connect = async () => {};
    b.sock = { write: (buf) => sent.push(JSON.parse(buf.subarray(4).toString("utf8"))) };
    return sent;
  };
  const a = new Session(cfg, "a"), c = new Session(cfg, "c");
  const ids = [a, c].map((s) => s.browser().session.id);
  assert(ids[0] !== ids[1] && ids.every((id) => id.startsWith("computer-use-bridge-")), "sessions get distinct open-browser-use sessions");
  const sent = wire(a.browser());
  await a.browser().request("getTabs", {}, 1).catch(() => {});
  assert(sent[0].params.session_id === ids[0] && sent[0].params.turn_id === ids[0], "requests carry the session's id");
  await a.stopEngine("idle");
  assert(a.obu === null && a.browser().session.id === ids[0], "the id survives an idle stop");
  const b = a.browser();
  const calls = [];
  b.request = async (method, params) => { calls.push([method, params]); return method === "createTab" ? { id: 7 } : {}; };
  b.cdp = async () => ({});
  b.waitLoad = async () => {};
  await b.openTab("https://a/");
  await b.openTab("https://a/");
  const names = calls.filter(([m]) => m === "nameSession");
  assert(calls[0][0] === "nameSession" && names.length === 1 && names[0][1].name === a.obuSession.name, "the tab group is named once, before the first tab");
}

// 4c. Held keys in tabs: down without up, up later, and let go on release.
{
  const cfg = config(["com.brave.Browser", "com.hnc.Discord"]);
  const s = new Session(cfg, "t");
  const keys = [];
  s.obu = fakeBrowser(cfg, [5], async (m, p) => {
    if (m === "Input.dispatchKeyEvent") keys.push(`${p.type} ${p.key}`);
    if (m === "Accessibility.getFullAXTree") return { nodes: [{ nodeId: "1", role: { value: "RootWebArea" }, name: { value: "P" } }] };
    return {};
  });
  await s.callTool("batch", { tab: "5", actions: [{ action: "press_key", key: "Up", hold: "down" }, { action: "press_key", key: "Left" }] });
  assert(keys.join(",") === "rawKeyDown ArrowUp,rawKeyDown ArrowLeft,keyUp ArrowLeft", "hold: down presses without letting go");
  assert(s.obu.held.get(5)?.size === 1, "the held key is tracked");
  await s.callTool("batch", { tab: "5", actions: [{ action: "press_key", key: "Up", hold: "up" }] });
  assert(keys.at(-1) === "keyUp ArrowUp" && s.obu.held.get(5).size === 0, "hold: up lets go");
  await s.callTool("batch", { tab: "5", actions: [{ action: "press_key", key: "Down", hold: "down" }] });
  keys.length = 0;
  await s.obu.releaseKeys();
  assert(keys.join(",") === "keyUp ArrowDown" && s.obu.held.size === 0, "releasing lets go of held keys");
  const bad = await s.callTool("press_key", { tab: "5", key: "Up", hold: "sideways" });
  assert(bad.isError && /hold must be/.test(text(bad)), "an unknown hold is refused");
  s.cua = async () => { throw new Error("engine must not run"); };
  const app = await s.callTool("press_key", { app: "com.hnc.Discord", key: "Up", hold: "down" });
  assert(app.isError && /tabs only/.test(text(app)), "hold is refused for apps");
}

// 4d. Without app control (Linux): tab tools only, tab required, apps refused before the engine runs.
{
  const cfg = { ...config(["com.brave.Browser"]), appsOn: false };
  const s = new Session(cfg, "t");
  const tools = s.listTools();
  const names = tools.map((t) => t.name);
  assert(!names.includes("list_apps") && !names.includes("launch_app") && !names.includes("secondary_action") && names.includes("open_tab") && names.includes("release"), "tabs-only tools");
  assert(tools.every((t) => !t.inputSchema.properties.app), "no app parameter");
  assert(tools.filter((t) => t.inputSchema.properties.tab).every((t) => t.inputSchema.required.includes("tab")), "tab required wherever it is accepted");
  assert(tools.every((t) => t.inputSchema.required.every((k) => k in t.inputSchema.properties)), "every required parameter is defined");
  const steps = tools.find((t) => t.name === "batch").inputSchema.properties.actions.items;
  assert(!steps.properties.action.enum.includes("secondary_action") && !steps.properties.name, "batch steps without secondary_action");
  assert(toolDefs(false, false).length === 0, "no tools without tabs or apps");
  s.cua = async () => { throw new Error("engine must not run"); };
  const r = await s.callTool("get_state", { app: "com.brave.Browser" });
  assert(r.isError && /tabs only/.test(text(r)), "app calls are refused");
  assert(!(await s.callTool("release", {})).isError, "release works");
  assert(/no desktop app control/.test(s.instructions()), "tabs-only instructions");
}

// 4e. Tab screenshots are scaled by the browser, and coordinates map back.
{
  const jpeg = (w) => { const b = Buffer.alloc(32); b.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 100]); b.writeUInt16BE(w, 9); return b.toString("base64"); };
  const run = async (dpr, maxWidth) => {
    const shots = [];
    const b = fakeBrowser(config(["com.brave.Browser"]), [5], async (m, p) => {
      if (m === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 40 } };
      if (m === "Runtime.evaluate") return { result: { value: dpr } };
      if (m === "Page.captureScreenshot") { shots.push(p); return { data: jpeg(Math.round(1000 * dpr * (p.clip?.scale ?? 1))) }; }
      return {};
    });
    return { s: await b.screenshot(5, maxWidth), shots, map: b.scales.get(5) };
  };
  let r = await run(1, 1280);
  assert(r.s.scale === 1 && !r.shots[0].clip && r.map === 1, "narrow tabs are not scaled");
  r = await run(2, 1280);
  assert(r.shots[0].clip?.scale === 0.64 && r.shots[0].clip.y === 40 && r.s.scale === 2000 / 1280 && r.s.width === 2000, "wide tabs are scaled by the browser");
  assert(r.map === 1000 / 1280, "screenshot pixels map back to CSS pixels");
  r = await run(2, 0);
  assert(!r.shots[0].clip && r.s.scale === 1 && r.map === 0.5, "max_width 0 keeps full size");
}

// 4f. Config v2: explicit apps and tabs, 0.x migration, per-app engines.
{
  const v1 = { host: "1.2.3.4", port: 47800, allowApps: ["com.brave.Browser", "com.hnc.Discord"], appEngine: "agent-desktop" };
  const m = migrateConfig(v1, true);
  assert(m.migrated && m.cfg.apps.engine === "agent-desktop" && m.cfg.apps.allow.length === 2 && m.cfg.tabs.engine === "open-browser-use" && m.cfg.tabs.browser === "brave" && !("allowApps" in m.cfg) && !("appEngine" in m.cfg), "0.x configs migrate: Brave in allowApps turns tabs on");
  const lin = migrateConfig({ allowApps: ["com.google.Chrome"] }, false).cfg;
  assert(lin.apps.engine === "off" && lin.tabs.browser === "chrome", "0.x Linux configs migrate to tabs only");
  assert(!migrateConfig({ apps: { engine: "off" }, tabs: { engine: "open-browser-use" } }, true).migrated, "1.0 configs are left alone");
  const bad = (raw, re, appsSupported = true) => {
    try { normalizeConfig(raw, { appsSupported }); return false; } catch (e) { return re.test(e.message); }
  };
  assert(bad({ apps: { engine: "off" }, tabs: { engine: "off" } }, /nothing to serve/), "both off is refused");
  assert(bad({ apps: { engine: "ocu" } }, /apps.engine must be/), "unknown app engine is refused");
  assert(bad({ apps: { engine: "open-computer-use" } }, /needs macOS/, false), "app engines are refused off macOS");
  assert(bad({ apps: { engine: "open-computer-use", engineFor: { "a.b": "x" } } }, /engineFor/), "unknown per-app engine is refused");
  assert(bad({ tabs: { engine: "open-browser-use", browser: "firefox" } }, /tabs.browser/), "unknown browser is refused");
  assert(bad({ engine: "chatgpt", apps: { engine: "open-computer-use" } }, /no longer supported/), "the 0.4 engine key is refused");
  const c = normalizeConfig({ apps: { engine: "agent-desktop", allow: ["com.hnc.Discord", "com.playstack.balatro", "com.apple.Terminal"], engineFor: { "com.playstack.Balatro": "open-computer-use" } }, tabs: { engine: "off" } }, { appsSupported: true });
  assert(c.appEngineFor("com.hnc.Discord") === "agent-desktop" && c.appEngineFor("com.playstack.balatro") === "open-computer-use", "engineFor overrides the default, case-insensitively");
  assert(c.appEngines.join() === "agent-desktop,open-computer-use" && !c.isAllowed("com.apple.Terminal") && c.isAllowed("com.hnc.discord"), "engines in use; hard-denied apps stay out");
  const t = normalizeConfig({ tabs: { engine: "open-browser-use" } }, { appsSupported: false });
  assert(t.tabsOn && !t.appsOn && t.tabs.browser === "brave" && !t.isAllowed("com.brave.Browser"), "tabs only: Brave is not an app");
  const both = new Session({ ...c, engineIdleMinutes: 0 }, "t");
  const used = [];
  const fakeEngine = (name) => ({ dead: false, call: async (tool, args) => { used.push(`${name}:${tool}`); return { content: [{ type: "text", text: "tree" }] }; }, close: async () => {} });
  both.engines.set("agent-desktop", fakeEngine("ad"));
  both.engines.set("open-computer-use", fakeEngine("ocu"));
  await both.callTool("get_state", { app: "com.hnc.Discord" });
  await both.callTool("get_state", { app: "com.playstack.balatro" });
  assert(used.join() === "ad:get_app_state,ocu:get_app_state", "each app's calls go to its engine");
  assert(/Apps run on agent-desktop except com.playstack.balatro/.test(both.instructions()), "instructions name the apps on the other engine");
  await both.stopEngine("released");
  assert(both.engines.size === 0, "release stops every engine");
}

// 4g. The agent-desktop engine: same tools, element numbers mapped to snapshot refs, headless only.
{
  const dir = mkdtempSync(join(tmpdir(), "cub-ad-"));
  const calls = join(dir, "calls.jsonl");
  const fake = join(dir, "agent-desktop");
  const moved = join(dir, "focus-moved");
  // A stand-in CLI: records its arguments and answers with canned envelopes.
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
const args = a[0] === "--session" ? a.slice(2) : a;
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a) + "\\n");
const ok = (data) => { console.log(JSON.stringify({ version: "2.5", ok: true, command: args[0], data })); process.exit(0); };
const err = (code, message) => { console.log(JSON.stringify({ version: "2.5", ok: false, command: args[0], error: { code, message } })); process.exit(1); };
switch (args[0]) {
  case "version": ok({ version: "9.9.9" });
  case "list-apps": ok({ apps: [{ name: "Discord", pid: 1, bundle_id: "com.hnc.Discord", presentation: "foreground" }, { name: "Terminal", pid: 2, bundle_id: "com.apple.Terminal", presentation: "foreground" }, { name: "Helper", pid: 3, bundle_id: "x.helper" }] });
  case "snapshot": { const m = fs.existsSync(${JSON.stringify(moved)}); const id = m ? "s2" : "s1"; const r = (n) => "@" + id + ":e" + n;
    ok({ app: "Discord", window: { title: "general", id: "w1" }, snapshot_id: id, complete: true, tree: { role: "window", name: "general", children: [
    { role: "statictext", name: "hello\\nthere" },
    { ref_id: r(1), role: "button", name: "Send", states: ["enabled"], available_actions: ["Click"] },
    { ref_id: r(2), role: "textfield", name: "Message", value: "hi", states: m ? [] : ["focused"], available_actions: ["Click", "Focus"] },
    { ref_id: r(3), role: "disclosure", name: "Channels", available_actions: ["Expand"], children_count: 4 },
    { ref_id: r(4), role: "textfield", name: "Search", states: m ? ["focused"] : [] } ] } }); }
  case "screenshot": if (args.includes("gone")) err("WINDOW_NOT_FOUND", "Window 'gone' was not found"); ok({ data: "iVBOR", format: "png", width: 10, height: 10 });
  case "click": if (args[1] === "@s1:e3") err("STALE_REF", "ref no longer matches"); if (args[1] === "@s1:e4") fs.writeFileSync(${JSON.stringify(moved)}, ""); ok({ disposition: { delivery: "delivered_verified", retry: "unsafe" } });
  default: ok({ disposition: { delivery: "delivered_unverified" } });
}
`, { mode: 0o755 });
  const read = () => readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((a) => a[0] === "--session" ? a.slice(2) : a);
  const clear = () => writeFileSync(calls, "");
  try {
    const cfg = config(["com.hnc.Discord"], { appEngine: "agent-desktop", adCommand: fake });
    const s = new Session(cfg, "t");
    assert(/agent-desktop, which acts through accessibility/.test(s.instructions()), "instructions describe the agent-desktop engine");
    const apps = JSON.parse(text(await s.callTool("list_apps", {})));
    assert(apps.length === 1 && apps[0].id === "com.hnc.Discord" && apps[0].isRunning, "list_apps keeps to the allowlist and skips helpers");
    const t = text(await s.callTool("get_state", { app: "Discord" }));
    assert(t.includes("0 button Send") && t.includes("1 textfield (focused) Message, Value: hi, Secondary Actions: Focus"), "refs become element numbers");
    assert(t.includes("statictext hello ⏎ there") && t.includes("[4 children not shown]") && t.endsWith("The focused UI element is 1."), "text, cut branches and the focus line");
    assert(read().some((a) => a[0] === "snapshot" && a.includes("--app") && a[a.indexOf("--app") + 1] === "Discord"), "apps are addressed by their display name");
    clear();
    const c = text(await s.callTool("click", { app: "com.hnc.Discord", element: 0 }));
    assert(read()[0].join(" ") === "click @s1:e1" && c.startsWith("click: delivered_verified\nApp: Discord"), "click acts on the ref and returns a fresh tree");
    clear();
    await s.callTool("click", { app: "com.hnc.Discord", element: 1, button: "right" });
    await s.callTool("type_text", { app: "com.hnc.Discord", text: "yo" });
    await s.callTool("press_key", { app: "com.hnc.Discord", key: "super+Return" });
    await s.callTool("set_value", { app: "com.hnc.Discord", element: 1, value: "v" });
    await s.callTool("scroll", { app: "com.hnc.Discord", element: 2, direction: "down", pages: 2 });
    await s.callTool("secondary_action", { app: "com.hnc.Discord", element: 2, action: "Expand" });
    const acts = read().filter((a) => a[0] !== "snapshot").map((a) => a.join(" "));
    assert(acts[0] === "right-click @s1:e2" && acts[1] === "type @s1:e2 yo" && acts[2] === "press cmd+return --app Discord", "right-click, type into the focused element, keys to the app");
    assert(acts[3] === "set-value @s1:e2 v" && acts[4] === "scroll @s1:e3 --direction down --amount 6" && acts[5] === "expand @s1:e3", "set-value, scroll and secondary actions");
    clear();
    for (const [args, re] of [[{ x: 5, y: 5 }, /elements only/], [{ element: 0, count: 2 }, /double-click/]]) {
      const r = await s.callTool("click", { app: "com.hnc.Discord", ...args });
      assert(r.isError && re.test(text(r)), `physical input refused: ${re}`);
    }
    const dr = await s.callTool("drag", { app: "com.hnc.Discord", from_x: 1, from_y: 1, to_x: 2, to_y: 2 });
    const sa = await s.callTool("secondary_action", { app: "com.hnc.Discord", element: 0, action: "Raise" });
    assert(dr.isError && sa.isError && /supports these/.test(text(sa)) && !read().length, "drag and unknown secondary actions refused before the CLI runs");
    const stale = await s.callTool("click", { app: "com.hnc.Discord", element: 2 });
    assert(stale.isError && /^STALE_REF: ref no longer matches/.test(text(stale)), "CLI errors come back as tool errors");
    const gone = await s.callTool("click", { app: "com.hnc.Discord", element: 9 });
    assert(gone.isError && /not in the latest tree/.test(text(gone)), "unknown element numbers are refused");
    const term = await s.callTool("get_state", { app: "Terminal" });
    assert(term.isError && /not allowed/.test(text(term)), "the allowlist still applies");
    clear();
    const b = await s.callTool("batch", { app: "com.hnc.Discord", actions: [{ action: "click", element: 0 }, { action: "press_key", key: "Tab" }, { action: "click", element: 0 }] });
    const bs = read().map((a) => a[0]);
    assert(!b.isError && bs.join(",") === "click,press,click,snapshot", "a batch reads the tree once, after its last step");
    clear();
    const shot = await s.callTool("screenshot", { app: "com.hnc.Discord" });
    assert(shot.content[0].type === "image" && read().map((a) => a.join(" ")).join() === "screenshot --app Discord --window-id w1", "screenshot of the latest tree's window, without a tree");
    clear();
    s.engines.get("agent-desktop").trees.get("com.hnc.Discord").window = "gone";
    const again = await s.callTool("screenshot", { app: "com.hnc.Discord" });
    assert(!again.isError && read().map((a) => a[0] + (a.includes("--window-id") ? ` ${a.at(-1)}` : "")).join() === "screenshot gone,snapshot,screenshot w1", "a window that has gone is found again for the screenshot");
    clear();
    const gs = await s.callTool("get_state", { app: "com.hnc.Discord", screenshot: true });
    const plain = await s.callTool("get_state", { app: "com.hnc.Discord" });
    assert(gs.content.some((x) => x.type === "image") && !plain.content.some((x) => x.type === "image") && read().filter((a) => a[0] === "screenshot").length === 1, "screenshots only when asked for");
    assert(adKey("ctrl+shift+Tab") === "ctrl+shift+tab" && adKey("BackSpace") === "delete" && adKey("KP_5") === "5" && adKey("F5") === "f5" && adKey("A") === "A", "xdotool keys map to agent-desktop's");
    clear();
    // A click into another field, then typing, in one batch: typing follows the new focus while the
    // batch's element numbers stay those of the tree the client saw.
    const fb = await s.callTool("batch", { app: "com.hnc.Discord", actions: [{ action: "click", element: 3 }, { action: "type_text", text: "q" }, { action: "click", element: 0 }] });
    const fbs = read().filter((a) => a[0] !== "snapshot").map((a) => a.join(" "));
    assert(!fb.isError && fbs.join("|") === "click @s1:e4|type @s2:e4 q|click @s1:e1", "type_text in a batch follows focus moved by an earlier step");
    assert(text(fb).includes("The focused UI element is 3."), "the batch returns the tree after its last step");
    rmSync(moved, { force: true });
    await s.close();
    assert(read().some((a) => a.join(" ").startsWith("session end cub-")), "the agent-desktop session ends with the bridge session");
    assert(adTree({ app: "X", complete: false, tree: { role: "window" } }).text.includes("Partial tree"), "partial trees are flagged");
    const listed = adTree({ app: "X", tree: { ref_id: "@s:e1", role: "scrollarea", name: "Edit field", available_actions: ["Click", "Scroll", "SetFocus", "AXShowMenu"] } }).text;
    assert(/Secondary Actions: SetFocus, AXShowMenu$/m.test(listed) && adSecondary("SetFocus") === "focus" && adSecondary("Scroll") === undefined, "only secondary actions the adapter can perform are listed");
    const off = new AdError({ code: "WINDOW_NOT_FOUND", message: "Application 'Discord' is running but has no matching window", suggestion: "Wait for the app" });
    assert(/current desktop \(Space\)/.test(off.message) && /engineFor/.test(off.message), "a window on another desktop is explained");
    assert(new AdError({ code: "WINDOW_NOT_FOUND", message: "No window with id 7", suggestion: "Run list-windows" }).message.endsWith("(Run list-windows)"), "other window errors keep agent-desktop's suggestion");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 4j. open-computer-use renumbers elements on every call: numbers from the tree the client saw are
// mapped to the engine's latest tree (batch steps, screenshots), or refused when the element changed.
{
  const A = [
    "App=com.apple.calculator (pid 1)", 'Window: "Calculator", App: Calculator.',
    "0 standard window Calculator ID: main, Secondary Actions: Raise",
    "\t1 container ID: CalculatorKeypadView",
    "\t\t2 scroll area Description: Last Expression ID: LastExpression, Secondary Actions: Scroll Up",
    "\t\t\t3 text 2+2",
    "\t\t4 scroll area Description: Edit field ID: StandardInputView, Secondary Actions: Scroll Up, Scroll Down, Copy",
    "\t\t\t5 text 4",
    "\t\t6 button All Clear ID: AllClear",
    "\t\t7 button 6 ID: Six",
    "\t\t8 button Multiply ID: Multiply",
    "The focused UI element is 4.",
  ].join("\n");
  const B = A.replace(/\t\t2 scroll area[^\n]*\n\t\t\t3 text 2\+2\n/, "").replace(/^(\t*)(\d+) /gm, (m, t, n) => `${t}${Number(n) > 3 ? Number(n) - 2 : n} `).replace("text 4", "text 0");
  assert(ocuRemap(A, B, 7).index === 5 && ocuRemap(A, B, 8).index === 6 && ocuRemap(A, A, 7).index === 7, "elements are found again after the tree shifts");
  assert(/2\+2\) changed or is gone/.test(ocuRemap(A, B, 3).error) && /not in the latest tree/.test(ocuRemap(A, B, 99).error), "a vanished element is refused, not replaced");
  assert(ocuKey("checkbox (selected, settable) Bold ID: b, Secondary Actions: Uncheck") === ocuKey("checkbox Bold ID: b, Secondary Actions: Check"), "traits and secondary actions do not change an element's identity");
  assert(ocuKey("text field Message, Value: hi Placeholder: Say") === ocuKey("text field Message, Value: hello there Placeholder: Say") && ocuKey("button Go Frame: {1, 2}") === ocuKey("button Go Frame: {5, 6}"), "nor do values and frames");
  const rows = (pre) => [...pre, "\t1 row", "\t2 row"].join("\n");
  assert(ocuRemap(rows([]), rows(["\t0 group"]).replace(/\t1 row\n\t2 row/, "\t1 group\n\t2 row\n\t3 row"), 2).index === 3, "identical elements keep their order");
  assert(/several/.test(ocuRemap(rows([]), "\t0 row\n\t1 row\n\t2 row", 1).error), "a duplicate whose count changed is ambiguous");
  assert(/several alike/.test(ocuRemap("\t0 button Delete\n\t1 button Delete", "\t0 button Delete", 1).error), "two identical elements becoming one is refused, not redirected");

  const c = new OcuChild({}, "t");
  const sent = [];
  const replies = [];
  c.request = async (method, params) => { sent.push(params); return replies.shift(); };
  const tree = (t) => ({ content: [{ type: "text", text: t }] });
  replies.push(tree(A));
  await c.call("get_app_state", { app: "calc" }, 1000);
  replies.push(tree(B), tree(B), tree(B));
  await c.call("click", { app: "calc", element_index: "6" }, 1000, { quiet: true });
  await c.call("click", { app: "calc", element_index: "7" }, 1000, { quiet: true });
  await c.call("click", { app: "calc", element_index: "8" }, 1000);
  assert(sent.slice(1).map((p) => p.arguments.element_index).join() === "6,5,6", "batch steps after a change use the latest numbering");
  replies.push(tree(B));
  await c.call("click", { app: "calc", element_index: "5" }, 1000);
  assert(sent.at(-1).arguments.element_index === "5", "after a tree the client saw, its numbers are used as they are");
  replies.push({ content: [{ type: "text", text: A }, { type: "image", mimeType: "image/png", data: "" }] });
  await c.call("get_app_state", { app: "calc", max_tree_nodes: 1 }, 1000);
  assert(sent.at(-1).arguments.max_tree_nodes === undefined, "a screenshot keeps the engine's whole numbering");
  replies.push(tree(A));
  await c.call("click", { app: "calc", element_index: "5" }, 1000);
  assert(sent.at(-1).arguments.element_index === "7", "numbers from before a screenshot follow the window it showed");
  c.shown.set("calc", A);
  c.latest.set("calc", B);
  const n = sent.length;
  const gone = await c.call("click", { app: "calc", element_index: "3" }, 1000);
  assert(gone.isError && sent.length === n && /nothing was done/.test(gone.content[0].text) && gone.content[1].text === B && c.shown.get("calc") === B, "a changed element is refused with the window as it is now");
  const unknown = await c.call("click", { app: "calc", element_index: "99" }, 1000);
  assert(unknown.isError && sent.length === n && /not in your latest tree/.test(text(unknown)), "a number the client never saw is refused without calling the engine");
  const refuse = { isError: true, content: [{ type: "text", text: "type_text requires a focused editable text element. Click a text entry area first." }] };
  replies.push(refuse, ...Array(5).fill(tree(B)));
  const before = sent.length;
  const typed = await c.call("type_text", { app: "calc", text: "1A+3=" }, 1000);
  assert(!typed.isError && sent.slice(before + 1).map((p) => `${p.name}:${p.arguments.key}`).join() === "press_key:1,press_key:shift+a,press_key:kp_add,press_key:3,press_key:kp_equal" && /pressed key by key/.test(typed.content[0].text), "type_text without a focused field presses the keys");
  replies.push(refuse);
  const odd = await c.call("type_text", { app: "calc", text: "a,b" }, 1000);
  assert(odd.isError && /use press_key/.test(text(odd)), "text with keys open-computer-use cannot name is refused with a hint");
  assert(ocuTypeKeys("") === null && ocuTypeKeys("x".repeat(201)) === null && ocuTypeKeys("Hi 2\n").join() === "shift+h,i,space,2,return", "typing keys: limits and names");

  const s = new Session(config(["com.apple.calculator"]), "t");
  s.apps = async () => [{ id: "com.apple.calculator", displayName: "Calculator" }];
  const e = new OcuChild({}, "t");
  const got = [];
  const answers = [tree(A), tree(B), tree(B), tree(B)];
  e.request = async (method, params) => { got.push(params.arguments.element_index); return answers.shift(); };
  s.cua = async () => e;
  await s.callTool("get_state", { app: "Calculator" });
  const b = await s.callTool("batch", { app: "Calculator", actions: [6, 7, 8].map((element) => ({ action: "click", element })) });
  assert(!b.isError && got.slice(1).join() === "6,5,6" && text(b).includes("8 button Multiply") === false && text(b).includes("6 button Multiply"), "a batch clicks what the client saw, and returns the latest tree");
}

// 4h. CLI arguments, service files and the remote command connect runs.
{
  const o = parseArgs(["setup", "--apps", "agent-desktop", "--allow=com.hnc.Discord", "--engine-for", "a.b=open-computer-use", "--tabs", "chrome", "--yes", "--no-install"]);
  assert(o.apps === "agent-desktop" && o.allow === "com.hnc.Discord" && o.engineFor === "a.b=open-computer-use" && o.tabs === "chrome" && o.yes && o.install === false && o.service, "setup flags, with = or a separate value");
  const c = parseArgs(["connect", "pikachu", "--name", "mac", "--print"]);
  assert(c.host === "pikachu" && c.name === "mac" && c.print, "connect takes a host and options");
  let threw = 0;
  for (const bad of [["setup", "--json"], ["status", "--apps", "x"], ["setup", "--apps"], ["bogus"], ["connect", "a", "b"]]) { try { parseArgs(bad); } catch { threw++; } }
  assert(threw === 5, "unknown, misplaced and valueless arguments are refused");
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

// 4i. Engine permission output: open-computer-use doctor (JSON, or text from older versions) and
// agent-desktop's permissions envelope; granted, missing and broken answers.
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
    const ad = async (body) => adPermissions({ adCommand: script(`ad${Math.random()}`, body) });
    r = await ad(`echo '{"version":"2.5","ok":true,"command":"permissions","data":{"accessibility":{"state":"granted"},"screen_recording":{"state":"granted"}}}'`);
    assert(r.ok && !r.warn, "agent-desktop: granted");
    r = await ad(`echo '{"version":"2.5","ok":true,"command":"permissions","data":{"accessibility":{"state":"granted"},"screen_recording":{"state":"denied"}}}'`);
    assert(r.ok && r.warn, "agent-desktop: no Screen Recording only warns (screenshots)");
    r = await ad(`echo '{"version":"2.5","ok":true,"command":"permissions","data":{"accessibility":{"state":"denied"},"screen_recording":{"state":"denied"}}}'`);
    assert(!r.ok && r.human && /Accessibility denied/.test(r.what), "agent-desktop: denied needs a person");
    r = await ad(`echo "not json"; exit 1`);
    assert(!r.ok && !r.human && /permissions check failed/.test(r.what), "agent-desktop: an unreadable answer is a failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert(configPath("./x.json") === join(process.cwd(), "x.json") && configPath("~/c.json").startsWith("/") && !configPath("~/c.json").includes("~"), "config paths become absolute for the service");
}

// 5. The tab tree: numbering, flattening and element mapping.
{
  const nodes = [
    { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" }, childIds: ["2", "6"], backendDOMNodeId: 10, properties: [{ name: "url", value: { value: "https://a/" } }] },
    { nodeId: "2", parentId: "1", role: { value: "generic" }, name: { value: "" }, childIds: ["3"], backendDOMNodeId: 11 },
    { nodeId: "3", parentId: "2", role: { value: "link" }, name: { value: "Home" }, childIds: ["4"], backendDOMNodeId: 12, properties: [{ name: "url", value: { value: "https://a/home" } }, { name: "focused", value: { value: true } }] },
    { nodeId: "4", parentId: "3", role: { value: "StaticText" }, name: { value: "Home" }, childIds: ["5"], backendDOMNodeId: 13 },
    { nodeId: "5", parentId: "4", role: { value: "InlineTextBox" }, name: { value: "Home" }, backendDOMNodeId: 14 },
    { nodeId: "6", parentId: "1", role: { value: "textbox" }, name: { value: "Search" }, value: { value: "pika" }, ignored: false, backendDOMNodeId: 15, childIds: [] },
  ];
  const b = fakeBrowser(config(["com.brave.Browser"]), [5], async (m) => (m === "Accessibility.getFullAXTree" ? { nodes } : {}));
  const t = await b.tree(5);
  const lines = t.split("\n");
  assert(lines[1] === "0 web area Page, URL: https://a/", "root line");
  assert(lines[2] === "\t1 link (focused) Home, URL: https://a/home", "generic flattened, link with flags and URL");
  assert(lines[3] === "\t2 textbox Search, Value: pika" && lines.length === 4, "text repeating its parent's name is dropped");
  assert(b.node(5, 1) === 12 && b.node(5, 2) === 15, "element numbers map to DOM nodes");
  let threw = false;
  try { b.node(5, 9); } catch (e) { threw = /latest tree/.test(e.message); }
  assert(threw, "an unknown element number is refused");
}

// 6. eval_tab reports side effects as read-only.
{
  const cfg = config(["com.brave.Browser"]);
  const s = new Session(cfg, "t");
  s.obu = fakeBrowser(cfg, [5], async (m, p) => (m === "Runtime.evaluate" && p.throwOnSideEffect
    ? { exceptionDetails: { exception: { description: "EvalError: Possible side-effect in debug-evaluate" } } }
    : {}));
  const r = await s.callTool("eval_tab", { tab: "5", expression: "document.title = 'x'" });
  assert(r.isError && /read-only/.test(text(r)), "side effects are refused as read-only");
  const exprs = [];
  s.obu = fakeBrowser(cfg, [5], async (m, p) => {
    if (m === "Runtime.evaluate") exprs.push(p.expression);
    return m === "Runtime.evaluate" ? { result: { value: "<h1>x</h1>" } } : m === "DOM.resolveNode" ? { object: { objectId: "o1" } } : m === "Runtime.callFunctionOn" ? { exceptionDetails: { exception: { description: "Error: not a field\n    at Text.<anonymous>" } } } : {};
  });
  const dom = await s.callTool("read_tab", { tab: "5", format: "dom", selector: "h1" });
  assert(!dom.isError && /querySelector\("h1"\)/.test(exprs.at(-1)) && /outerHTML/.test(exprs.at(-1)), "read_tab dom reads the selector's element");
  s.obu.elements.set(5, new Map([[0, 42]]));
  const sv = await s.callTool("set_value", { tab: "5", element: 0, value: "x" });
  assert(sv.isError && /does not take a value/.test(text(sv)) && !/at Text/.test(text(sv)), "set_value on a non-field is refused plainly");
}

// 7. Keys for CDP.
{
  const k = cdpKey("super+a");
  assert(k.modifiers === 4 && k.commands?.[0] === "selectAll" && !k.text, "super+a selects all, without text");
  assert(cdpKey("Return").text === "\r" && cdpKey("Return").windowsVirtualKeyCode === 13, "Return types a carriage return");
  assert(cdpKey("shift+a").key === "A" && cdpKey("shift+a").text === "A", "shift capitalizes letters");
  let threw = false;
  try { cdpKey("hyper+a"); } catch { threw = true; }
  assert(threw, "an unknown modifier is refused");
  const sh = cdpKey("shift");
  assert(sh.key === "Shift" && sh.code === "ShiftLeft" && sh.modifiers === 8 && !sh.text && cdpKey("Control_L").modifiers === 2 && cdpKey("super").key === "Meta", "modifiers work as keys on their own (held in games)");
  assert(pwKey("Control+A") === "ctrl+A" && pwKey("Enter") === "Return" && pwKey("Shift+ArrowDown") === "shift+Down", "Playwright key names map to xdotool");
}

// 8. Finding the open-browser-use socket when active.json is missing or stale.
{
  const dir = mkdtempSync(join(tmpdir(), "cub-obu-"));
  const reg = join(dir, "active.json");
  const servers = [];
  const listen = (name) => new Promise((resolve) => {
    const s = createServer((c) => c.on("error", () => {})).listen(join(dir, name), () => resolve(join(dir, name)));
    servers.push(s);
  });
  const attempt = async (cfg) => {
    const b = new ObuBrowser({ obuRegistry: reg, ...cfg }, "check");
    try { await b.connect(); return { ok: true, scanned: b.scanned }; } catch (e) { return { ok: false, error: e.message }; } finally { b.sock?.destroy(); }
  };
  try {
    writeFileSync(join(dir, "dead.sock"), "");
    let r = await attempt({});
    assert(!r.ok && /not connected/.test(r.error) && /no live socket/.test(r.error), "no registry and no live socket is a clear error");
    const a = await listen("a.sock");
    r = await attempt({});
    assert(r.ok && r.scanned.includes(a) && r.scanned.includes("no "), "no registry: the only live socket is used, skipping dead ones");
    writeFileSync(reg, JSON.stringify({ socketPath: join(dir, "gone.sock") }));
    r = await attempt({});
    assert(r.ok && /unreachable/.test(r.scanned), "registry naming a dead socket falls back to the scan");
    writeFileSync(reg, JSON.stringify({ socketPath: a }));
    r = await attempt({});
    assert(r.ok && r.scanned === null, "a working registry is used without scanning");
    const b = await listen("b.sock");
    writeFileSync(reg, "{");
    r = await attempt({});
    assert(!r.ok && /2 browsers/.test(r.error) && r.error.includes(a) && r.error.includes(b), "two live sockets without a registry are refused");
    r = await attempt({ obuSocket: b });
    assert(r.ok && r.scanned === null, "obuSocket picks one");
    r = await attempt({ obuSocket: join(dir, "gone.sock") });
    assert(!r.ok && /obuSocket/.test(r.error), "an unreachable obuSocket does not fall back");
  } finally {
    for (const s of servers) s.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

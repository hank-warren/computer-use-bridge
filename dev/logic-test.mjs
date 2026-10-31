#!/usr/bin/env node
// Engine-free tests: tool definitions, result shaping, the tab tree, key mapping, and the
// rules that keep agents to allowed apps and their own tabs. Loads computer-use-bridge.mjs
// without its CLI entry point and replaces open-computer-use and open-browser-use with fakes.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../computer-use-bridge.mjs"), "utf8");
const cli = src.lastIndexOf("\ntry {\n  const opts = parseArgs");
if (cli < 0) throw new Error("CLI entry point not found");
const dir = mkdtempSync(join(tmpdir(), "cub-test-"));
const file = join(dir, "bridge.mjs");
writeFileSync(file, src.slice(0, cli) + "\nexport { Session, ObuBrowser, cdpKey, pwKey, toolDefs, toolSchema, adKey, adTree };\n");
const { Session, ObuBrowser, cdpKey, pwKey, toolDefs, toolSchema, adKey, adTree } = await import(pathToFileURL(file));
rmSync(dir, { recursive: true, force: true });

const assert = (c, m) => { if (!c) { console.log("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const config = (allowApps) => {
  const ids = new Set(allowApps.map((x) => x.toLowerCase()));
  return { engineIdleMinutes: 0, approve: "allowlist", appsOn: true, allowApps, isAllowed: (id) => typeof id === "string" && ids.has(id.toLowerCase()) };
};

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

// 4f. The agent-desktop engine: same tools, element numbers mapped to snapshot refs, headless only.
{
  const dir = mkdtempSync(join(tmpdir(), "cub-ad-"));
  const calls = join(dir, "calls.jsonl");
  const fake = join(dir, "agent-desktop");
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
  case "snapshot": ok({ app: "Discord", window: { title: "general" }, snapshot_id: "s1", complete: true, tree: { role: "window", name: "general", children: [
    { role: "statictext", name: "hello\\nthere" },
    { ref_id: "@s1:e1", role: "button", name: "Send", states: ["enabled"], available_actions: ["Click"] },
    { ref_id: "@s1:e2", role: "textfield", name: "Message", value: "hi", states: ["focused"], available_actions: ["Click", "Focus"] },
    { ref_id: "@s1:e3", role: "disclosure", name: "Channels", available_actions: ["Expand"], children_count: 4 } ] } });
  case "screenshot": ok({ data: "iVBOR", format: "png", width: 10, height: 10 });
  case "click": if (args[1] === "@s1:e3") err("STALE_REF", "ref no longer matches"); ok({ disposition: { delivery: "delivered_verified", retry: "unsafe" } });
  default: ok({ disposition: { delivery: "delivered_unverified" } });
}
`, { mode: 0o755 });
  const read = () => readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((a) => a[0] === "--session" ? a.slice(2) : a);
  const clear = () => writeFileSync(calls, "");
  try {
    const cfg = { ...config(["com.hnc.Discord"]), appEngine: "agent-desktop", adCommand: fake };
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
    assert(shot.content[0].type === "image" && read().map((a) => a[0]).join() === "screenshot", "screenshot without a tree");
    clear();
    const gs = await s.callTool("get_state", { app: "com.hnc.Discord", screenshot: true });
    const plain = await s.callTool("get_state", { app: "com.hnc.Discord" });
    assert(gs.content.some((x) => x.type === "image") && !plain.content.some((x) => x.type === "image") && read().filter((a) => a[0] === "screenshot").length === 1, "screenshots only when asked for");
    assert(adKey("ctrl+shift+Tab") === "ctrl+shift+tab" && adKey("BackSpace") === "delete" && adKey("KP_5") === "5" && adKey("F5") === "f5" && adKey("A") === "A", "xdotool keys map to agent-desktop's");
    await s.close();
    assert(read().some((a) => a.join(" ").startsWith("session end cub-")), "the agent-desktop session ends with the bridge session");
    assert(adTree({ app: "X", complete: false, tree: { role: "window" } }).text.includes("Partial tree"), "partial trees are flagged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

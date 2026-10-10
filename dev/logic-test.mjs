#!/usr/bin/env node
// Engine-free tests: tool definitions, result shaping, the tab tree, key mapping, and the
// rules that keep agents to allowed apps and their own tabs. Loads computer-use-bridge.mjs
// without its CLI entry point and replaces open-computer-use and open-browser-use with fakes.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../computer-use-bridge.mjs"), "utf8");
const cli = src.lastIndexOf("\ntry {\n  const opts = parseArgs");
if (cli < 0) throw new Error("CLI entry point not found");
const dir = mkdtempSync(join(tmpdir(), "cub-test-"));
const file = join(dir, "bridge.mjs");
writeFileSync(file, src.slice(0, cli) + "\nexport { Session, ObuBrowser, cdpKey, pwKey, toolDefs, toolSchema };\n");
const { Session, ObuBrowser, cdpKey, pwKey, toolDefs, toolSchema } = await import(pathToFileURL(file));
rmSync(dir, { recursive: true, force: true });

const assert = (c, m) => { if (!c) { console.log("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const config = (allowApps) => {
  const ids = new Set(allowApps.map((x) => x.toLowerCase()));
  return { engineIdleMinutes: 0, approve: "allowlist", allowApps, isAllowed: (id) => typeof id === "string" && ids.has(id.toLowerCase()) };
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

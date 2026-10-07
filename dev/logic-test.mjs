#!/usr/bin/env node
// Engine-free tests of the bridge's result handling (tree capping, output markers), the
// detached-debugger retry rules, and open_tab's generated code against a fake browser.
// Loads computer-use-bridge.mjs without its CLI entry point and mocks the engine.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../computer-use-bridge.mjs"), "utf8");
const cli = src.lastIndexOf("\ntry {\n  const opts = parseArgs");
if (cli < 0) throw new Error("CLI entry point not found");
const dir = mkdtempSync(join(tmpdir(), "cub-test-"));
const file = join(dir, "bridge.mjs");
writeFileSync(file, src.slice(0, cli) + "\nexport { Session, MARK };\n");
const { Session, MARK } = await import(pathToFileURL(file));
rmSync(dir, { recursive: true, force: true });

const assert = (c, m) => { if (!c) { console.log("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };
const mk = () => {
  const s = new Session({ surface: "fixed", engineIdleMinutes: 0, approve: "all", allowApps: [], isAllowed: () => true }, "t");
  s.stopEngine = async () => { s.stops = (s.stops ?? 0) + 1; return true; };
  return s;
};

// A fake cua_repl: runs the generated code against fake globals. Displayed states come
// before the bridge's writes, as in cua_repl; an uncaught error comes first.
const AsyncFunction = (async () => {}).constructor;
function fakeEngine(s, env) {
  s.cua = async () => ({
    call: async (_, { code }) => {
      const writes = [];
      env.states = [];
      const nodeRepl = { write: (t) => writes.push(t), emitImage: async () => {} };
      const blocks = () => [...env.states.map((text) => ({ type: "text", text })), { type: "text", text: writes.join("") }];
      try {
        await new AsyncFunction("nodeRepl", "cua", "agent", code)(nodeRepl, env.cua, env.agent);
        return { content: blocks(), isError: false };
      } catch (e) {
        return { content: [{ type: "text", text: e.message }, ...blocks()], isError: true };
      }
    },
  });
  globalThis.__cub = undefined;
}

// 1. The cap: only trees, surrogate-safe, open_tab keeps its first line.
{
  const s = mk();
  const big = "x".repeat(19999) + "😀" + "y".repeat(5000);
  const env = {};
  fakeEngine(s, env);
  env.cua = {
    listBrowsers: async () => [{ id: "b1", family: "brave", name: "Brave" }],
    getTab: async () => { env.states.push(big); return { getAXState: async () => big }; },
  };
  env.agent = { browsers: { get: async () => ({ user: { openTabs: async () => [{ id: "1", title: "t".repeat(40000), url: "https://a/" }] } }) } };
  const r = await s.callFixed("get_state", { tab: "123" });
  const tree = r.content[0].text;
  assert(tree.includes("[Tree truncated: showing 19999 of"), "state block cut before the surrogate pair");
  assert(!/[\uD800-\uDBFF]\n/.test(tree), "no lone high surrogate");
  assert(tree.includes("full: true"), "notice mentions full: true");
  const lt = await s.callFixed("list_tabs", {});
  assert(JSON.parse(lt.content.at(-1).text).length === 1, "list_tabs JSON is not cut");
  assert(JSON.stringify(lt).indexOf("kind") < 0, "kind does not leak into JSON");
  // Page text that happens to hold a marker-like string is still a tree.
  const fake = "[[cub-out]]" + "x".repeat(30000);
  env.cua.getTab = async () => { env.states.push(fake); return {}; };
  const r2 = await s.callFixed("get_state", { tab: "124" });
  assert(r2.content[0].text.includes("[Tree truncated"), "a tree holding a marker-like string is capped");
  assert(!MARK.endsWith("out]]"), "markers carry a nonce");
  // open_tab: a tiny cap must keep the "Opened tab N" line.
  const s2 = mk();
  s2.cfg.treeMaxChars = 10;
  s2.js = async () => Object.defineProperty({ content: [Object.defineProperty({ type: "text", text: "Opened tab 2043252019 in Brave.\n" + "y".repeat(100) }, "kind", { value: "out" })], isError: false }, "started", { value: false });
  const ot = await s2.callFixedOnce("open_tab", { url: "https://example.com/" });
  assert(ot.content[0].text.startsWith("Opened tab 2043252019 in Brave.\nyyyyyyyyyy\n[Tree truncated"), "open_tab keeps its first line whole");
}

// 2. callFixed retry rules, with callFixedOnce mocked.
const DET = { content: [{ type: "text", text: "Error: Debugger unattached" }], isError: true };
const OK = { content: [{ type: "text", text: "TREE" }], isError: false };
const res = (r, f = {}) => Object.defineProperties(structuredClone(r), { started: { value: !!f.started }, ran: { value: !!f.ran } });
async function scenario(name, a, seq) {
  const s = mk();
  const calls = [];
  s.callFixedOnce = async (n, args) => {
    calls.push(`${n}:${args.rebind === true}`);
    if (s.stops) s.notice = "engine restarted"; // as Session.cua() does for a new engine
    const [r, f] = seq.shift();
    return res(r, f);
  };
  const r = await s.callFixed(name, a);
  return { r, calls: calls.join(","), stops: s.stops ?? 0, notice: s.notice, head: r.content[0].text };
}
const loc = { tab: "1", css: "a", action: "click" };
let x;
x = await scenario("tab_locator", loc, [[DET], [OK]]);
assert(x.calls === "tab_locator:false,tab_locator:true" && /re-attached it and retried/.test(x.head), "nothing started: re-attach and replay");
x = await scenario("tab_locator", loc, [[DET], [DET], [OK]]);
assert(x.stops === 1 && x.calls === "tab_locator:false,tab_locator:true,tab_locator:false" && /restarted the engine/.test(x.head), "nothing started: restart and replay");
assert(x.notice === null, "restart: the generic restart notice is dropped");
x = await scenario("click", { tab: "1", element: 4 }, [[DET], [OK]]);
assert(x.calls === "click:false,get_state:true" && x.r.isError && /did NOT run/.test(x.head), "element click: not replayed, fresh tree");
x = await scenario("click", { tab: "1", element: 4 }, [[DET], [DET], [OK]]);
assert(x.stops === 1 && x.calls.endsWith("get_state:false") && /restarted the engine.*did NOT run/.test(x.head), "element click: restart, still not replayed");
x = await scenario("batch", { tab: "1", actions: [{ action: "press_key", key: "a" }, { action: "click", element: 3 }] }, [[DET], [OK]]);
assert(x.calls === "batch:false,get_state:true", "batch with an element step: not replayed");
x = await scenario("tab_locator", loc, [[DET, { started: true }], [OK]]);
assert(x.calls === "tab_locator:false,get_state:true" && x.r.isError && /may or may not/.test(x.head), "started but not finished: not replayed");
x = await scenario("tab_locator", loc, [[DET, { started: true, ran: true }], [OK]]);
assert(x.calls === "tab_locator:false,get_state:true" && !x.r.isError && /ran.*Do not repeat/.test(x.head), "ran: fresh tree, not replayed");
x = await scenario("batch", { tab: "1", actions: [{ action: "press_key", key: "a" }] }, [[DET], [DET, { started: true }], [OK]]);
assert(x.calls === "batch:false,batch:true,get_state:false" && x.stops === 1 && /may or may not/.test(x.head), "replay that started: not replayed again");
x = await scenario("tab_locator", loc, [[DET], [DET], [DET]]);
assert(/^The tab's debugger detached and even a new engine/.test(x.head), "stuck after restart");
x = await scenario("click", { app: "Discord", element: 4 }, [[DET]]);
assert(x.calls === "click:false", "app targets are not retried");

// 3. Generated code: an action that has effects and then fails is marked as started.
{
  const s = mk();
  const env = {};
  let clicks = 0;
  fakeEngine(s, env);
  const tab = {
    getAXState: async () => { env.states.push("TREE"); return "TREE"; },
    playwright: { locator: () => ({ click: async () => { clicks++; throw new Error("Debugger unattached"); } }) },
  };
  env.cua = { listBrowsers: async () => [{ id: "b1", family: "brave", name: "Brave" }], getTab: async () => { env.states.push("TREE"); return tab; } };
  const r = await s.callFixed("tab_locator", loc);
  assert(clicks === 1 && /may or may not/.test(r.content[0].text), "a click that fails after its effect is not replayed");
}

// 4. open_tab's generated code against a fake browser.
async function openTab({ onNewTab } = {}) {
  const s = mk();
  const env = {};
  fakeEngine(s, env);
  const tabs = [{ id: "u1", url: "https://user/" }];
  const typed = [];
  let pasted = "";
  const win = {
    getAXState: async () => "WIN",
    pressKey: async (k) => {
      typed.push(k);
      if (k === "super+t") { tabs.unshift({ id: "new", url: "chrome://newtab/" }); onNewTab?.(tabs); }
      if (k === "Return") tabs[0].url = pasted;
    },
    paste: async (t) => { typed.push("paste"); pasted = t; },
  };
  env.cua = {
    listBrowsers: async () => [{ id: "b1", family: "brave", name: "Brave" }],
    getApp: async () => win,
    getTab: async (id) => ({ getAXState: async () => `TREE of ${id}` }),
  };
  env.agent = { browsers: { get: async () => ({ user: { openTabs: async () => tabs.map((t) => ({ ...t })) } }) } };
  const r = await s.callFixed("open_tab", { url: "https://example.com/" });
  return { r, typed, tabs, text: r.content.map((c) => c.text).join("\n") };
}
x = await openTab();
assert(!x.r.isError && /Opened tab new in Brave/.test(x.text) && x.tabs[0].url === "https://example.com/", "open_tab: normal path");
x = await openTab({ onNewTab: (tabs) => tabs.unshift({ id: "u2", url: "chrome://newtab/" }) });
assert(x.r.isError && /another tab was opened/.test(x.text) && !x.typed.includes("paste"), "open_tab: a second new tab aborts before typing");
x = await openTab({ onNewTab: (tabs) => tabs.unshift(tabs.splice(1, 1)[0]) });
assert(x.r.isError && /another tab was focused/.test(x.text) && !x.typed.includes("paste") && x.tabs.find((t) => t.id === "u1").url === "https://user/", "open_tab: focus moved to the user's tab aborts before typing");

#!/usr/bin/env node
// Live test of every tool against a real machine: apps on Calculator (macOS) and browser tabs on
// example.com and httpbin.org. Run it before bumping an engine pin.
//
//   node dev/live-test.mjs [--apps] [--tabs] [--out DIR] -- COMMAND [ARGS...]     (stdio)
//   node dev/live-test.mjs [--apps] [--tabs] [--out DIR] --url URL --token-file FILE  (HTTP)
//
// e.g. -- ssh -T HOST node .../bin/computer-use-bridge.mjs stdio --config /tmp/cubtest/config.json
// The config must allow com.apple.calculator for --apps and serve tabs for --tabs (both by
// default). Calculator is launched in the background and left open; agent tabs are closed.
// Exits 1 if a check fails.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const opts = sep < 0 ? argv : argv.slice(0, sep);
const flag = (name) => opts.includes(name);
const value = (name) => (opts.includes(name) ? opts[opts.indexOf(name) + 1] : undefined);
const url = value("--url");
if (sep < 0 && !url) throw new Error("usage: live-test.mjs [--apps] [--tabs] [--out DIR] (-- COMMAND [ARGS...] | --url URL --token-file FILE)");
const runApps = flag("--apps") || !flag("--tabs");
const runTabs = flag("--tabs") || !flag("--apps");
const out = value("--out") ?? mkdtempSync(join(tmpdir(), "live-test-"));
mkdirSync(out, { recursive: true });

// Transport: one MCP session over stdio or HTTP.
let rpc;
if (url) {
  const token = readFileSync(value("--token-file"), "utf8").trim();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  let id = 0;
  rpc = async (method, params, notify = false) => {
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++id, method, params }) });
    headers["mcp-session-id"] ??= r.headers.get("mcp-session-id");
    const t = await r.text();
    if (notify) return null;
    return JSON.parse(t.startsWith("{") ? t : t.split("\n").filter((l) => l.startsWith("data:")).pop().slice(5));
  };
  process.on("exit", () => {});
} else {
  const [cmd, ...args] = argv.slice(sep + 1);
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  let id = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  rpc = (method, params, notify = false) => {
    if (notify) return child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    return new Promise((resolve) => {
      pending.set(++id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
  process.on("exit", () => child.stdin.end());
}

let shots = 0;
async function call(name, args = {}) {
  const t0 = Date.now();
  const res = await rpc("tools/call", { name, arguments: args });
  const r = res.result ?? { isError: true, content: [{ type: "text", text: JSON.stringify(res.error) }] };
  const images = [];
  for (const c of r.content ?? []) {
    if (c.type !== "image") continue;
    const file = join(out, `${String(++shots).padStart(2, "0")}-${name}.${c.mimeType.split("/")[1]}`);
    writeFileSync(file, Buffer.from(c.data, "base64"));
    images.push(file);
  }
  const text = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { text, images, isError: Boolean(r.isError), ms: Date.now() - t0 };
}

let failures = 0;
function check(label, ok, r, detail = "") {
  if (!ok) failures++;
  const why = !ok && r?.isError ? r.text.split("\n")[0].slice(0, 240) : detail;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${r ? ` (${r.ms} ms)` : ""}${why ? ` — ${why}` : ""}`);
}
const note = (label, detail) => console.log(`note ${label} — ${detail}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "live-test", version: "0" } });
await rpc("notifications/initialized", {}, true);
const tools = (await rpc("tools/list", {})).result.tools.map((t) => t.name);
console.log(`${init.result.serverInfo.name} ${init.result.serverInfo.version}: ${tools.length} tools; images in ${out}`);

if (runApps) {
  // Element lines look like "17 button 2 ID: Two" (open-computer-use) or "15 button 2, ..." (agent-desktop).
  const app = "com.apple.calculator";
  let tree = "";
  const keep = (r) => {
    if (!r.isError && /^\s*\d+ /m.test(r.text)) tree = r.text;
    return r;
  };
  const button = (name) => {
    const m = new RegExp(`^\\s*(\\d+) button (?:\\([^)]*\\) )?${esc(name)}(?:,| ID:| Help:|$)`, "m").exec(tree);
    return m ? Number(m[1]) : undefined;
  };
  const clear = () => button("All Clear") ?? button("Clear");
  const display = (text = tree) => (/Edit field[^\n]*\n\s*(?:\d+ )?(?:static)?text (.*)/.exec(text)?.[1] ?? "?").replace(/[\u200e\u200f\u202a-\u202e]/g, "").trim();

  console.log("\n# Apps (Calculator)");
  let r = await call("launch_app", { app });
  check("launch_app", !r.isError, r);
  await sleep(1500);
  r = await call("list_apps");
  check("list_apps lists Calculator", r.text.includes(app), r);
  r = keep(await call("get_state", { app }));
  check("get_state numbers the keypad", button("2") !== undefined && button("Equals") !== undefined, r, `display ${display()}`);

  for (const b of ["clear", "2", "Add", "2", "Equals"]) keep(await call("click", { app, element: b === "clear" ? clear() : button(b) }));
  r = { ms: 0, text: tree };
  check("click 2 + 2 = one call each", display() === "4", null, `display ${display()}`);

  r = keep(await call("batch", { app, actions: [clear(), button("6"), button("Multiply"), button("7"), button("Equals")].map((element) => ({ action: "click", element })) }));
  check("batch 6 × 7 =", !r.isError && display(r.text) === "42", r, `display ${display(r.text)}`);

  keep(await call("click", { app, element: clear() }));
  r = keep(await call("type_text", { app, text: "12+3=" }));
  if (r.isError && /focused element/.test(r.text)) note("type_text", `this engine types only into a focused text field: ${r.text.split("\n")[0].slice(0, 120)}`);
  else check("type_text 12+3=", !r.isError && display(r.text) === "15", r, `display ${display(r.text)}`);

  keep(await call("click", { app, element: clear() }));
  r = keep(await call("press_key", { app, key: "9" }));
  check("press_key 9", !r.isError && display(r.text) === "9", r, `display ${display(r.text)}`);
  r = keep(await call("press_key", { app, key: "Escape" }));
  check("press_key Escape clears", !r.isError && display(r.text) === "0", r, `display ${display(r.text)}`);

  const field = Number(/^\s*(\d+) scroll ?area[^\n]*Edit field/m.exec(tree)?.[1]);
  r = keep(await call("scroll", { app, element: field, direction: "down", pages: 1 }));
  if (r.isError && /CannotComplete|-25204/.test(r.text)) note("scroll the display", `the app refused it: ${r.text.split("\n")[0].slice(0, 120)}`);
  else check("scroll the display", !r.isError, r);
  const secondary = /^\s*(\d+) [^\n]*Edit field[^\n]*Secondary Actions: ([^\n]*)/m.exec(tree);
  const action = secondary?.[2].split(", ").find((a) => /^(Scroll Down|SetFocus)$/.test(a));
  if (action) {
    r = keep(await call("secondary_action", { app, element: Number(secondary[1]), action }));
    if (r.isError && /AXUIElementPerformAction|ACTION_FAILED|not supported/i.test(r.text)) note(`secondary_action ${action}`, `the app refused it: ${r.text.split("\n")[0].slice(0, 120)}`);
    else check(`secondary_action ${action}`, !r.isError, r);
  } else note("secondary_action", "the display lists no harmless secondary action");
  const settable = /^\s*(\d+) [^\n]*settable/m.exec(tree);
  if (!settable) note("set_value", "Calculator has no settable element; the tab test covers set_value");

  keep(await call("click", { app, element: clear() }));
  const two = button("2");
  r = await call("screenshot", { app });
  check("screenshot", r.images.length === 1, r, r.text.split("\n")[0]);
  r = keep(await call("click", { app, element: two }));
  check("an element number from before a screenshot still works", !r.isError && display(r.text) === "2", r, `display ${display(r.text)}`);
  r = keep(await call("get_state", { app, screenshot: true }));
  check("get_state with screenshot", r.images.length === 1 && button("2") !== undefined, r);
  r = keep(await call("drag", { app, from_x: 60, from_y: 60, to_x: 80, to_y: 60 }));
  if (r.isError && /cannot drag/.test(r.text)) note("drag", "this engine cannot drag (expected for agent-desktop)");
  else check("drag inside the window", !r.isError, r);

  r = await call("click", { app, element: 9999 });
  check("unknown element number is refused", r.isError && /get_state|not in the latest tree|element/.test(r.text), r, r.text.split("\n")[0].slice(0, 120));
  r = await call("get_state", { app: "com.apple.Terminal" });
  check("Terminal is refused", r.isError, r, r.text.split("\n")[0].slice(0, 120));
}

if (runTabs) {
  console.log("\n# Browser tabs");
  let r = await call("open_tab", { url: "https://example.com" });
  const tab = /Opened tab (\d+)/.exec(r.text)?.[1];
  check("open_tab example.com", !r.isError && tab && /Example Domain/.test(r.text), r, tab ? `tab ${tab}` : "");
  if (tab) {
    const num = (re, text) => Number(re.exec(text)?.[1]);
    r = await call("list_tabs");
    check("list_tabs lists the agent tab", r.text.includes(tab), r);
    let user;
    try { user = JSON.parse(r.text).find((t) => !t.agent)?.tab; } catch {}
    if (user && user !== tab) {
      const u = await call("read_tab", { tab: user });
      check("a user tab is refused", u.isError && /agent tab/.test(u.text), u, u.text.split("\n")[0].slice(0, 120));
    } else note("user tab refusal", "no user tab ID found in list_tabs");
    r = await call("read_tab", { tab });
    check("read_tab text", /documentation examples/.test(r.text), r);
    r = await call("read_tab", { tab, format: "dom", selector: "p" });
    check("read_tab dom with selector", /^<p[\s>][^]*documentation examples/.test(r.text.trim()) && !/<body/.test(r.text), r, r.text.slice(0, 60));
    r = await call("eval_tab", { tab, expression: "document.title" });
    check("eval_tab document.title", /Example Domain/.test(r.text), r, r.text.slice(0, 80));
    r = await call("eval_tab", { tab, expression: "document.body.remove()" });
    check("eval_tab with a side effect is refused", r.isError, r, r.text.split("\n")[0].slice(0, 120));
    r = await call("tab_locator", { tab, action: "text", css: "p", nth: 0 });
    check("tab_locator text", /documentation examples/.test(r.text), r, r.text.slice(0, 60));
    r = await call("tab_locator", { tab, action: "count", css: "p" });
    check("tab_locator count", !r.isError && /\d/.test(r.text), r, r.text.slice(0, 80));
    r = await call("screenshot", { tab });
    check("screenshot tab", r.images.length === 1, r, r.text.split("\n")[0]);
    r = await call("get_state", { tab });
    const link = num(/^\s*(\d+) link/m, r.text);
    check("get_state tab finds the link", !r.isError && link >= 0, r);
    r = await call("click", { tab, element: link });
    await sleep(1500);
    r = await call("eval_tab", { tab, expression: "location.hostname" });
    check("click the link navigates", /iana\.org/.test(r.text), r, r.text.slice(0, 80));
    r = await call("navigate_tab", { tab, action: "back" });
    check("navigate_tab back", !r.isError && /Example Domain/.test(r.text), r);
    r = await call("navigate_tab", { tab, action: "reload" });
    check("navigate_tab reload", !r.isError, r);

    r = await call("navigate_tab", { tab, action: "goto", url: "https://httpbin.org/forms/post" });
    if (r.isError || !/Customer name/i.test(r.text)) note("form checks", `httpbin.org did not load: ${r.text.split("\n")[0].slice(0, 120)}`);
    else {
      const val = async (css) => (await call("eval_tab", { tab, expression: `document.querySelector(${JSON.stringify(css)}).value` })).text.trim();
      r = await call("tab_locator", { tab, action: "fill", label: "Customer name:", value: "cub live test" });
      check("tab_locator fill by label", !r.isError && (await val("input[name=custname]")).includes("cub live test"), r);
      r = await call("tab_locator", { tab, action: "check", css: "input[value=bacon]" });
      const checked = (await call("eval_tab", { tab, expression: "document.querySelector('input[value=bacon]').checked" })).text;
      check("tab_locator check", !r.isError && /true/.test(checked), r);
      r = await call("tab_locator", { tab, action: "click", css: "input[name=custtel]" });
      r = await call("type_text", { tab, text: "5551" });
      check("type_text in a tab", !r.isError && (await val("input[name=custtel]")).includes("5551"), r);
      r = await call("press_key", { tab, key: "BackSpace" });
      check("press_key BackSpace in a tab", !r.isError && /"555"/.test(await val("input[name=custtel]")), r);
      r = await call("get_state", { tab });
      const email = num(/^\s*(\d+) textbox E-mail address/m, r.text);
      const label = num(/^\s*(\d+) text E-mail address/m, r.text);
      const bad = await call("set_value", { tab, element: label, value: "x" });
      check("set_value on label text is refused plainly", bad.isError && /does not take a value/.test(bad.text), bad, bad.text.split("\n")[0].slice(0, 100));
      r = await call("set_value", { tab, element: email, value: "cub@example.com" });
      check("set_value in a tab", !r.isError && (await val("input[name=custemail]")).includes("cub@example.com"), r);
      r = await call("press_key", { tab, key: "shift", hold: "down" });
      const up = await call("press_key", { tab, key: "shift", hold: "up" });
      check("press_key hold down and up", !r.isError && !up.isError, r);
      r = await call("scroll", { tab, direction: "down", pages: 1 });
      check("scroll a tab", !r.isError, r);
      r = await call("batch", { tab, actions: [{ action: "scroll", direction: "up", pages: 1 }, { action: "wait", ms: 200 }, { action: "press_key", key: "End" }] });
      check("batch in a tab", !r.isError, r);
    }
    r = await call("close_tab", { tab });
    check("close_tab", !r.isError, r);
    r = await call("list_tabs");
    check("closed tab is gone from list_tabs", !r.text.includes(tab), r);
  }
}

const r = await call("release");
check("release", !r.isError, r);
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);

#!/usr/bin/env node
// Live test of the native tools through the bridge on a real machine: apps on Calculator (macOS),
// browser tabs on example.com, and the allowlist. Run it before bumping an engine pin.
//
//   node dev/live-test.mjs [--apps] [--tabs] [--out DIR] -- COMMAND [ARGS...]     (stdio)
//   node dev/live-test.mjs [--apps] [--tabs] [--out DIR] --url URL --token-file FILE  (HTTP)
//
// e.g. -- ssh -T HOST node .../bin/computer-use-bridge.mjs stdio --config /tmp/cubtest/config.json
// The config must allow com.apple.calculator for --apps and serve tabs for --tabs (both by
// default). Calculator is left open; agent tabs are finalized (closed).
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
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "live-test", version: "0" } });
await rpc("notifications/initialized", {}, true);
const tools = (await rpc("tools/list", {})).result.tools.map((t) => t.name);
console.log(`${init.result.serverInfo.name} ${init.result.serverInfo.version}: ${tools.length} tools; images in ${out}`);
const OCU = ["list_apps", "get_app_state", "click", "type_text", "press_key", "scroll", "set_value", "drag", "perform_secondary_action"];
const OBU = ["ping", "info", "tabs", "user_tabs", "open_tab", "claim_tab", "navigate", "wait_load", "page_info", "cdp", "finalize_tabs", "name_session", "turn_ended", "call", "run_action_plan"];
const first = (r) => r.text.split("\n")[0].slice(0, 160);

if (runApps) {
  // open-computer-use element lines look like "17 button 2 ID: Two".
  const app = "com.apple.calculator";
  let tree = "";
  const keep = (r) => {
    if (!r.isError && /^\s*\d+ /m.test(r.text)) tree = r.text;
    return r;
  };
  const button = (name) => {
    const m = new RegExp(`^\\s*(\\d+) button (?:\\([^)]*\\) )?${esc(name)}(?:,| ID:| Help:|$)`, "m").exec(tree);
    return m ? String(m[1]) : undefined;
  };
  const clear = () => button("All Clear") ?? button("Clear");
  const display = (text = tree) => (/Edit field[^\n]*\n\s*(?:\d+ )?(?:static)?text (.*)/.exec(text)?.[1] ?? "?").replace(/[\u200e\u200f\u202a-\u202e]/g, "").trim();

  console.log("\n# Apps (open-computer-use on Calculator)");
  const missing = OCU.filter((t) => !tools.includes(t));
  check("open-computer-use's own tools are offered", !missing.length, null, missing.length ? `missing ${missing.join(", ")}` : "");
  let r = await call("list_apps");
  check("list_apps shows only allowed apps", !r.isError && !/com\.mitchellh\.ghostty|com\.apple\.finder/i.test(r.text), r, first(r));
  r = keep(await call("get_app_state", { app: "Calculator" }));
  check("get_app_state by app name, with its screenshot", button("2") !== undefined && r.images.length === 1, r, `display ${display()}`);
  for (const b of ["clear", "2", "Add", "2", "Equals"]) keep(await call("click", { app, element_index: b === "clear" ? clear() : button(b) }));
  check("click 2 + 2 =", display() === "4", null, `display ${display()}`);
  keep(await call("click", { app, element_index: clear() }));
  r = keep(await call("press_key", { app, key: "9" }));
  check("press_key 9", !r.isError && display(r.text) === "9", r, `display ${display(r.text)}`);
  r = keep(await call("press_key", { app, key: "Escape" }));
  check("press_key Escape clears", !r.isError && display(r.text) === "0", r, `display ${display(r.text)}`);
  r = await call("type_text", { app, text: "7" });
  note("type_text outside a text field", r.isError ? `engine says: ${first(r)}` : "accepted");
  r = await call("get_app_state", { app: "com.apple.Terminal" });
  check("Terminal is refused", r.isError && /not allowed/.test(r.text), r, first(r));
  r = await call("get_app_state", { app: "Finder" });
  check("an app outside the allowlist is refused", r.isError && /not allowed/.test(r.text), r, first(r));
}

if (runTabs) {
  console.log("\n# Browser tabs (open-browser-use)");
  const missing = OBU.filter((t) => !tools.includes(t));
  check("open-browser-use's own tools are offered", !missing.length, null, missing.length ? `missing ${missing.join(", ")}` : "");
  let r = await call("ping");
  check("ping reaches the extension", !r.isError && /pong/.test(r.text), r, first(r));
  r = await call("name_session", { name: "cub live test" });
  check("name_session", !r.isError, r);
  r = await call("open_tab", { url: "https://example.com" });
  check("open_tab example.com", !r.isError, r, first(r));
  r = await call("wait_load", {});
  check("wait_load", !r.isError, r, first(r));
  r = await call("page_info", {});
  check("page_info reads the page", /Example Domain/.test(r.text), r, first(r));
  r = await call("cdp", { method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } });
  check("cdp Runtime.evaluate", /Example Domain/.test(r.text), r, first(r));
  r = await call("cdp", { method: "Page.captureScreenshot", params: { format: "png" } });
  check("cdp Page.captureScreenshot", !r.isError && r.text.length > 1000, r, `${r.text.length} chars`);
  r = await call("tabs");
  check("tabs lists the session's tab", !r.isError && /example\.com/.test(r.text), r);
  r = await call("finalize_tabs", { keep: [] });
  check("finalize_tabs closes it", !r.isError, r, first(r));
  r = await call("turn_ended");
  check("turn_ended", !r.isError, r, first(r));
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);

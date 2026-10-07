#!/usr/bin/env node
// Engine-free tests of the bridge's result handling: tree capping and the detached-debugger
// retry rules. Loads computer-use-bridge.mjs without its CLI entry point and mocks the engine.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../computer-use-bridge.mjs"), "utf8");
const cli = src.lastIndexOf("\ntry {\n  const opts = parseArgs");
if (cli < 0) throw new Error("CLI entry point not found");
const dir = mkdtempSync(join(tmpdir(), "cub-test-"));
const file = join(dir, "bridge.mjs");
writeFileSync(file, src.slice(0, cli) + "\nexport { Session };\n");
const { Session } = await import(pathToFileURL(file));
rmSync(dir, { recursive: true, force: true });

const assert = (c, m) => { if (!c) { console.log("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };
const kinded = (text, kind) => Object.defineProperty({ type: "text", text }, "kind", { value: kind });
const mk = () => { const s = new Session({ surface: "fixed", engineIdleMinutes: 0, approve: "all", allowApps: [], isAllowed: () => true }, "t"); s.stopEngine = async () => { s.stops = (s.stops ?? 0) + 1; return true; }; return s; };
// 1. cap only trees, surrogate-safe
{
  const s = mk();
  const big = "x".repeat(19999) + "😀" + "y".repeat(5000);
  s.js = async () => Object.defineProperty({ content: [kinded(big, "state"), kinded("[" + "z".repeat(30000) + "]", "out"), kinded("E".repeat(30000), "error")], isError: false }, "ran", { value: false });
  const r = await s.callFixedOnce("get_state", { tab: "123" });
  const tree = r.content[0].text;
  assert(tree.includes("[Tree truncated: showing 19999 of"), "state block cut before the surrogate pair");
  assert(!/[\uD800-\uDBFF]\n/.test(tree), "no lone high surrogate");
  assert(tree.includes("full: true"), "notice mentions full: true");
  assert(r.content[1].text.length === 30002 && r.content[2].text.length === 30000, "out and error blocks untouched for get_state");
  const lt = await s.callFixedOnce("list_tabs", {});
  assert(lt.content[1].text.length === 30002, "list_tabs JSON untouched");
  const ot = await s.callFixedOnce("open_tab", { url: "https://example.com/" });
  assert(ot.content[1].text.includes("[Tree truncated"), "open_tab's own tree write is capped");
  assert(JSON.stringify(ot).indexOf("kind") < 0, "kind does not leak into JSON");
}
// 2. callFixed paths
const DET = { content: [{ type: "text", text: "Error: Debugger unattached" }], isError: true };
const res = (r, ran = false) => Object.defineProperty(structuredClone(r), "ran", { value: ran });
const OK = { content: [{ type: "text", text: "TREE" }], isError: false };
async function scenario(name, a, seq) {
  const s = mk(); const calls = [];
  s.callFixedOnce = async (n, args) => { calls.push([n, args.rebind === true]); const x = seq.shift(); return res(x[0], x[1]); };
  const r = await s.callFixed(name, a);
  return { r, calls, stops: s.stops ?? 0, head: r.content[0].text };
}
let x;
x = await scenario("tab_locator", { tab: "1", css: "a", action: "click" }, [[DET], [OK]]);
assert(x.calls.map((c) => c.join(":")).join(",") === "tab_locator:false,tab_locator:true" && /re-attached it and retried/.test(x.head), "no elements: rebind + replay");
x = await scenario("tab_locator", { tab: "1", css: "a", action: "click" }, [[DET], [DET], [OK]]);
assert(x.stops === 1 && x.calls.length === 3 && x.calls[2][0] === "tab_locator" && /restarted the engine/.test(x.head), "no elements: restart + replay");
x = await scenario("click", { tab: "1", element: 4 }, [[DET], [OK]]);
assert(x.calls[1][0] === "get_state" && x.calls[1][1] && x.r.isError && /did NOT run/.test(x.head), "element click: not replayed, fresh tree");
x = await scenario("click", { tab: "1", element: 4 }, [[DET], [DET], [OK]]);
assert(x.stops === 1 && x.calls[2][0] === "get_state" && /restarted the engine.*did NOT run/.test(x.head), "element click: restart, still not replayed");
x = await scenario("batch", { tab: "1", actions: [{ action: "press_key", key: "a" }, { action: "click", element: 3 }] }, [[DET], [OK]]);
assert(x.calls[1][0] === "get_state", "batch with an element step: not replayed");
x = await scenario("tab_locator", { tab: "1", css: "a", action: "click" }, [[DET, true]]);
assert(x.calls.length === 1 && /Do not repeat/.test(x.head), "ran on first attempt: no retry");
x = await scenario("batch", { tab: "1", actions: [{ action: "press_key", key: "a" }] }, [[DET], [DET, true]]);
assert(x.calls.length === 2 && x.stops === 0 && /Do not repeat/.test(x.head), "ran during the rebind retry: no restart replay");
x = await scenario("tab_locator", { tab: "1", css: "a", action: "click" }, [[DET], [DET], [DET]]);
assert(/even a new engine/.test(x.head), "stuck after restart");
x = await scenario("click", { app: "Discord", element: 4 }, [[DET]]);
assert(x.calls.length === 1, "app targets are not retried");

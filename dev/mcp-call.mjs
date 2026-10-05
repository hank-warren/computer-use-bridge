#!/usr/bin/env node
// Minimal MCP stdio client for exercising the bridge by hand.
//
//   node dev/mcp-call.mjs [--out DIR] [--list] [--max CHARS] [--var NAME=REGEX]... CALLS_JSON -- COMMAND [ARGS...]
//
// CALLS_JSON is an array of {"name", "arguments"} run in order in one session,
// e.g. '[{"name":"get_state","arguments":{"app":"com.brave.Browser"}}]'.
// Text results are printed; images are written to DIR (default: a temp dir).
// --var captures REGEX's first group from any result; later calls substitute {{NAME}},
// or a number for "{{#NAME}}".

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 0) throw new Error("usage: mcp-call.mjs [--out DIR] [--list] CALLS_JSON -- COMMAND [ARGS...]");
const opts = argv.slice(0, sep);
const [cmd, ...cmdArgs] = argv.slice(sep + 1);
let out = null;
let list = false;
let max = Infinity;
const vars = new Map();
const values = {};
let calls = [];
for (let i = 0; i < opts.length; i++) {
  if (opts[i] === "--out") out = opts[++i];
  else if (opts[i] === "--list") list = true;
  else if (opts[i] === "--max") max = Number(opts[++i]);
  else if (opts[i] === "--var") {
    const [name, ...re] = opts[++i].split("=");
    vars.set(name, new RegExp(re.join("=")));
  }
  else calls = JSON.parse(opts[i]);
}
out ??= mkdtempSync(join(tmpdir(), "mcp-call-"));

const child = spawn(cmd, cmdArgs, { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let nextId = 1;
createInterface({ input: child.stdout }).on("line", (line) => {
  const msg = JSON.parse(line);
  pending.get(msg.id)?.(msg);
  pending.delete(msg.id);
});
const rpc = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-call", version: "0" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
if (list) {
  console.log(init.result?.instructions ?? "");
  for (const t of (await rpc("tools/list", {})).result.tools) console.log(`- ${t.name}: ${t.description}\n  ${JSON.stringify(t.inputSchema.properties)}`);
}
let n = 0;
for (const raw of calls) {
  // "{{#name}}" (quoted) becomes a number; {{name}} is substituted as text.
  const call = JSON.parse(JSON.stringify(raw)
    .replace(/"\{\{#(\w+)\}\}"/g, (m, n) => (n in values ? String(Number(values[n])) : m))
    .replace(/\{\{(\w+)\}\}/g, (m, n) => values[n] ?? m));
  const started = Date.now();
  const res = await rpc("tools/call", call);
  const r = res.result ?? { isError: true, content: [{ type: "text", text: JSON.stringify(res.error) }] };
  console.log(`=== ${call.name} ${JSON.stringify(call.arguments ?? {}).slice(0, 160)} (${Date.now() - started} ms)${r.isError ? " ERROR" : ""}`);
  for (const c of r.content ?? []) {
    if (c.type === "text") {
      for (const [name, re] of vars) {
        const m = re.exec(c.text);
        if (m) values[name] = m[1];
      }
      const docs = /^(## Computer Use|# Other Browser APIs)/.test(c.text);
      console.log(docs ? "[cua_repl docs omitted]" : c.text.length > max ? `${c.text.slice(0, max)}… [${c.text.length} chars]` : c.text);
    }
    else if (c.type === "image") {
      const file = join(out, `img-${++n}.${c.mimeType.split("/")[1]}`);
      writeFileSync(file, Buffer.from(c.data, "base64"));
      console.log(`[image ${c.mimeType} ${Math.round(c.data.length / 1024)} KiB base64 -> ${file}]`);
    }
  }
}
child.stdin.end();

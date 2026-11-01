import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { NAME, VERSION, expand, log } from "../common.mjs";

// ---------- open-computer-use engine ----------

// The open-computer-use command: the config's ocuCommand, else the first one on PATH, next to
// this node, or in the usual npm global bin directories (a launchd service has a short PATH).
export function findOcu(cfg) {
  if (cfg.ocuCommand) return expand(cfg.ocuCommand);
  const dirs = [...(process.env.PATH ?? "").split(":"), dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".npm-global/bin")];
  return dirs.filter(Boolean).map((d) => join(d, "open-computer-use")).find((f) => existsSync(f)) ?? "open-computer-use";
}

// open-computer-use numbers elements by its latest snapshot, and every call takes a new one, so
// numbers from the tree a client saw drift once a later call (a batch step, a screenshot) changes
// the window. These find the same element in the latest tree: same depth and the same line, less
// what changes with state (traits, value, frame, secondary actions).
export function ocuElements(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const m = /^(\t*)(\d+) (.*)$/.exec(line);
    if (m) out.push({ n: Number(m[2]), depth: m[1].length, line: m[3], key: ocuKey(m[3]) });
  }
  return out;
}
export function ocuKey(line) {
  return line
    .replace(/,? Secondary Actions: .*$/, "")
    .replace(/ Frame: .*$/, "")
    .replace(/,? Value: .*?(?= Placeholder: |$)/, "")
    .replace(/^([a-z][a-z ]*?) \([a-z]+(?:, [a-z]+)*\)/, "$1")
    .trim();
}
const short = (line) => (line.length > 80 ? `${line.slice(0, 80)}…` : line);
// Maps element n of tree `from` to `to`: { index } or { error }.
export function ocuRemap(from, to, n) {
  const was = ocuElements(from);
  const e = was.find((x) => x.n === n);
  if (!e) return { error: `element ${n} is not in the latest tree` };
  if (from === to) return { index: n };
  const now = ocuElements(to);
  // Only when as many such elements remain: with two identical buttons and one left, which one
  // survived is unknowable.
  const pick = (same) => {
    const before = was.filter(same);
    const after = now.filter(same);
    if (!after.length) return undefined;
    return after.length === before.length ? after[before.indexOf(e)].n : null;
  };
  const found = pick((x) => x.depth === e.depth && x.key === e.key) ?? pick((x) => x.key === e.key);
  if (found === null) return { error: `element ${n} (${short(e.line)}) is one of several alike whose number changed` };
  if (found === undefined) return { error: `element ${n} (${short(e.line)}) changed or is gone` };
  return { index: found };
}
// Text as open-computer-use press_key names, when every character has one (it names no other
// punctuation); the keypad covers arithmetic. Null otherwise.
const OCU_CHAR_KEYS = { " ": "space", "\n": "return", "\t": "tab", "+": "kp_add", "-": "kp_subtract", "*": "kp_multiply", "/": "kp_divide", "=": "kp_equal", ".": "kp_decimal" };
export function ocuTypeKeys(text) {
  const s = String(text ?? "");
  if (!s || s.length > 200) return null;
  const keys = [...s].map((ch) => OCU_CHAR_KEYS[ch] ?? (/^[a-z0-9]$/.test(ch) ? ch : /^[A-Z]$/.test(ch) ? `shift+${ch.toLowerCase()}` : null));
  return keys.includes(null) ? null : keys;
}

// The tree in an open-computer-use result: the first text with numbered element lines.
export const ocuTree = (r) => (r?.content ?? []).find((c) => c.type === "text" && /^\t*\d+ /m.test(c.text))?.text ?? null;

// open-computer-use (github.com/iFurySt/open-codex-computer-use) serves Codex's nine
// native computer-use tools over MCP stdio, with no OpenAI service or login.
export class OcuChild {
  constructor(cfg, label) {
    this.cfg = cfg;
    this.label = label;
    this.pending = new Map();
    this.nextId = 1;
    this.queue = Promise.resolve();
    this.dead = false;
    this.shown = new Map(); // app -> the tree the client last saw
    this.latest = new Map(); // app -> the engine's latest tree, which its element numbers refer to
  }

  async start() {
    const cmd = findOcu(this.cfg);
    // Its npm launcher runs on whatever `node` is on PATH; this process's node will do.
    const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}` };
    env.OPEN_COMPUTER_USE_VISUAL_CURSOR = this.cfg.ocuVisualCursor === true ? "1" : "0";
    this.proc = spawn(cmd, ["mcp"], { env, stdio: ["pipe", "pipe", "inherit"] });
    const died = (why) => {
      this.dead = true;
      for (const { reject } of this.pending.values()) reject(new Error(why));
      this.pending.clear();
    };
    this.proc.on("error", (e) => died(e.code === "ENOENT"
      ? `open-computer-use not found; install it with "npm i -g open-computer-use" or set ocuCommand in the config`
      : `open-computer-use failed to start: ${e.message}`));
    this.proc.on("exit", (code, sig) => died(`open-computer-use exited (${code ?? sig})`));
    this.proc.stdin.on("error", () => {});
    createInterface({ input: this.proc.stdout }).on("line", (line) => this.onLine(line));
    const init = await this.request("initialize", {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: NAME, version: VERSION },
    }, 60_000);
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    log(`[${this.label}] open-computer-use ${init?.serverInfo?.version ?? ""} started`);
  }

  send(msg) {
    if (!this.dead) this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method && msg.id !== undefined) {
      if (msg.method === "ping") return this.send({ jsonrpc: "2.0", id: msg.id, result: {} });
      return this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unsupported: ${msg.method}` } });
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message ?? "open-computer-use error"));
    else p.resolve(msg.result);
  }

  request(method, params, timeoutMs = 60_000) {
    if (this.dead) return Promise.reject(new Error("open-computer-use is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`open-computer-use ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  // One call at a time. Element numbers are the client's, from the tree it last saw (batch steps
  // before the last pass opts.quiet, as their trees go unseen); they are mapped to the engine's
  // latest snapshot first. A screenshot (max_tree_nodes 1) takes a whole tree, unseen, so the
  // engine's numbering stays complete.
  call(name, args, timeoutMs, opts = {}) {
    const run = () => this.callOne(name, args, timeoutMs, opts);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async callOne(name, args, timeoutMs, opts) {
    let a = args;
    let quiet = opts.quiet === true;
    if (name === "get_app_state" && a.max_tree_nodes === 1) {
      const { max_tree_nodes: _, ...rest } = a;
      a = rest;
      quiet = true;
    }
    const shown = this.shown.get(a.app);
    const latest = this.latest.get(a.app);
    if (a.element_index !== undefined && shown && latest) {
      if (!ocuElements(shown).some((x) => x.n === Number(a.element_index))) {
        return { content: [{ type: "text", text: `element ${a.element_index} is not in your latest tree of ${a.app}; call get_state` }], isError: true };
      }
      const m = ocuRemap(shown, latest, Number(a.element_index));
      if (m.error) {
        this.shown.set(a.app, latest);
        return { content: [{ type: "text", text: `${m.error} since your last tree, so nothing was done. The window now:` }, { type: "text", text: latest }], isError: true };
      }
      a = { ...a, element_index: String(m.index) };
    }
    let r = await this.request("tools/call", { name, arguments: a }, timeoutMs);
    // open-computer-use 1.x types only into a focused text field. Outside one (calculators, games)
    // the text is pressed key by key, as press_key would; its sky_key typing drops all but the first.
    if (name === "type_text" && r?.isError && /requires a focused editable text element/.test(JSON.stringify(r.content))) {
      const keys = ocuTypeKeys(a.text);
      if (!keys) return { ...r, content: [...(r.content ?? []), { type: "text", text: "Outside a text field only letters, digits, space, Return, Tab and + - * / = . can be typed; use press_key for other keys." }] };
      for (const key of keys) {
        r = await this.request("tools/call", { name: "press_key", arguments: { app: a.app, key } }, timeoutMs);
        if (r?.isError) break;
      }
      if (!r?.isError) r.content = [{ type: "text", text: "No text field had focus, so the text was pressed key by key." }, ...(r.content ?? [])];
    }
    const tree = ocuTree(r);
    if (tree) {
      this.latest.set(a.app, tree);
      if (!quiet) this.shown.set(a.app, tree);
    }
    return r;
  }

  async close() {
    if (this.dead) return;
    this.dead = true;
    this.proc.kill("SIGTERM");
  }
}

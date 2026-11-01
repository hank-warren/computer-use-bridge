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

  // One call at a time: element numbers refer to the engine's latest snapshot.
  call(name, args, timeoutMs) {
    const run = () => this.request("tools/call", { name, arguments: args }, timeoutMs);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async close() {
    if (this.dead) return;
    this.dead = true;
    this.proc.kill("SIGTERM");
  }
}

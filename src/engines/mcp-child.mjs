import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { NAME, VERSION, childEnv, log } from "../common.mjs";

// An engine's own MCP server over stdio (`ocu mcp`, `obu mcp`), started on demand. The bridge
// forwards its tools as they are; this only speaks the protocol and keeps one call in flight.
export class McpChild {
  constructor({ name, command, args = [], env = {}, label = "", missing, startTimeoutMs }) {
    Object.assign(this, { name, command, args, env, label, missing, startTimeoutMs });
    this.pending = new Map();
    this.nextId = 1;
    this.queue = Promise.resolve();
    this.dead = false;
    this.tools = [];
    this.instructions = "";
  }

  async start() {
    this.proc = spawn(this.command, this.args, { env: { ...childEnv(), ...this.env }, stdio: ["pipe", "pipe", "inherit"] });
    const died = (why) => {
      this.dead = true;
      for (const { reject } of this.pending.values()) reject(new Error(why));
      this.pending.clear();
    };
    this.proc.on("error", (e) => died(e.code === "ENOENT" ? (this.missing ?? `${this.name} not found`) : `${this.name} failed to start: ${e.message}`));
    this.proc.on("exit", (code, sig) => died(`${this.name} exited (${code ?? sig})`));
    this.proc.stdin.on("error", () => {});
    createInterface({ input: this.proc.stdout }).on("line", (line) => this.onLine(line));
    try {
      const init = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: NAME, version: VERSION } }, this.startTimeoutMs ?? 60_000);
      this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      this.version = init?.serverInfo?.version ?? "";
      this.instructions = init?.instructions ?? "";
      this.tools = (await this.request("tools/list", {}, this.startTimeoutMs ?? 60_000))?.tools ?? [];
    } catch (e) {
      // Nobody holds a child that failed to start, so it must not keep running.
      await this.close();
      throw e;
    }
    log(`[${this.label}] ${this.name} ${this.version} started`);
    return this;
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
    if (msg.error) p.reject(new Error(msg.error.message ?? `${this.name} error`));
    else p.resolve(msg.result);
  }

  request(method, params, timeoutMs = 60_000) {
    if (this.dead) return Promise.reject(new Error(`${this.name} is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name} ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  // tools/call, one at a time.
  call(name, args, timeoutMs = 120_000) {
    const run = () => this.request("tools/call", { name, arguments: args }, timeoutMs);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async close() {
    const alive = this.proc && this.proc.exitCode === null && this.proc.signalCode === null;
    this.dead = true;
    if (alive) this.proc.kill("SIGTERM");
  }
}

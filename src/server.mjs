import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { NAME, PROTOCOL_VERSIONS, VERSION, expand, log } from "./common.mjs";
import { Session, textResult } from "./session.mjs";

// ---------- MCP server side ----------

export async function handle(session, msg) {
  const { id, method, params } = msg;
  if (id === undefined || !method) return null; // notifications and stray responses
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  try {
    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[1],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: NAME, version: VERSION },
          instructions: await session.instructions(),
        });
      }
      case "ping": return ok({});
      case "tools/list": return ok({ tools: await session.listTools() });
      case "tools/call": return ok(await session.callTool(params?.name, params?.arguments ?? {}));
      default: return fail(-32601, `method not found: ${method}`);
    }
  } catch (e) {
    log(`[${session.label}] ${method} failed: ${e.message}`);
    return method === "tools/call" ? ok(textResult(e.message, true)) : fail(-32603, e.message);
  }
}

export function runStdio(cfg) {
  const session = new Session(cfg, "stdio");
  const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
    const res = await handle(session, msg);
    if (res) out(res);
  });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    setTimeout(() => process.exit(0), 15_000).unref();
    await session.close();
    setTimeout(() => process.exit(0), 500);
  };
  rl.on("close", shutdown);
  for (const sig of ["SIGHUP", "SIGTERM", "SIGINT"]) process.on(sig, shutdown);
}

// Keeps `ssh -R` open so a machine this Mac can SSH to, but that cannot reach this
// Mac (e.g. a VM behind a one-way VPN like WARP), reaches the server on its own loopback.
export const SSH_TUNNEL_OPTS = [
  "-N", "-T", "-v", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=3", "-o", "ConnectTimeout=20", "-o", "RemoteCommand=none", "-o", "RequestTTY=no",
  // A shared ControlMaster connection would hand the forward to the master and exit.
  "-o", "ControlMaster=no", "-o", "ControlPath=none",
];

export class Tunnel {
  constructor(t, cfg) {
    Object.assign(this, t);
    this.forward = `127.0.0.1:${t.remotePort}:${cfg.host}:${cfg.port}`;
    this.label = `tunnel ${t.ssh}:${t.remotePort}`;
    this.up = false;
    this.error = "starting";
    this.delay = 2000;
    this.stopped = false;
  }

  start() {
    if (this.stopped) return;
    const started = Date.now();
    let buf = "";
    let lastDebug = "";
    this.proc = spawn("/usr/bin/ssh", [...SSH_TUNNEL_OPTS, "-R", this.forward, this.ssh], { stdio: ["ignore", "ignore", "pipe"] });
    createInterface({ input: this.proc.stderr }).on("line", (line) => {
      if (/remote forward success/.test(line) && !this.up) {
        this.up = true;
        this.error = null;
        log(`[${this.label}] up`);
      } else if (!line.trim() || /^(Transferred:|Bytes per second:)/.test(line)) return;
      else if (line.startsWith("debug")) lastDebug = line.trim();
      else buf = line.trim();
    });
    this.proc.on("error", (e) => { buf = e.message; });
    this.proc.on("close", (code, sig) => {
      const was = this.up;
      this.up = false;
      this.proc = null;
      if (this.stopped) return;
      if (Date.now() - started > 60_000) this.delay = 2000;
      this.error = buf || `ssh exited (${code ?? sig}) after: ${lastDebug || "no output"}`;
      log(`[${this.label}] ${was ? "down" : "failed"}: ${this.error}; retrying in ${this.delay / 1000}s`);
      this.retry = setTimeout(() => this.start(), this.delay);
      this.delay = Math.min(this.delay * 2, 60_000);
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.proc?.kill("SIGTERM");
  }

  state() {
    return { ssh: this.ssh, remotePort: this.remotePort, up: this.up, error: this.error };
  }
}

export function runHttp(cfg) {
  const token = Buffer.from(readFileSync(expand(cfg.tokenFile), "utf8").trim());
  if (token.length < 32) throw new Error("token must be at least 32 characters");
  const sessions = new Map();

  const authorized = (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    const given = Buffer.from(m?.[1] ?? "");
    return given.length === token.length && timingSafeEqual(given, token);
  };
  const reply = (res, status, body, headers = {}) => {
    res.writeHead(status, { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const rpcError = (code, message) => ({ jsonrpc: "2.0", id: null, error: { code, message } });
  const closeSession = (sid, why) => {
    const s = sessions.get(sid);
    if (!s) return;
    sessions.delete(sid);
    log(`[${sid.slice(0, 8)}] closing (${why})`);
    return s.close();
  };

  setInterval(() => {
    const cutoff = Date.now() - cfg.idleMinutes * 60_000;
    for (const [sid, s] of sessions) if (s.lastUsed < cutoff) closeSession(sid, "idle");
  }, 60_000).unref();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/healthz" && req.method === "GET") {
      // Tunnel details only with the token: tunneled requests look local, so the address proves nothing.
      return reply(res, 200, { ok: true, version: VERSION, ...(authorized(req) && tunnels.length ? { tunnels: tunnels.map((t) => t.state()) } : {}) });
    }
    if (url.pathname !== "/mcp") return reply(res, 404, rpcError(-32000, "not found"));
    if (req.headers.origin) return reply(res, 403, rpcError(-32000, "browser origins are not allowed"));
    if (!authorized(req)) {
      log(`rejected unauthenticated ${req.method} from ${req.socket.remoteAddress}`);
      return reply(res, 401, rpcError(-32001, "unauthorized"));
    }
    const sid = req.headers["mcp-session-id"];
    if (req.method === "DELETE") {
      closeSession(sid, "client");
      return reply(res, 200);
    }
    if (req.method !== "POST") return reply(res, 405, rpcError(-32000, "method not allowed"), { Allow: "POST, DELETE" });

    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1_000_000) return reply(res, 413, rpcError(-32000, "request too large"));
    }
    let msg;
    try { msg = JSON.parse(body); } catch { return reply(res, 400, rpcError(-32700, "parse error")); }
    if (Array.isArray(msg) || typeof msg !== "object" || msg === null) return reply(res, 400, rpcError(-32600, "single JSON-RPC message expected"));

    let session;
    let headers = {};
    if (msg.method === "initialize") {
      while (sessions.size >= cfg.maxSessions) {
        const [oldest] = [...sessions].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        closeSession(oldest, "evicted");
      }
      const newId = randomUUID();
      session = new Session(cfg, newId.slice(0, 8));
      sessions.set(newId, session);
      headers = { "Mcp-Session-Id": newId };
      log(`[${session.label}] opened from ${req.socket.remoteAddress}`);
    } else {
      session = sessions.get(sid);
      if (!session) return reply(res, sid ? 404 : 400, rpcError(-32000, sid ? "unknown session" : "missing Mcp-Session-Id"));
    }
    session.lastUsed = Date.now();
    const out = await handle(session, msg);
    if (!out) return reply(res, 202, undefined, headers);
    return reply(res, 200, out, headers);
  });
  server.on("error", (e) => { log(`listen failed: ${e.message}`); process.exit(1); });
  const tunnels = cfg.tunnels.map((t) => new Tunnel(t, cfg));
  server.listen(cfg.port, cfg.host, () => {
    log(`serving on http://${cfg.host}:${cfg.port}/mcp; apps: ${cfg.appsOn ? `open-computer-use (${cfg.allowApps.join(", ")})` : "off"}; tabs: ${cfg.tabsOn ? `${cfg.tabs.engine} (${cfg.tabs.browser})` : "off"}`);
    for (const t of tunnels) t.start();
  });
  const stop = async () => {
    setTimeout(() => process.exit(0), 15_000).unref();
    for (const t of tunnels) t.stop();
    await Promise.allSettled([...sessions.keys()].map((sid) => closeSession(sid, "shutdown")));
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

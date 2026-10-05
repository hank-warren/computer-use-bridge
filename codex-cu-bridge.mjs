// codex-cu-bridge: expose ChatGPT.app's Codex computer-use engine (cua_repl) to
// other MCP clients, over stdio or bearer-authenticated streamable HTTP.
//
//   codex-cu-bridge stdio [--raw] [--approve-all] [--config FILE]
//   codex-cu-bridge serve [--config FILE]
//
// Surfaces:
//   raw    cua_repl's own tools (js = arbitrary JavaScript as the Mac user).
//          Only for clients that already have shell access to this Mac.
//   fixed  a small set of typed UI tools; no client-supplied code runs, and
//          every call is limited to the allowApps bundle IDs.
//
// Unofficial: relies on ChatGPT.app internals that an update can change.

import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const VERSION = "0.1.0";
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const PLUGIN_DIR = join(homedir(), ".codex/plugins/cache/openai-bundled/unified-computer-use");
const DEFAULT_CONFIG = join(homedir(), ".config/codex-cu-bridge/config.json");

// Never controllable through the fixed surface, even if listed in allowApps:
// shells, script runners, credential stores, system settings and mail/messages.
const HARD_DENY = new Set([
  "com.apple.Terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty",
  "com.github.wez.wezterm", "net.kovidgoyal.kitty", "org.alacritty",
  "dev.warp.Warp-Stable", "dev.warp.Warp", "co.zeit.hyper",
  "com.apple.ScriptEditor2", "com.apple.Automator", "com.apple.shortcuts",
  "com.apple.systempreferences", "com.apple.keychainaccess", "com.apple.Passwords",
  "com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop",
  "com.apple.mail", "com.apple.MobileSMS",
].map((id) => id.toLowerCase()));

const log = (...a) => process.stderr.write(`${new Date().toISOString()} codex-cu-bridge: ${a.join(" ")}\n`);
const expand = (p) => (p?.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

// ---------- configuration ----------

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const opts = { mode, raw: false, approveAll: false, config: DEFAULT_CONFIG };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--raw") opts.raw = true;
    else if (a === "--approve-all") opts.approveAll = true;
    else if (a === "--config") opts.config = rest[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (mode !== "stdio" && mode !== "serve") {
    throw new Error("usage: codex-cu-bridge stdio [--raw] [--approve-all] [--config FILE] | serve [--config FILE]");
  }
  return opts;
}

function loadConfig(opts) {
  const file = expand(opts.config);
  const cfg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  if (opts.mode === "serve") {
    if (!cfg.host || !cfg.port || !cfg.tokenFile) throw new Error(`${file} needs host, port and tokenFile`);
    if (cfg.surface === "raw" || cfg.approve === "all") throw new Error("serve only supports the fixed surface with the allowlist");
    cfg.surface = "fixed";
    cfg.approve = "allowlist";
  } else {
    cfg.surface = opts.raw ? "raw" : "fixed";
    cfg.approve = opts.approveAll ? "all" : "allowlist";
  }
  cfg.allowApps = (cfg.allowApps ?? []).filter((id) => !HARD_DENY.has(id.toLowerCase()));
  const allowed = new Set(cfg.allowApps.map((id) => id.toLowerCase()));
  cfg.isAllowed = (id) => cfg.approve === "all" || (typeof id === "string" && allowed.has(id.toLowerCase()));
  cfg.idleMinutes ??= 30;
  cfg.maxSessions ??= 4;
  return cfg;
}

function loadCuaServer() {
  const key = (n) => n.split(".").map((x) => x.padStart(12, "0")).join(".");
  const versions = readdirSync(PLUGIN_DIR)
    .filter((v) => existsSync(join(PLUGIN_DIR, v, ".mcp.json")))
    .sort((a, b) => (key(a) < key(b) ? -1 : 1));
  if (!versions.length) throw new Error(`no unified-computer-use plugin under ${PLUGIN_DIR}; is ChatGPT.app installed?`);
  const latest = versions.at(-1);
  const server = JSON.parse(readFileSync(join(PLUGIN_DIR, latest, ".mcp.json"), "utf8")).mcpServers.cua_repl;
  return { ...server, version: latest };
}

// ---------- cua_repl child (we are its MCP client) ----------

class CuaChild {
  constructor(cfg, label) {
    this.cfg = cfg;
    this.label = label;
    this.pending = new Map();
    this.nextId = 1;
    this.queue = Promise.resolve();
    this.dead = false;
  }

  async start() {
    const s = loadCuaServer();
    this.proc = spawn(s.command, s.args ?? [], {
      env: { ...process.env, ...(s.env ?? {}) },
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.proc.on("exit", (code, sig) => {
      this.dead = true;
      for (const { reject } of this.pending.values()) reject(new Error(`cua_repl exited (${code ?? sig})`));
      this.pending.clear();
    });
    this.proc.stdin.on("error", () => {});
    createInterface({ input: this.proc.stdout }).on("line", (line) => this.onLine(line));
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: { elicitation: { form: {} } },
      clientInfo: { name: "codex-cu-bridge", version: VERSION },
    }, 120_000);
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    log(`[${this.label}] cua_repl ${s.version} started`);
  }

  send(msg) {
    if (!this.dead) this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  request(method, params, timeoutMs = 90_000) {
    if (this.dead) return Promise.reject(new Error("cua_repl is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cua_repl ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method && msg.id !== undefined) return this.onServerRequest(msg);
    if (msg.method) return; // notifications (progress, logging, list_changed) are dropped
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  }

  onServerRequest(msg) {
    const reply = (result) => this.send({ jsonrpc: "2.0", id: msg.id, result });
    if (msg.method === "ping") return reply({});
    if (msg.method === "roots/list") return reply({ roots: [] });
    if (msg.method === "elicitation/create") {
      const action = this.decide(msg.params ?? {});
      log(`[${this.label}] ${action}: ${msg.params?.message ?? "(no message)"}`);
      return reply({ action, content: {} });
    }
    this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unsupported: ${msg.method}` } });
  }

  // Approval prompts from cua_repl; in allowlist mode only per-app computer-use
  // approvals for allowed bundle IDs pass (no audio, browser-history or CDP).
  decide(params) {
    if (this.cfg.approve === "all") return "accept";
    const meta = params._meta ?? {};
    const app = meta.tool_params?.app;
    const ok = meta.connector_id === "computer-use" && meta.tool_name !== "start_audio_recording" &&
      this.cfg.isAllowed(app);
    return ok ? "accept" : "decline";
  }

  // cua_repl's REPL state is shared, so calls run one at a time.
  call(name, args, timeoutMs) {
    const run = () => this.request("tools/call", { name, arguments: args }, timeoutMs);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  close() {
    if (!this.dead) this.proc.kill("SIGTERM");
  }
}

// ---------- surfaces ----------

const appProp = { type: "string", description: "Bundle ID (e.g. com.brave.Browser) or app name; must be an allowed app." };
const elementProp = { type: "integer", minimum: 0, description: "Element number from the latest accessibility tree." };

const FIXED_TOOLS = [
  { name: "list_apps", description: "List the apps this bridge may control and whether they are running.", props: {} },
  {
    name: "get_state",
    description: "Bind to the app's frontmost window (first call, or rebind=true after the user switches windows) and return its accessibility tree. Later calls return a diff unless full=true.",
    props: { app: appProp, full: { type: "boolean" }, rebind: { type: "boolean" }, screenshot: { type: "boolean" } },
    required: ["app"],
  },
  { name: "screenshot", description: "Screenshot of the app's bound window.", props: { app: appProp }, required: ["app"] },
  {
    name: "click",
    description: "Click an element (preferred) or window coordinates [x, y] from the latest screenshot.",
    props: {
      app: appProp, element: elementProp, x: { type: "number" }, y: { type: "number" },
      button: { type: "string", enum: ["left", "right", "middle"] }, count: { type: "integer", minimum: 1, maximum: 3 },
    },
    required: ["app"],
  },
  { name: "type_text", description: "Type text into the focused element.", props: { app: appProp, text: { type: "string" } }, required: ["app", "text"] },
  {
    name: "press_key",
    description: "Press a key or combination, xdotool syntax: Return, Tab, Escape, Up, super+t (Cmd+T), super+l, shift+Tab.",
    props: { app: appProp, key: { type: "string" } },
    required: ["app", "key"],
  },
  { name: "set_value", description: "Set a settable element's value (e.g. a text field).", props: { app: appProp, element: elementProp, value: { type: "string" } }, required: ["app", "element", "value"] },
  {
    name: "scroll",
    description: "Scroll an element, or window coordinates [x, y], by pages.",
    props: {
      app: appProp, element: elementProp, x: { type: "number" }, y: { type: "number" },
      direction: { type: "string", enum: ["up", "down", "left", "right"] }, pages: { type: "number", exclusiveMinimum: 0, maximum: 20 },
    },
    required: ["app", "direction"],
  },
  {
    name: "drag",
    description: "Drag between window coordinates.",
    props: { app: appProp, from_x: { type: "number" }, from_y: { type: "number" }, to_x: { type: "number" }, to_y: { type: "number" } },
    required: ["app", "from_x", "from_y", "to_x", "to_y"],
  },
  {
    name: "secondary_action",
    description: "Perform an element's listed secondary action (e.g. Raise, Copy, Increment).",
    props: { app: appProp, element: elementProp, action: { type: "string" } },
    required: ["app", "element", "action"],
  },
].map(({ name, description, props, required }) => ({
  name,
  description,
  inputSchema: { type: "object", properties: props, required: required ?? [], additionalProperties: false },
  annotations: (() => {
    const ro = ["list_apps", "get_state", "screenshot"].includes(name);
    return { readOnlyHint: ro, destructiveHint: !ro, openWorldHint: true };
  })(),
}));

class BadInput extends Error {}

const num = (v, name) => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new BadInput(`${name} must be a number`);
  return v;
};
const int = (v, name) => {
  if (!Number.isInteger(v) || v < 0) throw new BadInput(`${name} must be a non-negative integer`);
  return v;
};
const str = (v, name, max = 20_000) => {
  if (typeof v !== "string" || v.length > max) throw new BadInput(`${name} must be a string of at most ${max} characters`);
  return v;
};
const J = JSON.stringify;

function target(a) {
  if (a.element !== undefined) return J(int(a.element, "element"));
  if (a.x !== undefined || a.y !== undefined) return `[${num(a.x, "x")}, ${num(a.y, "y")}]`;
  throw new BadInput("give element, or x and y");
}

function actionJs(name, a) {
  switch (name) {
    case "click": {
      const opts = {};
      if (a.button) opts.mouseButton = a.button;
      if (a.count !== undefined) opts.clickCount = int(a.count, "count");
      return `await app.click(${target(a)}, ${J(opts)});`;
    }
    case "type_text": return `await app.typeText(${J(str(a.text, "text"))});`;
    case "press_key": {
      if (!/^[A-Za-z0-9_+\-]{1,40}$/.test(a.key ?? "")) throw new BadInput("key must look like Return, super+t or KP_0");
      return `await app.pressKey(${J(a.key)});`;
    }
    case "set_value": return `await app.setValue(${J(int(a.element, "element"))}, ${J(str(a.value, "value"))});`;
    case "scroll": {
      if (!["up", "down", "left", "right"].includes(a.direction)) throw new BadInput("direction must be up, down, left or right");
      const pages = a.pages === undefined ? "" : `, ${num(a.pages, "pages")}`;
      return `await app.scroll(${target(a)}, ${J(a.direction)}${pages});`;
    }
    case "drag":
      return `await app.drag([${num(a.from_x, "from_x")}, ${num(a.from_y, "from_y")}], [${num(a.to_x, "to_x")}, ${num(a.to_y, "to_y")}]);`;
    case "secondary_action":
      return `await app.performSecondaryAction(${J(int(a.element, "element"))}, ${J(str(a.action, "action", 100))});`;
    default: throw new BadInput(`unknown tool ${name}`);
  }
}

const textResult = (text, isError = false) => ({ content: [{ type: "text", text }], isError });

class Session {
  constructor(cfg, label) {
    this.cfg = cfg;
    this.label = label;
    this.child = null;
    this.starting = null;
    this.appNames = null;
    this.lastUsed = Date.now();
  }

  async cua() {
    if (this.child && !this.child.dead) return this.child;
    this.starting ??= (async () => {
      const c = new CuaChild(this.cfg, this.label);
      await c.start();
      this.child = c;
      this.appNames = null;
      return c;
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  close() {
    this.child?.close();
  }

  instructions() {
    if (this.cfg.surface === "raw") return "Computer use on this Mac through cua_repl (Codex computer use). The js tool runs JavaScript as the Mac user.";
    return `Computer use on the Mac "${hostname()}" through Codex's engine. Allowed apps: ${this.cfg.allowApps.join(", ") || "(none)"}. ` +
      "Call get_state(app) first; element numbers refer to the latest tree and change after UI updates. Actions return a diff of the tree. " +
      "Input goes to the app's bound window without moving the user's cursor, but the user may be using the same window. " +
      "Ask the user before sending messages, submitting forms, purchasing, or transmitting sensitive data.";
  }

  async listTools() {
    if (this.cfg.surface === "fixed") return FIXED_TOOLS;
    const { tools } = await (await this.cua()).request("tools/list", {});
    return tools.filter((t) => t.name !== "turn_ended").map((t) =>
      t.name === "js" ? { ...t, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } } : t);
  }

  async callTool(name, args = {}) {
    this.lastUsed = Date.now();
    if (this.cfg.surface === "raw") {
      if (name === "turn_ended") return textResult("unknown tool", true);
      const timeout = (Number.isFinite(args.timeout_ms) ? args.timeout_ms : 30_000) + 30_000;
      return (await this.cua()).call(name, args, timeout);
    }
    try {
      return await this.callFixed(name, args);
    } catch (e) {
      if (e instanceof BadInput) return textResult(e.message, true);
      throw e;
    }
  }

  async js(code) {
    // A block keeps generated bindings out of the persistent REPL scope.
    const res = await (await this.cua()).call("js", { code: `{\n${code}\n}`, timeout_ms: 60_000 }, 90_000);
    // Drop cua_repl's first-use JavaScript API docs; fixed-surface clients cannot use them.
    const content = (res.content ?? []).filter((c) => !(c.type === "text" && c.text.startsWith("## Computer Use")));
    return { content: content.length ? content : [{ type: "text", text: "ok" }], isError: !!res.isError };
  }

  async resolveApp(app) {
    str(app, "app", 200);
    const allowed = this.cfg.isAllowed;
    if (allowed(app)) return app;
    if (!this.appNames) {
      const r = await this.js(`nodeRepl.write(JSON.stringify((await cua.listApps({ emit: false })).map((a) => [a.displayName, a.id])));`);
      const text = r.content.find((c) => c.type === "text" && c.text.startsWith("["))?.text ?? "[]";
      this.appNames = new Map(JSON.parse(text).filter(([n]) => n).map(([n, id]) => [n.toLowerCase(), id]));
    }
    const id = this.appNames.get(app.toLowerCase());
    if (id && allowed(id)) return id;
    throw new BadInput(`app not allowed: ${app}${id ? ` (${id})` : ""}. Allowed: ${this.cfg.allowApps.join(", ")}`);
  }

  async callFixed(name, a) {
    if (!FIXED_TOOLS.some((t) => t.name === name)) throw new BadInput(`unknown tool ${name}`);
    if (name === "list_apps") {
      const ids = this.cfg.approve === "all" ? null : this.cfg.allowApps;
      return this.js(`const ids = ${J(ids)}; const apps = await cua.listApps({ emit: false });
nodeRepl.write(JSON.stringify(apps.filter((a) => !ids || ids.includes(a.id)).map(({ id, displayName, isRunning }) => ({ id, displayName, isRunning })), null, 1));`);
    }
    const id = await this.resolveApp(a.app);
    const bind = `globalThis.__cub ??= {};
let app = globalThis.__cub[${J(id)}];
const fresh = !app || ${a.rebind === true};
if (fresh) {
  try { app = await cua.getApp(${J(id)}); }
  catch (e) {
    // Updaters (e.g. Sparkle) leave a second copy with the same bundle ID; prefer the installed one.
    const m = /bundle identifier: (.*)\\. Use an app name/.exec(e.message);
    const pick = (m ? m[1].split(/, (?=\\/)/) : []).find((p) => /^(\\/System)?\\/Applications\\/|^\\/Users\\/[^/]+\\/Applications\\//.test(p));
    if (!pick) throw e;
    app = await cua.getApp(pick);
  }
  globalThis.__cub[${J(id)}] = app;
}`;
    if (name === "get_state") {
      const shot = a.screenshot === true ? `await nodeRepl.emitImage(await app.getScreenshot({ emit: false }));` : "";
      return this.js(`${bind}
if (!fresh) await app.getAXState(${J(a.full === true ? { disableDiffing: true } : {})});
${shot}`);
    }
    if (name === "screenshot") return this.js(`${bind}\nawait app.getScreenshot();`);
    return this.js(`${bind}\n${actionJs(name, a)}\nawait app.getAXState();`);
  }
}

// ---------- MCP server side ----------

async function handle(session, msg) {
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
          serverInfo: { name: "codex-cu-bridge", version: VERSION },
          instructions: session.instructions(),
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

function runStdio(cfg) {
  const session = new Session(cfg, "stdio");
  const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
    const res = await handle(session, msg);
    if (res) out(res);
  });
  rl.on("close", () => { session.close(); setTimeout(() => process.exit(0), 500); });
}

function runHttp(cfg) {
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
    s.close();
    log(`[${sid.slice(0, 8)}] closed (${why})`);
  };

  setInterval(() => {
    const cutoff = Date.now() - cfg.idleMinutes * 60_000;
    for (const [sid, s] of sessions) if (s.lastUsed < cutoff) closeSession(sid, "idle");
  }, 60_000).unref();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/healthz" && req.method === "GET") return reply(res, 200, { ok: true, version: VERSION });
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
  server.listen(cfg.port, cfg.host, () => log(`serving fixed surface on http://${cfg.host}:${cfg.port}/mcp; apps: ${cfg.allowApps.join(", ")}`));
  const stop = () => { for (const sid of [...sessions.keys()]) closeSession(sid, "shutdown"); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

try {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(opts);
  if (opts.mode === "serve") runHttp(cfg);
  else runStdio(cfg);
} catch (e) {
  log(e.message);
  process.exit(2);
}

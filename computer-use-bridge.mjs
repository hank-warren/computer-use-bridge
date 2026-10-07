// computer-use-bridge: expose ChatGPT.app's Codex computer-use engine (cua_repl) to
// other MCP clients, over stdio or bearer-authenticated streamable HTTP.
//
//   computer-use-bridge setup [--host IP|tailscale|localhost] [--tunnel HOST[:PORT],...] [--port N] [--allow IDS] [--yes] [--no-service]
//   computer-use-bridge status [--config FILE]
//   computer-use-bridge stdio [--raw] [--approve-all] [--config FILE]
//   computer-use-bridge serve [--config FILE]
//
// Surfaces:
//   raw    cua_repl's own tools (js = arbitrary JavaScript as the Mac user).
//          Only for clients that already have shell access to this Mac.
//   fixed  typed UI tools for apps and browser tabs; no client-supplied code runs
//          on the Mac (eval_tab runs in the page's read-only sandbox), and every
//          call is limited to the allowApps bundle IDs.
//
// Unofficial: relies on ChatGPT.app internals that an update can change.

import { execFile, spawn } from "node:child_process";
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, hostname, networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { createInterface as createPrompt } from "node:readline/promises";

const VERSION = "0.4.1";
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const PLUGIN_DIR = join(homedir(), ".codex/plugins/cache/openai-bundled/unified-computer-use");
const NAME = "computer-use-bridge";
const CONFIG_DIR = join(homedir(), ".config", NAME);
const DEFAULT_CONFIG = join(CONFIG_DIR, "config.json");
const DEFAULT_PORT = 47800;

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

const log = (...a) => process.stderr.write(`${new Date().toISOString()} ${NAME}: ${a.join(" ")}\n`);
const expand = (p) => (p?.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

// ---------- configuration ----------

const USAGE = `usage: ${NAME} <command>

  setup    configure the HTTP server for this Mac and start it (interactive)
           [--host IP|tailscale|localhost] [--tunnel HOST[:PORT],...] [--port N] [--allow ID,ID]
           [--yes] [--no-service]
  status   check the engine, the config and the running server
  update   upgrade through Homebrew and restart the service
  serve    run the HTTP server (what the Homebrew service runs)
  stdio    speak MCP on stdin/stdout, e.g. over SSH [--raw] [--approve-all]
  version  print the version

All commands take --config FILE (default ${DEFAULT_CONFIG}).`;

function parseArgs(argv) {
  let [mode, ...rest] = argv;
  if (mode === "--version" || mode === "-v") mode = "version";
  if (mode === "--help" || mode === "-h" || mode === undefined) mode = "help";
  const opts = { mode, raw: false, approveAll: false, config: DEFAULT_CONFIG, yes: false, service: true };
  const value = (i) => {
    if (rest[i + 1] === undefined) throw new Error(`${rest[i]} needs a value`);
    return rest[i + 1];
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--raw" && mode === "stdio") opts.raw = true;
    else if (a === "--approve-all" && mode === "stdio") opts.approveAll = true;
    else if (a === "--config") opts.config = value(i++);
    else if (mode === "setup" && a === "--host") opts.host = value(i++);
    else if (mode === "setup" && a === "--tunnel") opts.tunnel = value(i++);
    else if (mode === "setup" && a === "--port") opts.port = value(i++);
    else if (mode === "setup" && a === "--allow") opts.allow = value(i++);
    else if (mode === "setup" && (a === "--yes" || a === "-y")) opts.yes = true;
    else if (mode === "setup" && a === "--no-service") opts.service = false;
    else throw new Error(`unknown argument: ${a}\n\n${USAGE}`);
  }
  if (!["stdio", "serve", "setup", "status", "update", "version", "help"].includes(mode)) throw new Error(`unknown command: ${mode}\n\n${USAGE}`);
  return opts;
}

// A reverse tunnel: ssh is a host alias or user@host, as typed after `ssh`.
function checkTunnel(t) {
  if (typeof t?.ssh !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,252}$/.test(t.ssh)) throw new Error(`tunnel ssh must be a host or user@host (got ${JSON.stringify(t?.ssh)})`);
  if (!Number.isInteger(t.remotePort) || t.remotePort < 1024 || t.remotePort > 65535) throw new Error(`tunnel ${t.ssh}: remotePort must be 1024-65535`);
  return { ssh: t.ssh, remotePort: t.remotePort };
}

function loadConfig(opts) {
  const file = expand(opts.config);
  const cfg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  if (opts.mode === "serve") {
    if (!cfg.host || !cfg.port || !cfg.tokenFile) throw new Error(`${file} needs host, port and tokenFile; run "${NAME} setup"`);
    if (cfg.surface === "raw" || cfg.approve === "all") throw new Error("serve only supports the fixed surface with the allowlist");
    cfg.tunnels = (cfg.tunnels ?? []).map(checkTunnel);
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
  cfg.engineIdleMinutes ??= 10;
  if (typeof cfg.engineIdleMinutes !== "number" || !(cfg.engineIdleMinutes >= 0)) throw new Error("engineIdleMinutes must be a number >= 0 (0 disables)");
  return cfg;
}

function loadCuaServer() {
  const key = (n) => n.split(".").map((x) => x.padStart(12, "0")).join(".");
  const versions = readdirSync(PLUGIN_DIR)
    .filter((v) => existsSync(join(PLUGIN_DIR, v, ".mcp.json")))
    .sort((a, b) => (key(a) < key(b) ? -1 : 1));
  if (!versions.length) throw new Error(`no unified-computer-use plugin under ${PLUGIN_DIR}; open ChatGPT.app and set up Computer Use in Codex`);
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
    // Codex attaches turn metadata to every tool call; cua_repl's browser service
    // requires it. One turn spans the whole session: turn_ended only releases tabs
    // when it names the turn of the last browser request.
    this.sessionId = randomUUID();
    this.turnId = randomUUID();
    this.used = false;
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
      clientInfo: { name: NAME, version: VERSION },
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
    const _meta = { "x-codex-turn-metadata": { session_id: this.sessionId, turn_id: this.turnId } };
    const run = () => {
      this.used = true;
      return this.request("tools/call", { name, arguments: args, _meta }, timeoutMs);
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  // Ending the turn makes the browser service release attached tabs and close the
  // ones it created; without it they stay locked to this dead session.
  async endTurn() {
    if (this.dead || !this.used) return;
    const args = { hook_event_name: "Stop", session_id: this.sessionId, turn_id: this.turnId };
    const run = () => this.request("tools/call", { name: "turn_ended", arguments: args }, 10_000);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    try {
      await p;
      // turn_ended returns before the browser service finishes detaching tabs.
      await new Promise((r) => setTimeout(r, 2000));
    } catch (e) { log(`[${this.label}] turn_ended failed: ${e.message}`); }
  }

  async close() {
    if (this.dead) return;
    await this.endTurn();
    this.proc.kill("SIGTERM");
  }
}

// ---------- surfaces ----------

// Browsers cua_repl's browser service can drive (by family), and the app that must be allowed for each.
const BROWSER_APPS = {
  brave: "com.brave.Browser", chrome: "com.google.Chrome", edge: "com.microsoft.edgemac", chromium: "org.chromium.Chromium",
};
const FAIL = "[[cub-failed]]";
// Every call writes this, so the bridge can tell its own output from cua_repl's.
const MARK = "[[cub-out]]";
const DEFAULT_MAX_WIDTH = 1280;
const DEFAULT_TREE_MAX = 20_000;
const TAB_GROUP = "🤖 Agent";

const appProp = { type: "string", description: "Bundle ID (e.g. com.brave.Browser) or app name; must be an allowed app." };
const tabProp = { type: "string", description: "Browser tab ID from list_tabs or open_tab. Give tab instead of app to act inside that tab." };
const elementProp = { type: "integer", minimum: 0, description: "Element number from the latest accessibility tree." };
const maxWidthProp = {
  type: "integer", minimum: 0, maximum: 4000,
  description: `Downscale screenshots wider than this many pixels (default ${DEFAULT_MAX_WIDTH}; 0 keeps the original). Coordinates you pass later refer to the image you received; the bridge maps them back.`,
};
const xyProps = { x: { type: "number" }, y: { type: "number" } };

// Actions shared by the single-action tools and batch. All accept app or tab.
const ACTIONS = {
  click: {
    description: "Click an element (preferred) or coordinates [x, y] from the latest screenshot.",
    props: { element: elementProp, ...xyProps, button: { type: "string", enum: ["left", "right", "middle"] }, count: { type: "integer", minimum: 1, maximum: 3 } },
  },
  type_text: { description: "Type text into the focused element.", props: { text: { type: "string" } }, required: ["text"] },
  press_key: {
    description: "Press a key or combination, xdotool syntax: Return, Tab, Escape, Up, super+t (Cmd+T), super+l, shift+Tab.",
    props: { key: { type: "string" } },
    required: ["key"],
  },
  paste: {
    description: "Paste text into the focused element through the clipboard, which is restored afterwards. Much faster than type_text for long text.",
    props: { text: { type: "string" }, format: { type: "string", enum: ["text", "md", "html"] } },
    required: ["text"],
  },
  set_value: { description: "Set a settable element's value (e.g. a text field).", props: { element: elementProp, value: { type: "string" } }, required: ["element", "value"] },
  select_text: {
    description: "Select text inside an editable element, or put the cursor just before or after it. prefix/suffix disambiguate repeated text.",
    props: {
      element: elementProp, text: { type: "string" }, prefix: { type: "string" }, suffix: { type: "string" },
      placement: { type: "string", enum: ["select", "cursor_before", "cursor_after"] },
    },
    required: ["element", "text"],
  },
  scroll: {
    description: "Scroll an element, or coordinates [x, y], by pages.",
    props: { element: elementProp, ...xyProps, direction: { type: "string", enum: ["up", "down", "left", "right"] }, pages: { type: "number", exclusiveMinimum: 0, maximum: 20 } },
    required: ["direction"],
  },
  drag: {
    description: "Drag between coordinates from the latest screenshot.",
    props: { from_x: { type: "number" }, from_y: { type: "number" }, to_x: { type: "number" }, to_y: { type: "number" } },
    required: ["from_x", "from_y", "to_x", "to_y"],
  },
  secondary_action: {
    description: "Perform an element's listed secondary action (e.g. Raise, Copy, Increment).",
    props: { element: elementProp, action: { type: "string" } },
    required: ["element", "action"],
  },
};

// A batch step is any action's parameters plus "action"; secondary_action's own
// action name moves to "name" because "action" selects the step.
const batchItemProps = Object.assign({}, ...Object.values(ACTIONS).map((d) => d.props), {
  action: { type: "string", enum: [...Object.keys(ACTIONS), "wait"] },
  name: { type: "string", description: "secondary_action only: the action name." },
  ms: { type: "integer", minimum: 0, maximum: 10_000, description: "wait only: milliseconds (default 500)." },
});

const locatorProps = {
  css: { type: "string", description: "CSS selector." },
  role: { type: "string", description: "ARIA role, optionally with name." },
  name: { type: "string", description: "Accessible name for role." },
  text: { type: "string", description: "Visible text." },
  label: { type: "string", description: "Form label text." },
  placeholder: { type: "string" },
  test_id: { type: "string" },
  exact: { type: "boolean" },
  nth: { type: "integer", minimum: 0, description: "Pick the Nth match (0-based) when several match." },
};

const TOOL_DEFS = [
  { name: "list_apps", readOnly: true, description: "List the apps this bridge may control and whether they are running.", props: {} },
  {
    name: "release",
    description: "Release computer use when you are done for now: at the end of a task, or before waiting more than a few minutes. Detaches browser tabs (they stay open) and stops the engine, which clears the Mac's screen-sharing and browser-debugging indicators. The next call restarts the engine automatically; call get_state again before using element numbers.",
    props: {},
  },
  {
    name: "launch_app",
    description: "Start an allowed app in the background without bringing it to the front.",
    props: { app: appProp },
    required: ["app"],
  },
  {
    name: "get_state",
    readOnly: true,
    description: "Return the accessibility tree of an app's frontmost window (binding it on the first call, or again with rebind=true after the user switches windows) or of a browser tab. Later calls return a diff unless full=true.",
    props: {
      app: appProp, tab: tabProp, full: { type: "boolean" }, rebind: { type: "boolean" }, screenshot: { type: "boolean" }, max_width: maxWidthProp,
      max_chars: { type: "integer", minimum: 0, description: `Return at most this many characters of the tree (default ${DEFAULT_TREE_MAX} unless the server sets treeMaxChars; 0 for no limit). Other tools always use the server's limit.` },
    },
  },
  { name: "screenshot", readOnly: true, description: "Screenshot of the app's bound window or of a browser tab.", props: { app: appProp, tab: tabProp, max_width: maxWidthProp } },
  ...Object.entries(ACTIONS).map(([name, d]) => ({
    name,
    description: `${d.description} Returns a diff of the tree.`,
    props: { app: appProp, tab: tabProp, ...d.props },
    required: d.required,
  })),
  {
    name: "batch",
    description: "Run up to 25 actions in order in one call (click, type_text, press_key, paste, set_value, select_text, scroll, drag, secondary_action, or wait with ms), then return the tree once. Stops at the first failing step. Element numbers are from the tree before the batch, so prefer coordinates or stable elements for later steps.",
    props: {
      app: appProp, tab: tabProp,
      actions: { type: "array", minItems: 1, maxItems: 25, items: { type: "object", properties: batchItemProps, required: ["action"], additionalProperties: false } },
      screenshot: { type: "boolean", description: "Also return a screenshot after the last step." },
      max_width: maxWidthProp,
    },
    required: ["actions"],
  },
  {
    name: "list_tabs",
    readOnly: true,
    description: "List open tabs in the allowed browsers (most recently opened first): tab ID, title and URL.",
    props: { browser: { type: "string", description: "Limit to one browser app (bundle ID or name)." }, limit: { type: "integer", minimum: 1, maximum: 200 } },
  },
  {
    name: "open_tab",
    description: `Open a URL in a new tab (in the browser's "${TAB_GROUP}" tab group) and return its tab ID and tree.`,
    props: { url: { type: "string" }, browser: { type: "string", description: "Browser app (bundle ID or name); default: the first allowed browser that is running." } },
    required: ["url"],
  },
  {
    name: "navigate_tab",
    description: "Navigate a tab: goto (with url), back, forward or reload.",
    props: { tab: tabProp, action: { type: "string", enum: ["goto", "back", "forward", "reload"] }, url: { type: "string" } },
    required: ["tab", "action"],
  },
  { name: "close_tab", description: "Close a tab.", props: { tab: tabProp }, required: ["tab"] },
  {
    name: "read_tab",
    readOnly: true,
    description: "Read a tab's content: the visible text of the page or of a CSS selector (format text), or a DOM snapshot (format dom).",
    props: { tab: tabProp, format: { type: "string", enum: ["text", "dom"] }, selector: { type: "string" }, max_chars: { type: "integer", minimum: 100, maximum: 200_000 } },
    required: ["tab"],
  },
  {
    name: "eval_tab",
    readOnly: true,
    description: "Evaluate a JavaScript expression in a tab's read-only page sandbox (DOM reads only: no writes, events, cookies, storage or network) and return the JSON result.",
    props: { tab: tabProp, expression: { type: "string" }, max_chars: { type: "integer", minimum: 100, maximum: 200_000 } },
    required: ["tab", "expression"],
  },
  {
    name: "tab_locator",
    description: "Find an element in a tab with a Playwright locator (css, role+name, text, label, placeholder or test_id) and click, dblclick, fill, type, press (a key), check, uncheck, select_option, or read its text or count. Good for repetitive pages where element numbers shift.",
    props: {
      tab: tabProp, ...locatorProps,
      action: { type: "string", enum: ["click", "dblclick", "fill", "type", "press", "check", "uncheck", "select_option", "text", "count"] },
      value: { type: "string", description: "Text for fill/type, key for press, option for select_option." },
    },
    required: ["tab", "action"],
  },
];

const toolSchema = ({ name, description, props, required, readOnly }) => ({
  name,
  description,
  inputSchema: { type: "object", properties: props, required: required ?? [], additionalProperties: false },
  annotations: { readOnlyHint: !!readOnly, destructiveHint: !readOnly, openWorldHint: true },
});

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
const opt = (v, name, max) => (v === undefined ? undefined : str(v, name, max));
const J = JSON.stringify;

const httpUrl = (v) => {
  str(v, "url", 4000);
  let u;
  try { u = new URL(v); } catch { throw new BadInput("url must be an absolute http(s) URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new BadInput("url must be http or https");
  return u.toString();
};

// Coordinates go through __xy, which maps them from a downscaled screenshot back to the target.
function position(a) {
  if (a.element !== undefined) return J(int(a.element, "element"));
  if (a.x !== undefined || a.y !== undefined) return `__xy(${num(a.x, "x")}, ${num(a.y, "y")})`;
  throw new BadInput("give element, or x and y");
}

function actionJs(name, a, isTab) {
  // Tab input methods take an element first; null means the focused element.
  const focus = isTab ? "null, " : "";
  switch (name) {
    case "click": {
      const opts = {};
      if (a.button !== undefined) {
        if (!["left", "right", "middle"].includes(a.button)) throw new BadInput("button must be left, right or middle");
        opts.mouseButton = a.button;
      }
      if (a.count !== undefined) opts.clickCount = int(a.count, "count");
      return `await tgt.click(${position(a)}, ${J(opts)});`;
    }
    case "type_text": return `await tgt.typeText(${focus}${J(str(a.text, "text"))});`;
    case "press_key": {
      if (!/^[A-Za-z0-9_+\-]{1,40}$/.test(a.key ?? "")) throw new BadInput("key must look like Return, super+t or KP_0");
      return `await tgt.pressKey(${focus}${J(a.key)});`;
    }
    case "paste": {
      const format = a.format ?? "text";
      if (!["text", "md", "html"].includes(format)) throw new BadInput("format must be text, md or html");
      return `await tgt.paste(${focus}${J(str(a.text, "text", 200_000))}, ${J({ format })});`;
    }
    case "set_value": return `await tgt.setValue(${J(int(a.element, "element"))}, ${J(str(a.value, "value"))});`;
    case "select_text": {
      const placement = { select: "text", cursor_before: "cursor_before", cursor_after: "cursor_after" }[a.placement ?? "select"];
      if (!placement) throw new BadInput("placement must be select, cursor_before or cursor_after");
      const opts = { selectionType: placement, prefix: opt(a.prefix, "prefix", 2000), suffix: opt(a.suffix, "suffix", 2000) };
      return `await tgt.selectText(${J(int(a.element, "element"))}, ${J(str(a.text, "text", 2000))}, ${J(opts)});`;
    }
    case "scroll": {
      if (!["up", "down", "left", "right"].includes(a.direction)) throw new BadInput("direction must be up, down, left or right");
      const pages = a.pages === undefined ? "" : `, ${num(a.pages, "pages")}`;
      return `await tgt.scroll(${position(a)}, ${J(a.direction)}${pages});`;
    }
    case "drag":
      return `await tgt.drag(__xy(${num(a.from_x, "from_x")}, ${num(a.from_y, "from_y")}), __xy(${num(a.to_x, "to_x")}, ${num(a.to_y, "to_y")}));`;
    case "secondary_action":
      return `await tgt.performSecondaryAction(${J(int(a.element, "element"))}, ${J(str(a.action, "action", 100))});`;
    case "wait": {
      const ms = int(a.ms ?? 500, "ms");
      if (ms > 10_000) throw new BadInput("ms must be at most 10000");
      return `await new Promise((r) => setTimeout(r, ${ms}));`;
    }
    default: throw new BadInput(`unknown action ${name}`);
  }
}

function locatorJs(a) {
  const exact = a.exact === undefined ? {} : { exact: a.exact === true };
  let loc;
  if (a.css !== undefined) loc = `pw.locator(${J(str(a.css, "css", 2000))})`;
  else if (a.role !== undefined) loc = `pw.getByRole(${J(str(a.role, "role", 100))}, ${J({ ...exact, ...(a.name === undefined ? {} : { name: str(a.name, "name", 2000) }) })})`;
  else if (a.text !== undefined) loc = `pw.getByText(${J(str(a.text, "text", 2000))}, ${J(exact)})`;
  else if (a.label !== undefined) loc = `pw.getByLabel(${J(str(a.label, "label", 2000))}, ${J(exact)})`;
  else if (a.placeholder !== undefined) loc = `pw.getByPlaceholder(${J(str(a.placeholder, "placeholder", 2000))}, ${J(exact)})`;
  else if (a.test_id !== undefined) loc = `pw.getByTestId(${J(str(a.test_id, "test_id", 500))})`;
  else throw new BadInput("give one of css, role, text, label, placeholder or test_id");
  if (a.nth !== undefined) loc += `.nth(${int(a.nth, "nth")})`;
  const value = () => J(str(a.value, "value"));
  const t = { timeoutMs: 10_000 };
  switch (a.action) {
    case "click": return { code: `await ${loc}.click(${J(t)});` };
    case "dblclick": return { code: `await ${loc}.dblclick(${J(t)});` };
    case "fill": return { code: `await ${loc}.fill(${value()}, ${J(t)});` };
    case "type": return { code: `await ${loc}.type(${value()}, ${J(t)});` };
    case "press": return { code: `await ${loc}.press(${value()}, ${J(t)});` };
    case "check": return { code: `await ${loc}.check(${J(t)});` };
    case "uncheck": return { code: `await ${loc}.uncheck(${J(t)});` };
    case "select_option": return { code: `await ${loc}.selectOption(${value()}, ${J(t)});` };
    case "text": return { code: `nodeRepl.write(await ${loc}.innerText(${J(t)}));`, read: true };
    case "count": return { code: `nodeRepl.write(String(await ${loc}.count()));`, read: true };
    default: throw new BadInput("action must be click, dblclick, fill, type, press, check, uncheck, select_option, text or count");
  }
}

// Shared REPL prelude: per-session handles and coordinate mapping. __scale is the
// factor of the target's last screenshot, which the bridge downscales after the call.
const prelude = (scale) => `nodeRepl.write(${J(MARK)});
globalThis.__cub ??= { apps: {}, tabs: {} };
const __C = globalThis.__cub;
const __xy = (x, y) => [Math.round(x * ${scale}), Math.round(y * ${scale})];
const __shot = async () => nodeRepl.emitImage(await tgt.getScreenshot({ emit: false }));
const __trunc = (s, max) => (s.length > max ? s.slice(0, max) + "\\n[truncated: " + s.length + " characters total]" : s);`;

const textResult = (text, isError = false) => ({ content: [{ type: "text", text }], isError });

// Pixel width of a PNG or JPEG, or undefined.
function imageWidth(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return buf.readUInt32BE(16);
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
  for (let i = 2; i + 9 < buf.length;) {
    if (buf[i] !== 0xff) return undefined;
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return buf.readUInt16BE(i + 7);
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return undefined;
}

// Downscales an image block with macOS sips; returns the block and the scale factor.
async function scaleImage(block, maxWidth) {
  const buf = Buffer.from(block.data, "base64");
  const width = imageWidth(buf);
  if (!maxWidth || !width || width <= maxWidth) return { block, scale: 1 };
  const dir = await mkdtemp(join(tmpdir(), `${NAME}-`));
  try {
    const src = join(dir, block.mimeType === "image/png" ? "in.png" : "in.jpg");
    const out = join(dir, "out.jpg");
    await writeFile(src, buf);
    await new Promise((resolve, reject) => execFile("/usr/bin/sips",
      ["--resampleWidth", String(maxWidth), "-s", "format", "jpeg", "-s", "formatOptions", "75", src, "--out", out],
      (e) => (e ? reject(e) : resolve())));
    const data = (await readFile(out)).toString("base64");
    return { block: { type: "image", mimeType: "image/jpeg", data }, scale: width / maxWidth, width };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

class Session {
  constructor(cfg, label) {
    this.cfg = cfg;
    this.label = label;
    this.child = null;
    this.starting = null;
    this.appNames = null;
    this.lastUsed = Date.now();
    this.scales = new Map();
    this.busy = 0;
    this.notice = null;
    this.tools = TOOL_DEFS.filter((t) => t.name !== "eval_tab" || cfg.tabEval !== false).map(toolSchema);
    // The engine holds screen capture and tab attachments while it runs, so it is
    // stopped when idle; the MCP session stays open and restarts it on demand.
    const idleMs = cfg.engineIdleMinutes * 60_000;
    if (cfg.surface === "fixed" && idleMs > 0) {
      this.reaper = setInterval(() => {
        if (this.child && !this.busy && Date.now() - this.lastUsed >= idleMs) this.stopEngine("idle");
      }, Math.min(30_000, idleMs)).unref();
    }
  }

  async cua() {
    if (this.child && !this.child.dead) return this.child;
    this.starting ??= (async () => {
      const c = new CuaChild(this.cfg, this.label);
      await c.start();
      this.child = c;
      this.appNames = null;
      if (this.stopReason) {
        this.notice = `The computer-use engine was restarted (${this.stopReason}), so element numbers from earlier trees are stale; call get_state before using them.`;
        this.stopReason = null;
      }
      return c;
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  // Ends the turn (releasing tabs) and stops cua_repl; the next call starts a new one.
  async stopEngine(why) {
    const c = this.child;
    if (!c) return false;
    this.child = null;
    this.stopReason = why;
    log(`[${this.label}] stopping engine (${why})`);
    await c.close();
    return true;
  }

  close() {
    clearInterval(this.reaper);
    return this.child?.close();
  }

  instructions() {
    if (this.cfg.surface === "raw") return "Computer use on this Mac through cua_repl (Codex computer use). The js tool runs JavaScript as the Mac user.";
    return `Computer use on the Mac "${hostname()}" through Codex's engine. Allowed apps: ${this.cfg.allowApps.join(", ") || "(none)"}. ` +
      "For native apps, call get_state(app) first; element numbers refer to the latest tree and change after UI updates. Actions return a diff of the tree. " +
      "For web pages in an allowed browser, prefer tabs: list_tabs or open_tab, then pass tab instead of app to get_state, screenshot and the actions; read_tab, eval_tab and tab_locator work on tabs only. " +
      "Use batch to run several actions in one call. Screenshots are downscaled; coordinates you give refer to the image you received. " +
      "Call release when you finish with computer use, or before waiting more than a few minutes; it clears the screen-sharing and browser-debugging indicators on the Mac. " +
      "Input goes to the target without moving the user's cursor, but the user may be using the same window. " +
      "Ask the user before sending messages, submitting forms, purchasing, or transmitting sensitive data.";
  }

  async listTools() {
    if (this.cfg.surface === "fixed") return this.tools;
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
    this.busy++;
    try {
      const res = await this.callFixed(name, args ?? {});
      if (this.notice && this.child && name !== "get_state") res.content.unshift({ type: "text", text: this.notice });
      if (this.child) this.notice = null;
      return res;
    } catch (e) {
      if (e instanceof BadInput) return textResult(e.message, true);
      throw e;
    } finally {
      this.busy--;
      this.lastUsed = Date.now();
    }
  }

  // trim keeps only the error and the bridge's own output (the marked block), dropping
  // cua_repl's state dumps; it orders errors, docs, state dumps, writes, then images.
  async js(code, timeoutMs = 60_000, { trim = false } = {}) {
    // A block keeps generated bindings out of the persistent REPL scope.
    const res = await (await this.cua()).call("js", { code: `{\n${code}\n}`, timeout_ms: timeoutMs }, timeoutMs + 30_000);
    let failed = !!res.isError;
    const content = [];
    for (const [i, c] of (res.content ?? []).entries()) {
      if (c.type !== "text") { content.push(c); continue; }
      // Drop cua_repl's first-use API docs; fixed-surface clients cannot use them.
      if (/^(## Computer Use|# Other Browser APIs)/.test(c.text)) continue;
      if (trim && !c.text.includes(MARK) && !(res.isError && i === 0)) continue;
      let text = c.text.replaceAll(MARK, "");
      if (text.includes(FAIL)) {
        failed = true;
        text = text.replaceAll(FAIL, "");
      }
      // E.g. a password manager's inline autofill menu; tab automation stays blocked until it closes.
      if (/another extension UI is open/.test(text)) text += "\nDismiss it with press_key (key Escape) on the browser app, not the tab, then retry.";
      if (text.trim()) content.push({ ...c, text });
    }
    return { content: content.length ? content : [{ type: "text", text: "ok" }], isError: failed };
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
    const id = this.appNames.get(app.toLowerCase()) ?? app;
    if (allowed(id)) return id;
    throw new BadInput(`app not allowed: ${app}${id !== app ? ` (${id})` : ""}. Allowed: ${this.cfg.allowApps.join(", ")}`);
  }

  // Browser families whose app is allowed; null means any (approve-all).
  async browserFamilies(browser) {
    if (browser !== undefined) {
      const id = await this.resolveApp(browser);
      const fam = Object.keys(BROWSER_APPS).find((f) => BROWSER_APPS[f].toLowerCase() === id.toLowerCase());
      if (!fam) throw new BadInput(`${browser} is not a supported browser (${Object.values(BROWSER_APPS).join(", ")})`);
      return [fam];
    }
    if (this.cfg.approve === "all") return null;
    const fams = Object.keys(BROWSER_APPS).filter((f) => this.cfg.isAllowed(BROWSER_APPS[f]));
    if (!fams.length) throw new BadInput(`no allowed browser; allow one of ${Object.values(BROWSER_APPS).join(", ")}`);
    return fams;
  }

  // Binds tgt to an app's frontmost window; key scopes the screenshot scale.
  static bindApp(idExpr, rebind) {
    return `const __id = ${idExpr};
const __key = "app:" + __id;
let tgt = __C.apps[__id];
const fresh = !tgt || ${rebind === true};
if (fresh) {
  try { tgt = await cua.getApp(__id); }
  catch (e) {
    // Updaters (e.g. Sparkle) leave a second copy with the same bundle ID; prefer the installed one.
    const m = /bundle identifier: (.*)\\. Use an app name/.exec(e.message);
    const pick = (m ? m[1].split(/, (?=\\/)/) : []).find((p) => /^(\\/System)?\\/Applications\\/|^\\/Users\\/[^/]+\\/Applications\\//.test(p));
    if (!pick) throw e;
    tgt = await cua.getApp(pick);
  }
  __C.apps[__id] = tgt;
}`;
  }

  // Binds tgt to a tab, attaching it to this session on first use; only allowed browsers are searched.
  static bindTab(tab, fams, rebind) {
    return `const __key = "tab:" + ${J(tab)};
let tgt = __C.tabs[${J(tab)}];
const fresh = !tgt || ${rebind === true};
if (fresh) {
  let err;
  tgt = undefined;
  for (const b of await cua.listBrowsers({ emit: false })) {
    if (${J(fams)} && !${J(fams)}.includes(b.family)) continue;
    try { tgt = await cua.getTab(${J(tab)}, { browser: b.id }); break; } catch (e) { err = e; }
  }
  if (!tgt) throw err ?? new Error("tab " + ${J(tab)} + " is not open in an allowed browser");
  __C.tabs[${J(tab)}] = tgt;
}`;
  }

  async bindTarget(a, { tabOnly = false } = {}) {
    const hasApp = a.app !== undefined;
    const hasTab = a.tab !== undefined;
    if (hasApp && hasTab) throw new BadInput("give app or tab, not both");
    if (hasTab) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(str(a.tab, "tab", 64))) throw new BadInput("tab must be a tab ID from list_tabs or open_tab");
      return { isTab: true, key: `tab:${a.tab}`, bind: Session.bindTab(a.tab, await this.browserFamilies(), a.rebind) };
    }
    if (tabOnly) throw new BadInput("give tab");
    if (!hasApp) throw new BadInput("give app or tab");
    const id = await this.resolveApp(a.app);
    return { isTab: false, key: `app:${id}`, bind: Session.bindApp(J(id), a.rebind) };
  }

  // Trees of big pages run to hundreds of thousands of characters; results keep the
  // top of each so they fit an agent's context. read_tab and eval_tab have their own limit.
  treeCap(name, a) {
    if (name === "read_tab" || name === "eval_tab") return 0;
    const n = name === "get_state" && a.max_chars !== undefined ? a.max_chars : this.cfg.treeMaxChars ?? DEFAULT_TREE_MAX;
    if (!Number.isInteger(n) || n < 0) throw new BadInput("max_chars must be a non-negative integer");
    return n;
  }

  maxWidth(a) {
    const w = a.max_width ?? this.cfg.screenshotMaxWidth ?? DEFAULT_MAX_WIDTH;
    if (!Number.isInteger(w) || w < 0 || w > 4000) throw new BadInput("max_width must be an integer from 0 to 4000");
    return w;
  }

  // A tab whose debugger detached stays broken under its cached handle, so re-attach
  // and retry once. Batches only retry when nothing ran yet (stopped at step 1).
  async callFixed(name, a) {
    const res = await this.callFixedOnce(name, a);
    const text = res.isError && a.tab !== undefined ? res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : "";
    if (!/Debugger (unattached|detached|is not attached)/i.test(text)) return res;
    if (name === "batch" && /Batch stopped at step (?!1 )\d+/.test(text)) return res;
    log(`[${this.label}] tab ${a.tab}: debugger detached; re-attaching and retrying ${name}`);
    let again = await this.callFixedOnce(name, { ...a, rebind: true });
    const stuck = (r) => r.isError && /Debugger (unattached|detached|is not attached)/i.test(r.content.map((c) => c.text ?? "").join("\n"));
    // The dead attachment belongs to this engine; a new engine attaches the same tab fine.
    if (stuck(again)) {
      await this.stopEngine("tab debugger stuck");
      again = await this.callFixedOnce(name, a);
      this.notice = null;
      again.content.unshift({ type: "text", text: stuck(again)
        ? "The tab's debugger had detached and even a new engine could not re-attach it; open the page in a new tab with open_tab."
        : "The tab's debugger had detached; the bridge restarted the engine and retried. Other tabs and windows of this session were re-attached, so call get_state before using their element numbers." });
      return again;
    }
    again.content.unshift({ type: "text", text: "The tab's debugger had detached; the bridge re-attached it and retried." });
    return again;
  }

  async callFixedOnce(name, a) {
    if (!this.tools.some((t) => t.name === name)) throw new BadInput(`unknown tool ${name}`);
    const maxWidth = this.maxWidth(a);
    const cap = this.treeCap(name, a);
    // Screenshots are downscaled here; the factor maps the client's coordinates back.
    const run = async (body, t, timeoutMs, { trim = false } = {}) => {
      const res = await this.js(`${prelude(t ? (this.scales.get(t.key) ?? 1) : 1)}\n${body}`, timeoutMs, { trim });
      for (const c of res.content) {
        if (!cap || c.type !== "text" || c.text.length <= cap) continue;
        const cut = c.text.lastIndexOf("\n", cap) > cap * 0.8 ? c.text.lastIndexOf("\n", cap) : cap;
        const more = t?.isTab || name === "open_tab" ? "; for page content use read_tab or tab_locator" : "";
        c.text = `${c.text.slice(0, cut)}\n[Tree truncated: showing ${cut} of ${c.text.length} characters. Elements after this point exist but are not listed. Use get_state with a larger max_chars to see them${more}.]`;
      }
      for (const [i, c] of [...res.content.entries()]) {
        if (c.type !== "image") continue;
        const scaled = await scaleImage(c, maxWidth);
        res.content[i] = scaled.block;
        if (t) this.scales.set(t.key, scaled.scale);
        if (scaled.scale !== 1) res.content.push({ type: "text", text: `Screenshot scaled from ${scaled.width} to ${maxWidth} px wide; give coordinates from this image.` });
      }
      return res;
    };

    switch (name) {
      case "release":
        return textResult(await this.stopEngine("released")
          ? "Released: browser tabs detached and the engine stopped. The next call restarts it."
          : "Nothing to release; the engine is not running.");
      case "list_apps": {
        const ids = this.cfg.approve === "all" ? null : this.cfg.allowApps;
        return this.js(`const ids = ${J(ids)}; const apps = await cua.listApps({ emit: false });
nodeRepl.write(JSON.stringify(apps.filter((a) => !ids || ids.includes(a.id)).map(({ id, displayName, isRunning }) => ({ id, displayName, isRunning })), null, 1));`);
      }
      case "launch_app": {
        const id = await this.resolveApp(a.app);
        const byId = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(id);
        await new Promise((resolve, reject) => execFile("/usr/bin/open", ["-g", byId ? "-b" : "-a", id], (e) => (e ? reject(new BadInput(`could not launch ${id}: ${e.message}`)) : resolve())));
        return textResult(`launched ${id} in the background; call get_state to bind its window`);
      }
      case "get_state": {
        const t = await this.bindTarget(a);
        const shot = a.screenshot === true ? `await __shot();` : "";
        return run(`${t.bind}
if (!fresh) await tgt.getAXState(${J(a.full === true ? { disableDiffing: true } : {})});
${shot}`, t);
      }
      case "screenshot": {
        const t = await this.bindTarget(a);
        return run(`${t.bind}\nawait __shot();`, t, undefined, { trim: true });
      }
      case "batch": {
        const t = await this.bindTarget(a);
        if (!Array.isArray(a.actions) || a.actions.length < 1 || a.actions.length > 25) throw new BadInput("actions must hold 1 to 25 steps");
        const steps = a.actions.map((s, i) => {
          if (typeof s !== "object" || s === null) throw new BadInput(`step ${i + 1} must be an object`);
          const { action, name: actionName, ...rest } = s;
          if (action !== "wait" && !ACTIONS[action]) throw new BadInput(`step ${i + 1}: unknown action ${action}`);
          const params = action === "secondary_action" ? { ...rest, action: actionName } : rest;
          try {
            return `__step = ${i + 1}; __what = ${J(action)};\n${actionJs(action, params, t.isTab)}`;
          } catch (e) {
            throw e instanceof BadInput ? new BadInput(`step ${i + 1} (${action}): ${e.message}`) : e;
          }
        });
        const waits = a.actions.reduce((n, s) => n + (s.action === "wait" ? (s.ms ?? 500) : 0), 0);
        const shot = a.screenshot === true ? `await __shot();` : "";
        return run(`${t.bind}
let __step = 0, __what = "";
try {
${steps.join("\n")}
} catch (e) { nodeRepl.write(${J(FAIL)} + "Batch stopped at step " + __step + " (" + __what + "): " + e.message + "\\n"); }
await tgt.getAXState();
${shot}`, t, 60_000 + waits);
      }
      case "list_tabs": {
        const fams = await this.browserFamilies(a.browser);
        const limit = a.limit === undefined ? 50 : int(a.limit, "limit");
        return run(`const __out = [];
for (const b of await cua.listBrowsers({ emit: false })) {
  if (${J(fams)} && !${J(fams)}.includes(b.family)) continue;
  for (const t of await (await agent.browsers.get(b.id)).user.openTabs()) {
    __out.push({ tab: t.id, browser: b.name, title: t.title, url: t.url });
  }
}
nodeRepl.write(JSON.stringify(__out.slice(0, ${Math.min(limit, 200)}), null, 1) + (__out.length > ${limit} ? "\\n(" + __out.length + " tabs; raise limit to see more)" : ""));`);
      }
      case "open_tab": {
        const url = httpUrl(a.url);
        const fams = await this.browserFamilies(a.browser);
        // The engine's own way to open a tab, as ChatGPT does; its tabs land in a named tab
        // group. Opening with Cmd+T and attaching to the new-tab page hung or detached.
        return run(`const __b = (await cua.listBrowsers({ emit: false })).find((b) => !${J(fams)} || ${J(fams)}.includes(b.family));
if (!__b) throw new Error("no allowed browser is running with the ChatGPT extension connected");
const __tab = await cua.createBrowserTab(__b.family, ${J(url)}, { sessionName: ${J(TAB_GROUP)}, emit: false });
__C.tabs[__tab.id] = __tab;
nodeRepl.write("Opened tab " + __tab.id + " in " + __b.name + ".\\n" + await __tab.getAXState({ emit: false, disableDiffing: true }));`, undefined, undefined, { trim: true });
      }
      case "navigate_tab": {
        const t = await this.bindTarget(a, { tabOnly: true });
        let call;
        if (a.action === "goto") call = `await tgt.goto(${J(httpUrl(a.url))});`;
        else if (["back", "forward", "reload"].includes(a.action)) call = `await tgt.${a.action}();`;
        else throw new BadInput("action must be goto, back, forward or reload");
        return run(`${t.bind}\n${call}\nnodeRepl.write("Now at " + (await tgt.url()) + "\\n");\nawait tgt.getAXState({ disableDiffing: true });`, t);
      }
      case "close_tab": {
        const t = await this.bindTarget(a, { tabOnly: true });
        return run(`${t.bind}\nawait tgt.close();\ndelete __C.tabs[${J(a.tab)}];\nnodeRepl.write("Closed tab " + ${J(a.tab)});`, t, undefined, { trim: true });
      }
      case "read_tab": {
        const t = await this.bindTarget(a, { tabOnly: true });
        const max = a.max_chars === undefined ? 20_000 : int(a.max_chars, "max_chars");
        const format = a.format ?? "text";
        let read;
        if (format === "dom") read = `await tgt.playwright.domSnapshot()`;
        else if (format === "text") read = `await tgt.playwright.locator(${J(opt(a.selector, "selector", 2000) ?? "body")}).first().innerText({ timeoutMs: 10000 })`;
        else throw new BadInput("format must be text or dom");
        return run(`${t.bind}\nnodeRepl.write(__trunc(String(${read}), ${max}));`, t, undefined, { trim: true });
      }
      case "eval_tab": {
        const t = await this.bindTarget(a, { tabOnly: true });
        const max = a.max_chars === undefined ? 20_000 : int(a.max_chars, "max_chars");
        return run(`${t.bind}
const __r = await tgt.playwright.evaluate(${J(str(a.expression, "expression", 20_000))});
nodeRepl.write(__trunc(__r === undefined ? "undefined" : JSON.stringify(__r, null, 1) ?? String(__r), ${max}));`, t, undefined, { trim: true });
      }
      case "tab_locator": {
        const t = await this.bindTarget(a, { tabOnly: true });
        const { code, read } = locatorJs(a);
        return run(`${t.bind}\nconst pw = tgt.playwright;\n${code}\n${read ? "" : "await tgt.getAXState();"}`, t, undefined, { trim: !!read });
      }
      default: {
        const t = await this.bindTarget(a);
        return run(`${t.bind}\n${actionJs(name, a, t.isTab)}\nawait tgt.getAXState();`, t);
      }
    }
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
          serverInfo: { name: NAME, version: VERSION },
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
const SSH_TUNNEL_OPTS = [
  "-N", "-T", "-v", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=3", "-o", "ConnectTimeout=20", "-o", "RemoteCommand=none", "-o", "RequestTTY=no",
  // A shared ControlMaster connection would hand the forward to the master and exit.
  "-o", "ControlMaster=no", "-o", "ControlPath=none",
];

class Tunnel {
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
    log(`serving fixed surface on http://${cfg.host}:${cfg.port}/mcp; apps: ${cfg.allowApps.join(", ")}`);
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

// ---------- setup and status ----------

const LEGACY = {
  dir: join(homedir(), ".config/codex-cu-bridge"),
  label: "com.hank-warren.codex-cu-bridge",
  files: [join(homedir(), ".local/bin/codex-cu-bridge"), join(homedir(), ".local/share/codex-cu-bridge")],
};
const LEGACY_PLIST = join(homedir(), "Library/LaunchAgents", `${LEGACY.label}.plist`);
const KNOWN_APPS = [
  ["com.brave.Browser", "Brave Browser"], ["com.google.Chrome", "Google Chrome"], ["com.microsoft.edgemac", "Microsoft Edge"],
  ["com.tinyspeck.slackmacgap", "Slack"], ["com.hnc.Discord", "Discord"],
];

const run = (cmd, args, timeout = 30_000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout }, (e, stdout, stderr) => resolve({ ok: !e, code: e?.code ?? 0, stdout: String(stdout), stderr: String(stderr) }));
});
const say = (s = "") => process.stdout.write(s + "\n");
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
const writePrivate = (f, text) => {
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  writeFileSync(f, text, { mode: 0o600 });
  chmodSync(f, 0o600);
};
const inRange = (ip, [base, bits]) => {
  const n = (s) => s.split(".").reduce((a, o) => a * 256 + Number(o), 0);
  const mask = 2 ** 32 - 2 ** (32 - bits);
  return (n(ip) & mask) >>> 0 === (n(base) & mask) >>> 0;
};

// Tailscale's IPv4 from its CLI. Not guessed from interfaces: other VPNs (e.g. WARP) use the same range.
async function tailscaleIp() {
  for (const cli of ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"]) {
    if (!existsSync(cli)) continue;
    const r = await run(cli, ["ip", "-4"], 5000);
    const ip = r.stdout.trim().split("\n")[0];
    if (r.ok && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
  }
  return null;
}

// Private addresses on physical interfaces; VPN tunnels (utun, ipsec, ppp) are skipped.
function lanIps() {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (/^(utun|ipsec|ppp|gif|stf)/.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if ([["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16]].some((r) => inRange(a.address, r))) out.push({ ip: a.address, name });
    }
  }
  return out;
}

async function installedApps() {
  const found = [];
  for (const [id, label] of KNOWN_APPS) {
    const r = await run("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${id}'`], 5000);
    if (r.stdout.trim() || existsSync(`/Applications/${label}.app`)) found.push([id, label]);
  }
  return found;
}

function brewPath() {
  for (const p of [process.env.HOMEBREW_PREFIX && join(process.env.HOMEBREW_PREFIX, "bin/brew"), "/opt/homebrew/bin/brew", "/usr/local/bin/brew"]) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

async function health(host, port, waitMs = 0, tokenFile) {
  const until = Date.now() + waitMs;
  let headers = {};
  try { if (tokenFile) headers = { Authorization: `Bearer ${readFileSync(expand(tokenFile), "utf8").trim()}` }; } catch {}
  for (;;) {
    try {
      const r = await fetch(`http://${host}:${port}/healthz`, { headers, signal: AbortSignal.timeout(2000) });
      if (r.ok) return await r.json();
    } catch {}
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// Starts cua_repl and lists apps, which proves the engine and its macOS permissions work.
async function probeEngine() {
  const c = new CuaChild({ approve: "allowlist", isAllowed: () => false }, "probe");
  try {
    await c.start();
    const r = await c.call("js", { code: `nodeRepl.write(String((await cua.listApps({ emit: false })).length))`, timeout_ms: 20_000 }, 40_000);
    const text = (r.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
    const n = /^\d+$/m.exec(text)?.[0];
    return r.isError || !n ? { ok: false, detail: text.slice(0, 500) } : { ok: true, detail: `${n} apps visible` };
  } catch (e) {
    return { ok: false, detail: e.message };
  } finally {
    if (!c.dead) c.proc?.kill("SIGTERM");
  }
}

const macName = () => hostname().split(".")[0].toLowerCase();

const clientConfigs = (mac, url, tokenPath) => `   pi (~/.pi/agent/mcp.json, under "mcpServers"):
     "${mac}-cu": {
       "url": "${url}",
       "headers": { "Authorization": "!echo Bearer $(cat ${tokenPath})" },
       "timeout": 120
     }

   Claude Code:
     claude mcp add --transport http ${mac}-cu ${url} --header "Authorization: Bearer $(cat ${tokenPath})"`;

function clientHelp(cfg) {
  const mac = macName();
  const tokenName = `${mac}.token`;
  if (cfg.tunnels?.length) {
    for (const t of cfg.tunnels) {
      say(`
On ${t.ssh}, connect clients to http://127.0.0.1:${t.remotePort}/mcp (through the tunnel)

1. The token goes in ~/.config/${NAME}/${tokenName} there. To copy it again from this Mac:
     ssh ${t.ssh} 'umask 077; mkdir -p ~/.config/${NAME}; cat > ~/.config/${NAME}/${tokenName}' < ${cfg.tokenFile}

2. Client configuration on ${t.ssh}:
${clientConfigs(mac, `http://127.0.0.1:${t.remotePort}/mcp`, `~/.config/${NAME}/${tokenName}`)}`);
    }
    return;
  }
  const url = `http://${cfg.host}:${cfg.port}/mcp`;
  say(`
Connect a client to ${url}

1. Copy the token to the client without printing it, e.g. from the client:
     ssh ${mac} 'cat ${cfg.tokenFile}' | (umask 077; mkdir -p ~/.config/${NAME}; cat > ~/.config/${NAME}/${tokenName})

2. Client configuration:
${clientConfigs(mac, url, `~/.config/${NAME}/${tokenName}`)}

   Over SSH instead of HTTP (stdio):
     ssh -T ${mac} ${brewPath() ? join(dirname(brewPath()), NAME) : NAME} stdio`);
}

async function setup(opts) {
  const file = expand(opts.config);
  const interactive = !opts.yes && process.stdin.isTTY;
  const prompt = () => createPrompt({ input: process.stdin, output: process.stdout });
  let rl = interactive ? prompt() : null;
  // Hands the terminal to a child (e.g. ssh asking to accept a host key), then takes it back.
  const withTerminal = async (fn) => {
    rl.close();
    try { return await fn(); } finally { rl = prompt(); }
  };
  const ask = async (q, def) => {
    if (!rl) return def;
    const a = (await rl.question(`${q}${def !== undefined && def !== "" ? ` [${def}]` : ""}: `)).trim();
    return a || def;
  };
  const confirm = async (q, def = true) => {
    const a = await ask(`${q} (${def ? "Y/n" : "y/N"})`, "");
    return a ? /^y/i.test(a) : def;
  };
  try {
    say(`${NAME} ${VERSION} setup\n`);

    let engine;
    try { engine = loadCuaServer(); } catch (e) { throw new Error(`${e.message}. Then run setup again.`); }
    say(`Engine: unified-computer-use ${engine.version} from ChatGPT.app`);

    // Older installs used ~/.config/codex-cu-bridge and their own LaunchAgent.
    if (!existsSync(file) && file === DEFAULT_CONFIG && existsSync(join(LEGACY.dir, "config.json"))) {
      const old = readJson(join(LEGACY.dir, "config.json"));
      const oldToken = expand(old.tokenFile ?? join(LEGACY.dir, "token"));
      if (existsSync(oldToken)) {
        writePrivate(join(CONFIG_DIR, "token"), readFileSync(oldToken));
        old.tokenFile = join(CONFIG_DIR, "token");
      }
      writePrivate(file, JSON.stringify(old, null, 2) + "\n");
      say(`Migrated config and token from ${LEGACY.dir} (clients keep working with the same token).`);
    }
    if (file === DEFAULT_CONFIG && existsSync(LEGACY_PLIST) && await confirm(`Remove the old LaunchAgent ${LEGACY.label}? It would hold the same port`)) {
      await run("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${LEGACY.label}`]);
      rmSync(LEGACY_PLIST, { force: true });
      for (const f of LEGACY.files) rmSync(f, { recursive: true, force: true });
      say("Removed the old LaunchAgent and program files.");
    }

    const cfg = existsSync(file) ? readJson(file) : {};

    // Where clients connect: an address of this Mac, or a reverse tunnel to machines that cannot reach it.
    const ts = await tailscaleIp();
    const lans = lanIps();
    let host = opts.host;
    let tunnelMode = opts.tunnel !== undefined;
    if (host === "tailscale") host = ts ?? (() => { throw new Error("Tailscale is not connected on this Mac"); })();
    if (host === "localhost") host = "127.0.0.1";
    if (!host && !tunnelMode) {
      const choices = [];
      if (ts) choices.push({ ip: ts, label: "Tailscale (recommended: only your tailnet can reach it, and traffic is encrypted)" });
      for (const l of lans) choices.push({ ip: l.ip, label: `local network on ${l.name} (plain HTTP: anyone on this network can see traffic and the token)` });
      choices.push({ ip: "127.0.0.1", label: "this Mac only (local clients)" });
      choices.push({ tunnel: true, label: "a remote machine over SSH: for a VM you can SSH into but that cannot reach this Mac (e.g. over WARP); this Mac keeps a reverse tunnel open" });
      if (cfg.host && !cfg.tunnels?.length && !choices.some((c) => c.ip === cfg.host)) choices.unshift({ ip: cfg.host, label: "current config (not an address of this Mac right now)" });
      if (rl) {
        say("\nHow will clients connect?");
        choices.forEach((c, i) => say(`  ${i + 1}) ${c.ip ? `${c.ip}  ` : ""}${c.label}`));
      }
      const def = (cfg.tunnels?.length ? choices.findIndex((c) => c.tunnel) : Math.max(0, choices.findIndex((c) => c.ip === cfg.host))) + 1;
      const pick = String(await ask("Choose a number or type an IPv4 address", String(def)));
      const choice = /^\d+$/.test(pick) ? choices[Number(pick) - 1] : { ip: pick };
      if (!choice) throw new Error("no such choice");
      tunnelMode = !!choice.tunnel;
      host = choice.ip;
    }
    if (tunnelMode) host = "127.0.0.1";
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) throw new Error(`host must be an IPv4 address, tailscale or localhost (got ${host})`);
    if (lans.some((l) => l.ip === host)) say("Warning: the local network sees plain HTTP. Prefer Tailscale for anything but a trusted home network.");

    const port = Number(opts.port ?? await ask("Port", String(cfg.port ?? DEFAULT_PORT)));
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("port must be 1024-65535");

    const tunnels = [];
    if (tunnelMode) {
      const existing = new Map((cfg.tunnels ?? []).map((t) => [t.ssh, t.remotePort]));
      const spec = opts.tunnel ?? await ask("\nSSH host(s) to open the tunnel to, as you would type after ssh (comma-separated)", [...existing.keys()].join(","));
      for (const part of String(spec ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
        const [ssh, p] = part.split(":");
        let remotePort = p ? Number(p) : existing.get(ssh);
        if (!remotePort) {
          const def = String(47801 + randomInt(199));
          remotePort = Number(opts.tunnel !== undefined ? def : await ask(`Port to open on ${ssh} (its other users must not be using it)`, def));
        }
        tunnels.push(checkTunnel({ ssh, remotePort }));
      }
      if (!tunnels.length) throw new Error("give at least one SSH host for the tunnel");
    }

    // Which apps clients may control.
    let allow = opts.allow?.split(",").map((s) => s.trim()).filter(Boolean);
    if (!allow) {
      const found = await installedApps();
      const current = cfg.allowApps ?? found.filter(([id]) => id !== "com.google.Chrome" && id !== "com.microsoft.edgemac").map(([id]) => id);
      say("\nApps clients may control (comma-separated bundle IDs). Installed and supported here:");
      for (const [id, label] of found) say(`  ${id}  ${label}`);
      say("Find any app's ID with: osascript -e 'id of app \"App Name\"'");
      allow = String(await ask("Allow", current.join(","))).split(",").map((s) => s.trim()).filter(Boolean);
    }
    const denied = allow.filter((id) => HARD_DENY.has(id.toLowerCase()));
    if (denied.length) say(`Ignoring always-denied apps: ${denied.join(", ")}`);
    allow = allow.filter((id) => !HARD_DENY.has(id.toLowerCase()));

    const tokenFile = expand(cfg.tokenFile ?? join(CONFIG_DIR, "token"));
    if (!existsSync(tokenFile) || readFileSync(tokenFile, "utf8").trim().length < 32) {
      writePrivate(tokenFile, randomBytes(32).toString("hex") + "\n");
      say(`Generated a new token in ${tokenFile}`);
    }
    chmodSync(tokenFile, 0o600);

    for (const t of tunnels) {
      say(`\nChecking that this Mac can log in to ${t.ssh} without prompts (the service runs in the background)...`);
      const err = await checkSsh(t.ssh, rl && withTerminal);
      if (err) {
        say(`Login to ${t.ssh} failed: ${err}\nThe tunnel needs key login without prompts: use an SSH key, and if it has a passphrase, store it in the Keychain (UseKeychain yes and AddKeysToAgent yes in ~/.ssh/config). Then run setup again.`);
        continue;
      }
      say("Login OK.");
      const mac = macName();
      if (await confirm(`Copy the token to ${t.ssh} now (~/.config/${NAME}/${mac}.token there)?`)) {
        const r = await sshWrite(t.ssh, `umask 077; mkdir -p ~/.config/${NAME}; cat > ~/.config/${NAME}/${mac}.token`, readFileSync(tokenFile));
        say(r ? `Copying failed: ${r}` : "Token copied.");
      }
    }

    Object.assign(cfg, { host, port, tokenFile, allowApps: allow });
    if (tunnels.length) cfg.tunnels = tunnels;
    else delete cfg.tunnels;
    cfg.idleMinutes ??= 30;
    cfg.maxSessions ??= 4;
    cfg.engineIdleMinutes ??= 10;
    writePrivate(file, JSON.stringify(cfg, null, 2) + "\n");
    say(`Wrote ${file}`);

    say("\nChecking the engine (this needs the Computer Use permissions granted in ChatGPT)...");
    const probe = await probeEngine();
    say(probe.ok ? `Engine OK: ${probe.detail}` : `Engine check failed: ${probe.detail}\nOpen ChatGPT, finish Computer Use setup in Codex, and run setup again.`);

    const brew = brewPath();
    const managed = brew && (await run(brew, ["list", "--formula", NAME])).ok;
    if (opts.service && managed) {
      say("\nStarting the Homebrew service...");
      const r = await run(brew, ["services", "restart", NAME], 60_000);
      if (!r.ok) say(r.stderr.trim() || r.stdout.trim());
    } else if (opts.service) {
      say(`\nNot installed through Homebrew; run "${NAME} serve" under your own supervisor.`);
    }
    const h = opts.service && managed ? await health(host, port, 15_000) : await health(host, port);
    say(h ? `Listening on http://${host}:${port}/mcp (version ${h.version})` : `Not answering on http://${host}:${port} yet; see "${NAME} status".`);
    if (h && tunnels.length) {
      let states = [];
      for (let i = 0; i < 25; i++) {
        states = (await health(host, port, 0, tokenFile))?.tunnels ?? [];
        if (states.length && states.every((s) => s.up)) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      for (const s of states) say(s.up ? `Tunnel to ${s.ssh} is up: port ${s.remotePort} there reaches this server.` : `Tunnel to ${s.ssh} is not up yet: ${s.error}. It keeps retrying; see "${NAME} status".`);
    }
    clientHelp(cfg);
  } finally {
    rl?.close();
  }
}

const lastLine = (s) => s.trim().split("\n").filter((l) => l.trim() && !l.startsWith("debug")).at(-1) ?? "";
const SSH_CHECK_OPTS = ["-o", "ConnectTimeout=15", "-o", "RemoteCommand=none", "-o", "RequestTTY=no", "-o", "ControlMaster=no", "-o", "ControlPath=none"];

// Checks key login without prompts; if it fails and setup is interactive, connects
// once interactively first (to accept a new host key or unlock a key).
async function checkSsh(dest, withTerminal) {
  const batch = () => run("/usr/bin/ssh", ["-o", "BatchMode=yes", ...SSH_CHECK_OPTS, dest, "true"], 30_000);
  let r = await batch();
  if (!r.ok && withTerminal) {
    say(`Background login failed (${lastLine(r.stderr) || "no error"}). Connecting interactively once, e.g. to accept its host key:`);
    await withTerminal(() => new Promise((res) => spawn("/usr/bin/ssh", [...SSH_CHECK_OPTS, dest, "true"], { stdio: "inherit" }).on("exit", res)));
    r = await batch();
  }
  return r.ok ? null : lastLine(r.stderr) || `ssh exited ${r.code}`;
}

// Runs a command over SSH with data on its stdin; returns an error message or null.
function sshWrite(dest, command, data) {
  return new Promise((resolve) => {
    const p = spawn("/usr/bin/ssh", ["-o", "BatchMode=yes", ...SSH_CHECK_OPTS, dest, command], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", (e) => resolve(e.message));
    p.on("close", (code) => resolve(code === 0 ? null : lastLine(err) || `ssh exited ${code}`));
    p.stdin.end(data);
  });
}

// brew upgrade does not restart services, so this does both.
async function update() {
  const brew = brewPath();
  if (!brew || !(await run(brew, ["list", "--formula", NAME])).ok) throw new Error(`${NAME} was not installed through Homebrew`);
  const step = (args) => new Promise((resolve, reject) => {
    say(`$ brew ${args.join(" ")}`);
    spawn(brew, args, { stdio: "inherit" }).on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`brew ${args[0]} failed (${code})`))));
  });
  await step(["update", "--quiet"]);
  await step(["upgrade", NAME]);
  await step(["services", "restart", NAME]);
  const r = await run(join(dirname(brew), NAME), ["version"]);
  say(`Now running ${r.stdout.trim()}`);
}

async function status(opts) {
  const file = expand(opts.config);
  let bad = false;
  const line = (ok, s) => { if (!ok) bad = true; say(`${ok ? "ok  " : "FAIL"}  ${s}`); };
  say(`${NAME} ${VERSION}`);
  try { line(true, `engine: unified-computer-use ${loadCuaServer().version}`); } catch (e) { line(false, e.message); }
  let cfg = null;
  try {
    cfg = loadConfig({ ...opts, mode: "serve" });
    const tokenOk = existsSync(expand(cfg.tokenFile)) && readFileSync(expand(cfg.tokenFile), "utf8").trim().length >= 32;
    line(true, `config: ${file}`);
    line(tokenOk, `token: ${cfg.tokenFile}`);
    say(`      listen http://${cfg.host}:${cfg.port}/mcp; apps: ${cfg.allowApps.join(", ") || "(none)"}; engine idle stop: ${cfg.engineIdleMinutes || "off"} min`);
    for (const t of cfg.tunnels) say(`      tunnel to ${t.ssh}, port ${t.remotePort} there`);
  } catch (e) { line(false, `config: ${e.message}`); }
  const brew = brewPath();
  if (brew) {
    const r = await run(brew, ["services", "info", NAME, "--json"]);
    let info = null;
    try { info = r.ok ? JSON.parse(r.stdout)[0] : null; } catch {}
    if (info) line(info.running, `service: ${info.running ? `running (pid ${info.pid})` : info.status ?? "not running"}`);
  }
  if (existsSync(LEGACY_PLIST)) line(false, `old LaunchAgent still installed (${LEGACY.label}); run "${NAME} setup" to remove it`);
  if (cfg) {
    const h = await health(cfg.host, cfg.port, 0, cfg.tokenFile);
    line(!!h, h ? `server: answering, version ${h.version}${h.version !== VERSION ? " (restart the service to run this version)" : ""}` : `server: not answering on ${cfg.host}:${cfg.port}`);
    for (const t of h?.tunnels ?? []) line(t.up, `tunnel: ${t.ssh} port ${t.remotePort} ${t.up ? "up" : `down: ${t.error}`}`);
  }
  const probe = await probeEngine();
  line(probe.ok, `engine probe: ${probe.detail}`);
  return bad ? 1 : 0;
}

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.mode === "help") say(USAGE);
  else if (opts.mode === "version") say(VERSION);
  else if (opts.mode === "setup") { await setup(opts); process.exit(0); }
  else if (opts.mode === "status") process.exit(await status(opts));
  else if (opts.mode === "update") { await update(); process.exit(0); }
  else {
    const cfg = loadConfig(opts);
    if (opts.mode === "serve") runHttp(cfg);
    else runStdio(cfg);
  }
} catch (e) {
  log(e.message);
  process.exit(2);
}

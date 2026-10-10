// computer-use-bridge: let other MCP clients use this Mac's apps through open-computer-use
// and its browser tabs through open-browser-use, over stdio or bearer-authenticated HTTP.
//
//   computer-use-bridge setup [--host IP|tailscale|localhost] [--tunnel HOST[:PORT],...] [--port N] [--allow IDS] [--yes] [--no-service]
//   computer-use-bridge status [--config FILE]
//   computer-use-bridge stdio [--approve-all] [--config FILE]
//   computer-use-bridge serve [--config FILE]
//
// Clients get typed tools for apps and agent tabs; no client-supplied code runs on the Mac
// (eval_tab runs in the page with side effects refused), and every call is limited to the
// allowApps bundle IDs.

import { execFile, spawn } from "node:child_process";
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { endianness, homedir, hostname, networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { createInterface as createPrompt } from "node:readline/promises";

const VERSION = "0.5.0";
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const NAME = "computer-use-bridge";
const CONFIG_DIR = join(homedir(), ".config", NAME);
const DEFAULT_CONFIG = join(CONFIG_DIR, "config.json");
const DEFAULT_PORT = 47800;
// Browsers open-browser-use runs in (Brave reads Chrome's native-messaging folder); tab tools
// need one of them allowed.
const BROWSERS = ["com.brave.Browser", "com.google.Chrome"];

// Never controllable, even if listed in allowApps:
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
  stdio    speak MCP on stdin/stdout, e.g. over SSH [--approve-all]
  version  print the version

All commands take --config FILE (default ${DEFAULT_CONFIG}).`;

function parseArgs(argv) {
  let [mode, ...rest] = argv;
  if (mode === "--version" || mode === "-v") mode = "version";
  if (mode === "--help" || mode === "-h" || mode === undefined) mode = "help";
  const opts = { mode, approveAll: false, config: DEFAULT_CONFIG, yes: false, service: true };
  const value = (i) => {
    if (rest[i + 1] === undefined) throw new Error(`${rest[i]} needs a value`);
    return rest[i + 1];
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--approve-all" && mode === "stdio") opts.approveAll = true;
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
    if (cfg.approve === "all") throw new Error("serve only supports the allowlist");
    cfg.tunnels = (cfg.tunnels ?? []).map(checkTunnel);
    cfg.approve = "allowlist";
  } else {
    cfg.approve = opts.approveAll ? "all" : "allowlist";
  }
  cfg.allowApps = (cfg.allowApps ?? []).filter((id) => !HARD_DENY.has(id.toLowerCase()));
  const allowed = new Set(cfg.allowApps.map((id) => id.toLowerCase()));
  cfg.isAllowed = (id) => cfg.approve === "all" || (typeof id === "string" && allowed.has(id.toLowerCase()));
  cfg.idleMinutes ??= 30;
  cfg.maxSessions ??= 4;
  cfg.engineIdleMinutes ??= 10;
  if (cfg.engine !== undefined && cfg.engine !== "open-computer-use") {
    throw new Error(`engine "${cfg.engine}" is no longer supported: 0.5 runs only on open-computer-use; remove "engine" from ${file}`);
  }
  if (typeof cfg.engineIdleMinutes !== "number" || !(cfg.engineIdleMinutes >= 0)) throw new Error("engineIdleMinutes must be a number >= 0 (0 disables)");
  return cfg;
}

// ---------- tools ----------

const DEFAULT_MAX_WIDTH = 1280;
const DEFAULT_TREE_MAX = 20_000;

const appProp = { type: "string", description: "Bundle ID (e.g. com.brave.Browser) or app name; must be an allowed app." };
const tabProp = { type: "string", description: "Agent tab ID from open_tab or list_tabs. Give tab instead of app to act inside that tab." };
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
    description: "Press a key or combination, xdotool syntax: Return, Tab, Escape, Up, super+a (Cmd+A), shift+Tab.",
    props: { key: { type: "string" } },
    required: ["key"],
  },
  set_value: { description: "Set a settable element's value (e.g. a text field).", props: { element: elementProp, value: { type: "string" } }, required: ["element", "value"] },
  scroll: {
    description: "Scroll by pages: an app element, or in a tab an element, coordinates [x, y] or the page.",
    props: { element: elementProp, ...xyProps, direction: { type: "string", enum: ["up", "down", "left", "right"] }, pages: { type: "number", exclusiveMinimum: 0, maximum: 20 } },
    required: ["direction"],
  },
  drag: {
    description: "Drag between coordinates from the latest screenshot.",
    props: { from_x: { type: "number" }, from_y: { type: "number" }, to_x: { type: "number" }, to_y: { type: "number" } },
    required: ["from_x", "from_y", "to_x", "to_y"],
  },
  secondary_action: {
    description: "Perform an app element's listed secondary action (e.g. Raise, Copy, Increment); apps only.",
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

const TAB_TOOLS = ["list_tabs", "open_tab", "navigate_tab", "close_tab", "read_tab", "eval_tab", "tab_locator"];

const TOOL_DEFS = [
  { name: "list_apps", readOnly: true, description: "List the apps this bridge may control and whether they are running.", props: {} },
  {
    name: "release",
    description: "Release computer use when you are done for now: at the end of a task, or before waiting more than a few minutes. Detaches agent tabs (they stay open) and stops the engine; the next call restarts it.",
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
    description: "Return the accessibility tree of an app's key window or of an agent tab, with numbered elements. Element numbers are valid until the next call.",
    props: {
      app: appProp, tab: tabProp, screenshot: { type: "boolean" }, max_width: maxWidthProp,
      max_chars: { type: "integer", minimum: 0, description: `Return at most this many characters of the tree (default ${DEFAULT_TREE_MAX} unless the server sets treeMaxChars; 0 for no limit). Other tools always use the server's limit.` },
    },
  },
  { name: "screenshot", readOnly: true, description: "Screenshot of an app's key window or of an agent tab.", props: { app: appProp, tab: tabProp, max_width: maxWidthProp } },
  ...Object.entries(ACTIONS).map(([name, d]) => ({
    name,
    description: `${d.description} Returns the window's or tab's tree.`,
    props: { app: appProp, tab: tabProp, ...d.props },
    required: d.required,
  })),
  {
    name: "batch",
    description: "Run up to 25 actions in order in one call (click, type_text, press_key, set_value, scroll, drag, secondary_action, or wait with ms), then return the tree once. Stops at the first failing step. Element numbers are from the tree before the batch, so prefer coordinates or stable elements for later steps.",
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
    description: "List agent tabs (the ones you can act on) and the user's tabs (title and URL only; agents cannot act on them).",
    props: { limit: { type: "integer", minimum: 1, maximum: 1000, description: "Most user tabs to list (default 50)." } },
  },
  {
    name: "open_tab",
    description: "Open a URL in a new background tab (in the agent's tab group) and return its tab ID and tree. Never touches the user's tabs or focus.",
    props: { url: { type: "string" } },
    required: ["url"],
  },
  {
    name: "navigate_tab",
    description: "Navigate an agent tab: goto (with url), back, forward or reload.",
    props: { tab: tabProp, action: { type: "string", enum: ["goto", "back", "forward", "reload"] }, url: { type: "string" } },
    required: ["tab", "action"],
  },
  { name: "close_tab", description: "Close an agent tab.", props: { tab: tabProp }, required: ["tab"] },
  {
    name: "read_tab",
    readOnly: true,
    description: "Read an agent tab's content: the visible text of the page or of a CSS selector (format text), or its HTML (format dom).",
    props: { tab: tabProp, format: { type: "string", enum: ["text", "dom"] }, selector: { type: "string" }, max_chars: { type: "integer", minimum: 100, maximum: 200_000 } },
    required: ["tab"],
  },
  {
    name: "eval_tab",
    readOnly: true,
    description: "Evaluate a JavaScript expression in an agent tab and return the JSON result. Read-only: the browser rejects any expression with side effects (DOM writes, events, network, storage).",
    props: { tab: tabProp, expression: { type: "string" }, max_chars: { type: "integer", minimum: 100, maximum: 200_000 } },
    required: ["tab", "expression"],
  },
  {
    name: "tab_locator",
    description: "Find an element in an agent tab (css, role+name, text, label, placeholder or test_id) and click, dblclick, fill, type, press (a key), check, uncheck, select_option, or read its text or count. Good for repetitive pages where element numbers shift.",
    props: {
      tab: tabProp, ...locatorProps,
      action: { type: "string", enum: ["click", "dblclick", "fill", "type", "press", "check", "uncheck", "select_option", "text", "count"] },
      value: { type: "string", description: "Text for fill/type, key for press (e.g. Enter), option for select_option." },
    },
    required: ["tab", "action"],
  },
];

// Without an allowed browser there are no tab tools, and app tools take only app.
function toolDefs(tabs) {
  if (tabs) return TOOL_DEFS;
  return TOOL_DEFS.filter((d) => !TAB_TOOLS.includes(d.name)).map((d) => {
    const props = { ...d.props };
    delete props.tab;
    if (d.name === "scroll") {
      delete props.x;
      delete props.y;
      return { ...d, props, required: ["element", "direction"], description: "Scroll an app element by pages. Returns the window's tree." };
    }
    return { ...d, props };
  });
}

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

// ---------- open-computer-use engine ----------

// The open-computer-use command: the config's ocuCommand, else the first one on PATH, next to
// this node, or in the usual npm global bin directories (a launchd service has a short PATH).
function findOcu(cfg) {
  if (cfg.ocuCommand) return expand(cfg.ocuCommand);
  const dirs = [...(process.env.PATH ?? "").split(":"), dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".npm-global/bin")];
  return dirs.filter(Boolean).map((d) => join(d, "open-computer-use")).find((f) => existsSync(f)) ?? "open-computer-use";
}

// open-computer-use (github.com/iFurySt/open-codex-computer-use) serves Codex's nine
// native computer-use tools over MCP stdio, with no OpenAI service or login.
class OcuChild {
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

// ---------- open-browser-use: browser tabs for the open-computer-use engine ----------

// open-browser-use (github.com/iFurySt/open-browser-use) is a browser extension plus a native
// host that relays CDP for the tabs of a session. Agent tabs open in the background in the session's
// tab group of the focused window; the user's own tabs are never claimed.
const OBU_SESSION = "computer-use-bridge";
const OBU_REGISTRY = "/tmp/open-browser-use/active.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// xdotool key name -> [key, code, keyCode, text]
const CDP_KEYS = {
  Return: ["Enter", "Enter", 13, "\r"], KP_Enter: ["Enter", "NumpadEnter", 13, "\r"], Tab: ["Tab", "Tab", 9],
  Escape: ["Escape", "Escape", 27], BackSpace: ["Backspace", "Backspace", 8], Delete: ["Delete", "Delete", 46],
  space: [" ", "Space", 32, " "], Up: ["ArrowUp", "ArrowUp", 38], Down: ["ArrowDown", "ArrowDown", 40],
  Left: ["ArrowLeft", "ArrowLeft", 37], Right: ["ArrowRight", "ArrowRight", 39], Home: ["Home", "Home", 36],
  End: ["End", "End", 35], Page_Up: ["PageUp", "PageUp", 33], Page_Down: ["PageDown", "PageDown", 34],
  Insert: ["Insert", "Insert", 45],
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, [`F${i + 1}`, `F${i + 1}`, 112 + i]])),
};
const CDP_MODIFIERS = { alt: 1, option: 1, ctrl: 2, control: 2, super: 4, cmd: 4, meta: 4, shift: 8 };
// Editing shortcuts need an explicit command when sent through CDP on macOS.
const CDP_COMMANDS = { a: "selectAll", c: "copy", v: "paste", x: "cut", z: "undo" };

function cdpKey(spec) {
  const parts = spec.split("+");
  const name = parts.pop();
  let modifiers = 0;
  for (const m of parts) {
    const bit = CDP_MODIFIERS[m.toLowerCase()];
    if (!bit) throw new BadInput(`unknown modifier ${m}`);
    modifiers |= bit;
  }
  let key, code, keyCode, text;
  if (CDP_KEYS[name]) [key, code, keyCode, text] = CDP_KEYS[name];
  else if (name.length === 1) {
    const upper = name.toUpperCase();
    key = modifiers & 8 && /[a-z]/.test(name) ? upper : name;
    code = /[a-z]/i.test(name) ? `Key${upper}` : /\d/.test(name) ? `Digit${name}` : "";
    keyCode = upper.charCodeAt(0);
    text = key;
  } else throw new BadInput(`unknown key ${name}`);
  if (modifiers & (1 | 2 | 4)) text = undefined;
  const command = modifiers === 4 && CDP_COMMANDS[name.toLowerCase()];
  const redo = modifiers === (4 | 8) && name.toLowerCase() === "z";
  return { key, code, windowsVirtualKeyCode: keyCode, modifiers, text, commands: redo ? ["redo"] : command ? [command] : undefined };
}

// Finds elements for tab_locator kinds other than role; runs in the page.
const FIND_ELEMENTS = `(spec) => {
  const norm = (s) => (s ?? "").replace(/\\s+/g, " ").trim();
  const hit = (s) => spec.exact ? norm(s) === spec.q : norm(s).toLowerCase().includes(spec.q.toLowerCase());
  let out = [];
  if (spec.kind === "css") out = [...document.querySelectorAll(spec.q)];
  else if (spec.kind === "test_id") out = [...document.querySelectorAll('[data-testid="' + CSS.escape(spec.q) + '"]')];
  else {
    const all = [...document.querySelectorAll("body *")].filter((e) => !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(e.tagName));
    if (spec.kind === "placeholder") out = all.filter((e) => e.hasAttribute("placeholder") && hit(e.getAttribute("placeholder")));
    else if (spec.kind === "label") {
      for (const l of document.querySelectorAll("label")) if (l.control && hit(l.innerText)) out.push(l.control);
      for (const e of all) if (e.hasAttribute("aria-label") && hit(e.getAttribute("aria-label"))) out.push(e);
    } else if (spec.kind === "text") {
      const t = (e) => e.innerText ?? e.textContent;
      out = all.filter((e) => hit(t(e)) && ![...e.children].some((c) => hit(t(c))));
    }
  }
  return [...new Set(out)].slice(0, 50);
}`;

// Playwright key names (Enter, Control+A) as xdotool names (Return, ctrl+a).
function pwKey(k) {
  const names = { Enter: "Return", Backspace: "BackSpace", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", PageUp: "Page_Up", PageDown: "Page_Down", Space: "space", " ": "space", Control: "ctrl", Meta: "super", Alt: "alt", Shift: "shift" };
  return k.split(/\+(?!$)/).map((p) => names[p] ?? p).join("+");
}

class ObuBrowser {
  constructor(cfg, label) {
    this.cfg = cfg;
    this.label = label;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.next = 1;
    this.pending = new Map();
    this.attached = new Set();
    this.elements = new Map(); // tab -> Map(element number -> backendDOMNodeId)
    this.scales = new Map(); // tab -> CSS px per screenshot px
  }

  async connect() {
    if (this.sock) return;
    const file = expand(this.cfg.obuRegistry ?? OBU_REGISTRY);
    let reg;
    try { reg = JSON.parse(readFileSync(file, "utf8")); } catch {
      throw new Error(`open-browser-use is not connected (no ${file}); install it, add its extension to the browser, and restart the browser`);
    }
    const sock = createConnection(reg.socketPath);
    await new Promise((resolve, reject) => {
      sock.once("connect", resolve);
      sock.once("error", (e) => reject(new Error(`cannot reach open-browser-use (${e.message}); is the browser running with its extension connected?`)));
    });
    sock.on("error", () => {});
    sock.on("data", (d) => this.onData(d));
    sock.on("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("open-browser-use connection closed"));
      this.pending.clear();
      this.attached.clear();
      if (this.sock === sock) this.sock = null;
    });
    this.sock = sock;
    if (this.label !== "check") log(`[${this.label}] open-browser-use connected`);
  }

  // Frames are a 4-byte native-endian length and a JSON message.
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    const read = endianness() === "LE" ? "readUInt32LE" : "readUInt32BE";
    while (this.buf.length >= 4) {
      const n = this.buf[read](0);
      if (this.buf.length < 4 + n) break;
      let msg;
      try { msg = JSON.parse(this.buf.subarray(4, 4 + n).toString("utf8")); } catch { msg = null; }
      this.buf = this.buf.subarray(4 + n);
      const p = msg?.id !== undefined && this.pending.get(String(msg.id));
      if (!p) continue;
      this.pending.delete(String(msg.id));
      if (msg.error) p.reject(new Error(msg.error.message ?? "open-browser-use error"));
      else p.resolve(msg.result);
    }
  }

  async request(method, params = {}, timeoutMs = 20_000) {
    await this.connect();
    const id = String(this.next++);
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params: { session_id: OBU_SESSION, turn_id: OBU_SESSION, ...params } }));
    const head = Buffer.alloc(4);
    head[endianness() === "LE" ? "writeUInt32LE" : "writeUInt32BE"](body.length, 0);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`open-browser-use ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.sock.write(Buffer.concat([head, body]));
    });
  }

  async attach(tab) {
    if (this.attached.has(tab)) return;
    await this.request("attach", { tabId: tab });
    this.attached.add(tab);
    // Background tabs are unfocused; without this, focus-dependent pages and input misbehave.
    await this.request("executeCdp", { target: { tabId: tab }, method: "Emulation.setFocusEmulationEnabled", commandParams: { enabled: true } }).catch(() => {});
  }

  async cdp(tab, method, params = {}, timeoutMs = 20_000) {
    const send = async () => {
      await this.attach(tab);
      return this.request("executeCdp", { target: { tabId: tab }, method, commandParams: params, timeoutMs }, timeoutMs + 5000);
    };
    try { return await send(); } catch (e) {
      if (!/Debugger (unattached|detached|is not attached)/i.test(e.message)) throw e;
      this.attached.delete(tab);
      return send();
    }
  }

  async eval(tab, expression, opts = {}) {
    const r = await this.cdp(tab, "Runtime.evaluate", { expression, returnByValue: true, ...opts });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "evaluation failed");
    return r.result?.value;
  }

  async agentTabs() {
    return (await this.request("getTabs")).filter((t) => Number.isInteger(t.id));
  }

  async userTabs() {
    return this.request("getUserTabs");
  }

  async requireAgentTab(tab) {
    const id = Number(tab);
    if (!Number.isInteger(id) || id <= 0) throw new BadInput("tab must be a tab ID from list_tabs or open_tab");
    if (!(await this.agentTabs()).some((t) => t.id === id)) {
      throw new BadInput(`tab ${tab} is not an agent tab. Agents work only in tabs they opened with open_tab, so the user's own tabs are never touched; open the page with open_tab.`);
    }
    return id;
  }

  // The extension's default: a background tab in the focused window, in the session's tab group.
  async openTab(url) {
    const tab = (await this.request("createTab")).id;
    await this.cdp(tab, "Page.navigate", { url });
    await this.waitLoad(tab, true);
    return tab;
  }

  async waitLoad(tab, leaveBlank = false) {
    const until = Date.now() + 15_000;
    for (;;) {
      const s = await this.eval(tab, "location.href + ' ' + document.readyState").catch(() => "");
      const [href, state] = s.split(" ");
      const moved = !leaveBlank || (href && href !== "about:blank");
      if (moved && state === "complete") return;
      if (Date.now() > until) return;
      await sleep(150);
    }
  }

  // The tab's accessibility tree, numbered; the numbers map to DOM nodes until the next tree.
  async tree(tab) {
    const { nodes } = await this.cdp(tab, "Accessibility.getFullAXTree", {}, 30_000);
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const root = nodes.find((n) => !n.parentId) ?? nodes[0];
    const prop = (n, name) => n.properties?.find((p) => p.name === name)?.value?.value;
    const clip = (s, max) => (s.length > max ? `${s.slice(0, max)}…` : s);
    const lines = [];
    const map = new Map();
    let next = 0;
    const visit = (node, depth, parentName) => {
      const kids = (node.childIds ?? []).map((i) => byId.get(i)).filter(Boolean);
      const role = node.role?.value ?? "";
      const name = (node.name?.value ?? "").replace(/\s+/g, " ").trim();
      if (role === "InlineTextBox" || (role === "StaticText" && (!name || name === parentName))) return;
      if (node.ignored || (["generic", "none", "GenericContainer", "LineBreak"].includes(role) && !name)) {
        for (const k of kids) visit(k, depth, parentName);
        return;
      }
      const num = next++;
      if (node.backendDOMNodeId) map.set(num, node.backendDOMNodeId);
      const flags = ["focused", "disabled", "required"].filter((f) => prop(node, f) === true);
      const checked = prop(node, "checked");
      if (checked === true || checked === "true") flags.push("checked");
      else if (checked === "mixed") flags.push("mixed");
      const expanded = prop(node, "expanded");
      if (expanded === true) flags.push("expanded");
      else if (expanded === false) flags.push("collapsed");
      if (prop(node, "selected") === true) flags.push("selected");
      const label = role === "StaticText" ? "text" : role === "RootWebArea" ? "web area" : role;
      let line = `${"\t".repeat(depth)}${num} ${label}${flags.length ? ` (${flags.join(", ")})` : ""}${name ? ` ${clip(name, 300)}` : ""}`;
      const value = node.value?.value;
      if (value !== undefined && value !== "" && String(value) !== name) line += `, Value: ${clip(String(value), 300)}`;
      const url = role === "link" || role === "RootWebArea" ? prop(node, "url") : undefined;
      if (url) line += `, URL: ${url}`;
      lines.push(line);
      for (const k of kids) visit(k, depth + 1, name || parentName);
    };
    visit(root, 0, "");
    this.elements.set(tab, map);
    return `Browser tab: ${tab}\n${lines.join("\n")}`;
  }

  node(tab, element) {
    const id = this.elements.get(tab)?.get(int(element, "element"));
    if (!id) throw new BadInput(`element ${element} is not in tab ${tab}'s latest tree; call get_state`);
    return id;
  }

  async objectFor(tab, backendNodeId) {
    return (await this.cdp(tab, "DOM.resolveNode", { backendNodeId })).object.objectId;
  }

  async call(tab, backendNodeId, fn, args = []) {
    const objectId = await this.objectFor(tab, backendNodeId);
    const r = await this.cdp(tab, "Runtime.callFunctionOn", { objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  }

  // Viewport point (CSS px) at the middle of a node, scrolling it into view first.
  async center(tab, backendNodeId) {
    await this.cdp(tab, "DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
    try {
      const q = (await this.cdp(tab, "DOM.getBoxModel", { backendNodeId })).model.border;
      return { x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2 };
    } catch { return null; }
  }

  // Coordinates from the client's (downscaled) screenshot, in CSS px.
  point(tab, x, y) {
    const s = this.scales.get(tab) ?? 1;
    return { x: num(x, "x") * s, y: num(y, "y") * s };
  }

  async target(tab, a) {
    if (a.element !== undefined) {
      const id = this.node(tab, a.element);
      return { id, at: await this.center(tab, id) };
    }
    if (a.x !== undefined || a.y !== undefined) return { at: this.point(tab, a.x, a.y) };
    return null;
  }

  // The extension's overlay cursor, so a watching user sees where input lands. Animations
  // do not run in hidden tabs, so only wait for arrival when the tab is visible.
  async showCursor(tab, at, wait = true) {
    if (this.cfg.obuCursor === false) return;
    const visible = await this.eval(tab, "document.visibilityState === 'visible'").catch(() => false);
    await this.request("moveMouse", { tabId: tab, x: at.x, y: at.y, waitForArrival: wait && visible }, 5000).catch(() => {});
  }

  async mouse(tab, type, at, extra = {}) {
    await this.cdp(tab, "Input.dispatchMouseEvent", { type, x: at.x, y: at.y, ...extra });
  }

  async click(tab, a) {
    const t = await this.target(tab, a);
    if (!t) throw new BadInput("give element, or x and y");
    const button = a.button ?? "left";
    if (!["left", "right", "middle"].includes(button)) throw new BadInput("button must be left, right or middle");
    const count = a.count === undefined ? 1 : int(a.count, "count");
    if (!t.at) return this.call(tab, t.id, "function () { this.click(); }");
    await this.showCursor(tab, t.at);
    await this.mouse(tab, "mouseMoved", t.at);
    for (let i = 1; i <= count; i++) {
      await this.mouse(tab, "mousePressed", t.at, { button, buttons: { left: 1, right: 2, middle: 4 }[button], clickCount: i });
      await this.mouse(tab, "mouseReleased", t.at, { button, buttons: 0, clickCount: i });
    }
  }

  async key(tab, spec) {
    const k = cdpKey(spec);
    await this.cdp(tab, "Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...k });
    await this.cdp(tab, "Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, modifiers: k.modifiers });
  }

  async setValue(tab, backendNodeId, value) {
    await this.call(tab, backendNodeId, `function (v) {
  this.focus();
  if (this.isContentEditable) this.textContent = v;
  else {
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), "value");
    d && d.set ? d.set.call(this, v) : (this.value = v);
  }
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
}`, [value]);
  }

  // Scrolls in page JS: wheel events wait on frames that a background tab does not draw.
  async scroll(tab, a) {
    if (!["up", "down", "left", "right"].includes(a.direction)) throw new BadInput("direction must be up, down, left or right");
    const pages = a.pages === undefined ? 1 : num(a.pages, "pages");
    const dy = { up: -1, down: 1 }[a.direction] ?? 0;
    const dx = { left: -1, right: 1 }[a.direction] ?? 0;
    const fn = `function (dx, dy) {
  const can = (e) => e && (dy ? e.scrollHeight > e.clientHeight : e.scrollWidth > e.clientWidth) && /auto|scroll|overlay/.test(getComputedStyle(e)[dy ? "overflowY" : "overflowX"]);
  let e = this === window || this === undefined ? null : this;
  while (e && e !== document.body && e !== document.documentElement && !can(e)) e = e.parentElement;
  const target = e && can(e) ? e : document.scrollingElement;
  const box = target === document.scrollingElement ? { w: innerWidth, h: innerHeight } : { w: target.clientWidth, h: target.clientHeight };
  target.scrollBy(dx * box.w * 0.8, dy * box.h * 0.8);
}`;
    let objectId;
    if (a.element !== undefined) objectId = await this.objectFor(tab, this.node(tab, a.element));
    else if (a.x !== undefined || a.y !== undefined) {
      const p = this.point(tab, a.x, a.y);
      const r = await this.cdp(tab, "Runtime.evaluate", { expression: `document.elementFromPoint(${p.x}, ${p.y})` });
      objectId = r.result?.objectId;
    }
    if (!objectId) objectId = (await this.cdp(tab, "Runtime.evaluate", { expression: "document.documentElement" })).result.objectId;
    const r = await this.cdp(tab, "Runtime.callFunctionOn", { objectId, functionDeclaration: fn, arguments: [{ value: dx * pages }, { value: dy * pages }] });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  }

  async drag(tab, a) {
    const from = this.point(tab, a.from_x, a.from_y);
    const to = this.point(tab, a.to_x, a.to_y);
    await this.showCursor(tab, from);
    await this.mouse(tab, "mouseMoved", from);
    await this.mouse(tab, "mousePressed", from, { button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 5; i++) {
      await this.mouse(tab, "mouseMoved", { x: from.x + ((to.x - from.x) * i) / 5, y: from.y + ((to.y - from.y) * i) / 5 }, { button: "left", buttons: 1 });
    }
    await this.showCursor(tab, to);
    await this.mouse(tab, "mouseReleased", to, { button: "left", buttons: 0, clickCount: 1 });
  }

  async screenshot(tab, maxWidth) {
    const vp = (await this.cdp(tab, "Page.getLayoutMetrics")).cssLayoutViewport;
    const shot = await this.cdp(tab, "Page.captureScreenshot", { format: "jpeg", quality: 75 });
    const block = { type: "image", mimeType: "image/jpeg", data: shot.data };
    const scaled = await scaleImage(block, maxWidth);
    const sent = scaled.scale !== 1 ? maxWidth : imageWidth(Buffer.from(shot.data, "base64"));
    if (sent) this.scales.set(tab, vp.clientWidth / sent);
    return scaled;
  }

  // Elements matched by a tab_locator spec, as backend node IDs.
  async locate(tab, a) {
    const kinds = ["css", "role", "text", "label", "placeholder", "test_id"].filter((k) => a[k] !== undefined);
    if (kinds.length !== 1) throw new BadInput("give exactly one of css, role, text, label, placeholder or test_id");
    const kind = kinds[0];
    const q = str(a[kind], kind, 2000);
    if (kind === "role") {
      const doc = (await this.cdp(tab, "DOM.getDocument", { depth: 0 })).root.backendNodeId;
      const name = a.name === undefined ? undefined : str(a.name, "name", 2000);
      const r = await this.cdp(tab, "Accessibility.queryAXTree", { backendNodeId: doc, role: q, ...(name !== undefined && a.exact === true ? { accessibleName: name } : {}) });
      const want = (n) => name === undefined || a.exact === true || (n.name?.value ?? "").toLowerCase().includes(name.toLowerCase());
      return r.nodes.filter((n) => !n.ignored && n.backendDOMNodeId && want(n)).map((n) => n.backendDOMNodeId);
    }
    const r = await this.cdp(tab, "Runtime.evaluate", { expression: `(${FIND_ELEMENTS})(${J({ kind, q, exact: a.exact === true })})` });
    if (r.exceptionDetails) throw new BadInput(`locator failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    const props = await this.cdp(tab, "Runtime.getProperties", { objectId: r.result.objectId, ownProperties: true });
    const ids = [];
    for (const p of props.result.filter((p) => /^\d+$/.test(p.name)).sort((x, y) => x.name - y.name)) {
      if (p.value?.objectId) ids.push((await this.cdp(tab, "DOM.describeNode", { objectId: p.value.objectId })).node.backendNodeId);
    }
    return ids;
  }

  async detachAll() {
    for (const tab of [...this.attached]) await this.request("detach", { tabId: tab }, 5000).catch(() => {});
    this.attached.clear();
  }

  async close() {
    if (!this.sock) return;
    await this.detachAll().catch(() => {});
    this.sock?.end();
    this.sock = null;
  }
}

const OCU_ACTIONS = Object.keys(ACTIONS);

class Session {
  constructor(cfg, label) {
    this.cfg = cfg;
    this.label = label;
    this.child = null; // open-computer-use, for apps
    this.obu = null; // open-browser-use, for tabs
    this.starting = null;
    this.appNames = null;
    this.lastUsed = Date.now();
    this.scales = new Map();
    this.busy = 0;
    this.notice = null;
    this.tabsOn = BROWSERS.some((id) => cfg.isAllowed(id));
    this.tools = toolDefs(this.tabsOn).filter((t) => t.name !== "eval_tab" || cfg.tabEval !== false).map(toolSchema);
    // The engine holds screen capture and tab attachments while it runs, so it is
    // stopped when idle; the MCP session stays open and restarts it on demand.
    const idleMs = cfg.engineIdleMinutes * 60_000;
    if (idleMs > 0) {
      this.reaper = setInterval(() => {
        if ((this.child || this.obu) && !this.busy && Date.now() - this.lastUsed >= idleMs) this.stopEngine("idle");
      }, Math.min(30_000, idleMs)).unref();
    }
  }

  async cua() {
    if (this.child && !this.child.dead) return this.child;
    this.starting ??= (async () => {
      const c = new OcuChild(this.cfg, this.label);
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

  browser() {
    this.obu ??= new ObuBrowser(this.cfg, this.label);
    return this.obu;
  }

  // Detaches agent tabs (they stay open) and stops open-computer-use; the next call restarts them.
  async stopEngine(why) {
    const c = this.child;
    const b = this.obu;
    if (!c && !b) return false;
    this.child = null;
    this.obu = null;
    this.stopReason = why;
    log(`[${this.label}] stopping engine (${why})`);
    await Promise.allSettled([c?.close(), b?.close()]);
    return true;
  }

  close() {
    clearInterval(this.reaper);
    return Promise.allSettled([this.child?.close(), this.obu?.close()]);
  }

  listTools() {
    return this.tools;
  }

  async callTool(name, args = {}) {
    this.lastUsed = Date.now();
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

  instructions() {
    return `Computer use on the Mac "${hostname()}". Allowed apps: ${this.cfg.allowApps.join(", ") || "(none)"}. ` +
      "Call get_state(app) first; element numbers refer to the latest tree and change after every call. Actions return the window's tree. " +
      "Reading an app whose window is minimized or on another Space brings it forward, so prefer apps the user has on screen. " +
      (this.tabsOn
        ? "For web pages, use tabs: open_tab opens a background tab in the agent's tab group; pass its tab ID instead of app to get_state, screenshot, batch and the actions; read_tab, eval_tab and tab_locator work on tabs. You can act only on tabs you opened; the user's tabs are listed but off limits. "
        : "There are no browser-tab tools. ") +
      "Use batch to run several actions in one call. Screenshots come only from screenshot or get_state with screenshot: true; coordinates you give refer to the image you received. " +
      "Call release when you finish with computer use. Input goes to the target without moving the user's cursor, but the user may be using the same window. " +
      "Ask the user before sending messages, submitting forms, purchasing, or transmitting sensitive data.";
  }

  // [{ id, displayName, isRunning }] from lines like "Discord — com.hnc.Discord [running, ...]".
  async apps() {
    if (this.appNames && this.child) return this.appNames;
    const r = await (await this.cua()).call("list_apps", {});
    const text = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    this.appNames = text.split("\n").map((l) => /^(.*) — (\S+) \[(.*)\]$/.exec(l.trim())).filter(Boolean)
      .map(([, displayName, id, flags]) => ({ id, displayName, isRunning: /\brunning\b/.test(flags) }));
    return this.appNames;
  }

  async resolveApp(app) {
    str(app, "app", 200);
    if (this.cfg.isAllowed(app)) return app;
    // An exact name, else the only app whose name starts with it ("Brave" for "Brave Browser").
    const apps = await this.apps();
    const want = app.toLowerCase();
    const starts = apps.filter((x) => x.displayName.toLowerCase().startsWith(want));
    const id = (apps.find((x) => x.displayName.toLowerCase() === want) ?? (starts.length === 1 ? starts[0] : null))?.id ?? app;
    if (this.cfg.isAllowed(id)) return id;
    throw new BadInput(`app not allowed: ${app}${id !== app ? ` (${id})` : ""}. Allowed: ${this.cfg.allowApps.join(", ")}`);
  }

  async tabAction(b, tab, name, a) {
    switch (name) {
      case "click": return b.click(tab, a);
      case "type_text": return b.cdp(tab, "Input.insertText", { text: str(a.text, "text") });
      case "press_key":
        if (!/^[A-Za-z0-9_+\-]{1,40}$/.test(a.key ?? "")) throw new BadInput("key must look like Return, super+a or KP_0");
        return b.key(tab, a.key);
      case "set_value": return b.setValue(tab, b.node(tab, a.element), str(a.value, "value"));
      case "scroll": return b.scroll(tab, a);
      case "drag": return b.drag(tab, a);
      case "secondary_action": throw new BadInput("secondary_action works on apps only; in a tab use click or tab_locator");
      default: throw new BadInput(`unknown action ${name}`);
    }
  }

  // Browser tabs through open-browser-use; only agent tabs can be read or changed.
  async callTab(name, a, { cap, maxWidth }) {
    const b = this.browser();
    const out = async (tab, head = "", { image = false, isError = false } = {}) => {
      await sleep(300);
      const res = await this.shape({ content: [{ type: "text", text: head + await b.tree(tab) }] }, `tab:${tab}`, { cap, maxWidth });
      if (image) {
        const s = await b.screenshot(tab, maxWidth);
        res.content.push(s.block);
        if (s.scale !== 1) res.content.push({ type: "text", text: `Screenshot scaled from ${s.width} to ${maxWidth} px wide; give coordinates from this image.` });
      }
      res.isError = isError;
      return res;
    };
    const trunc = (s, max) => (s.length > max ? `${s.slice(0, max)}\n[truncated: ${s.length} characters total]` : s);
    if (name === "list_tabs") {
      const limit = a.limit === undefined ? 50 : int(a.limit, "limit");
      const agent = await b.agentTabs();
      const ids = new Set(agent.map((t) => t.id));
      const user = (await b.userTabs()).filter((t) => !ids.has(t.id)).slice(0, limit);
      const row = (t, mine) => ({ tab: String(t.id), agent: mine, title: t.title, url: t.url });
      return textResult(JSON.stringify([...agent.map((t) => row(t, true)), ...user.map((t) => row(t, false))], null, 1));
    }
    if (name === "open_tab") {
      const tab = await b.openTab(httpUrl(a.url));
      return out(tab, `Opened tab ${tab}.\n`);
    }
    if (a.tab === undefined) throw new BadInput("give tab");
    const tab = await b.requireAgentTab(str(a.tab, "tab", 64));
    switch (name) {
      case "get_state": return out(tab, "", { image: a.screenshot === true });
      case "screenshot": {
        const s = await b.screenshot(tab, maxWidth);
        const content = [s.block];
        if (s.scale !== 1) content.push({ type: "text", text: `Screenshot scaled from ${s.width} to ${maxWidth} px wide; give coordinates from this image.` });
        return { content, isError: false };
      }
      case "navigate_tab": {
        if (a.action === "goto") {
          const r = await b.cdp(tab, "Page.navigate", { url: httpUrl(a.url) });
          if (r.errorText) throw new Error(`navigation failed: ${r.errorText}`);
        } else if (a.action === "back" || a.action === "forward") {
          const h = await b.cdp(tab, "Page.getNavigationHistory");
          const entry = h.entries[h.currentIndex + (a.action === "back" ? -1 : 1)];
          if (!entry) throw new BadInput(`no page to go ${a.action} to`);
          await b.cdp(tab, "Page.navigateToHistoryEntry", { entryId: entry.id });
        } else if (a.action === "reload") await b.cdp(tab, "Page.reload");
        else throw new BadInput("action must be goto, back, forward or reload");
        await sleep(300);
        await b.waitLoad(tab);
        return out(tab, `Now at ${await b.eval(tab, "location.href")}\n`);
      }
      case "close_tab": {
        b.elements.delete(tab);
        await b.cdp(tab, "Page.close");
        b.attached.delete(tab);
        return textResult(`Closed tab ${tab}`);
      }
      case "read_tab": {
        const max = a.max_chars === undefined ? 20_000 : int(a.max_chars, "max_chars");
        const format = a.format ?? "text";
        let text;
        if (format === "dom") text = await b.eval(tab, "document.documentElement.outerHTML");
        else if (format === "text") {
          const sel = opt(a.selector, "selector", 2000);
          text = await b.eval(tab, `(() => { const e = ${sel ? `document.querySelector(${J(sel)})` : "document.body"}; return e ? e.innerText : null; })()`);
          if (text === null) throw new BadInput(`selector ${sel} matched nothing`);
        } else throw new BadInput("format must be text or dom");
        return textResult(trunc(String(text ?? ""), max));
      }
      case "eval_tab": {
        const max = a.max_chars === undefined ? 20_000 : int(a.max_chars, "max_chars");
        // throwOnSideEffect makes V8 reject anything that would change state, as in a read-only sandbox.
        const r = await b.cdp(tab, "Runtime.evaluate", { expression: str(a.expression, "expression"), returnByValue: true, throwOnSideEffect: true, timeout: 5000 });
        if (r.exceptionDetails) {
          const msg = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "evaluation failed";
          return textResult(/side-effect/i.test(msg) ? `eval_tab is read-only and this expression would have side effects (${msg.split("\n")[0]})` : msg, true);
        }
        const v = r.result?.value;
        return textResult(trunc(v === undefined ? "undefined" : JSON.stringify(v, null, 1) ?? String(v), max));
      }
      case "tab_locator": {
        const ids = await b.locate(tab, a);
        if (a.action === "count") return textResult(String(ids.length));
        if (!ids.length) throw new BadInput("no element matches the locator");
        let id = ids[0];
        if (a.nth !== undefined) {
          const n = int(a.nth, "nth");
          if (n >= ids.length) throw new BadInput(`only ${ids.length} element(s) match`);
          id = ids[n];
        } else if (ids.length > 1) throw new BadInput(`${ids.length} elements match; give nth (0-based) or a more specific locator`);
        const value = () => str(a.value, "value");
        const focus = () => b.call(tab, id, "function () { this.focus(); }");
        const press = async (n) => {
          const at = await b.center(tab, id);
          if (!at) return b.call(tab, id, n === 2 ? "function () { this.click(); this.click(); this.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); }" : "function () { this.click(); }");
          await b.showCursor(tab, at);
          await b.mouse(tab, "mouseMoved", at);
          for (let i = 1; i <= n; i++) {
            await b.mouse(tab, "mousePressed", at, { button: "left", buttons: 1, clickCount: i });
            await b.mouse(tab, "mouseReleased", at, { button: "left", buttons: 0, clickCount: i });
          }
        };
        switch (a.action) {
          case "text": return textResult(trunc(String(await b.call(tab, id, "function () { return this.innerText ?? this.textContent; }") ?? ""), 20_000));
          case "click": await press(1); break;
          case "dblclick": await press(2); break;
          case "fill": await b.setValue(tab, id, value()); break;
          case "type": await focus(); await b.cdp(tab, "Input.insertText", { text: value() }); break;
          case "press": await focus(); await b.key(tab, pwKey(value())); break;
          case "check": case "uncheck": {
            const on = await b.call(tab, id, "function () { return this.checked ?? this.getAttribute('aria-checked') === 'true'; }");
            if (on !== (a.action === "check")) await press(1);
            break;
          }
          case "select_option":
            await b.call(tab, id, `function (v) {
  const o = [...(this.options ?? [])].find((o) => o.value === v || o.label === v || o.text === v);
  if (!o) throw new Error("no option " + v);
  this.value = o.value;
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
}`, [value()]);
            break;
          default: throw new BadInput("action must be click, dblclick, fill, type, press, check, uncheck, select_option, text or count");
        }
        return out(tab);
      }
      case "batch": {
        if (!Array.isArray(a.actions) || a.actions.length < 1 || a.actions.length > 25) throw new BadInput("actions must hold 1 to 25 steps");
        for (const [i, s] of a.actions.entries()) {
          if (typeof s !== "object" || s === null) throw new BadInput(`step ${i + 1} must be an object`);
          if (s.action !== "wait" && !OCU_ACTIONS.includes(s.action)) throw new BadInput(`step ${i + 1}: unknown action ${s.action}`);
        }
        for (const [i, s] of a.actions.entries()) {
          const { action, name: actionName, ...rest } = s;
          try {
            if (action === "wait") {
              const ms = int(rest.ms ?? 500, "ms");
              if (ms > 10_000) throw new BadInput("ms must be at most 10000");
              await sleep(ms);
            } else await this.tabAction(b, tab, action, action === "secondary_action" ? { ...rest, action: actionName } : rest);
          } catch (e) {
            return out(tab, `Batch stopped at step ${i + 1} (${action}): ${e.message}\n`, { isError: true });
          }
        }
        return out(tab, "", { image: a.screenshot === true });
      }
      default:
        await this.tabAction(b, tab, name, a);
        await sleep(200);
        await b.waitLoad(tab);
        return out(tab);
    }
  }

  // The engine's tool name and arguments for one action; coordinates are mapped from the
  // client's downscaled screenshot back to the engine's.
  ocuAction(name, a, id) {
    const scale = this.scales.get(`app:${id}`) ?? 1;
    const xy = (x, y, nx, ny) => ({ [nx]: Math.round(num(x, nx) * scale), [ny]: Math.round(num(y, ny) * scale) });
    const el = (v) => String(int(v, "element"));
    switch (name) {
      case "click": {
        const args = { app: id };
        if (a.element !== undefined) args.element_index = el(a.element);
        else if (a.x !== undefined || a.y !== undefined) Object.assign(args, xy(a.x, a.y, "x", "y"));
        else throw new BadInput("give element, or x and y");
        if (a.button !== undefined) {
          if (!["left", "right", "middle"].includes(a.button)) throw new BadInput("button must be left, right or middle");
          args.mouse_button = a.button;
        }
        if (a.count !== undefined) args.click_count = int(a.count, "count");
        return ["click", args];
      }
      case "type_text": return ["type_text", { app: id, text: str(a.text, "text") }];
      case "press_key":
        if (!/^[A-Za-z0-9_+\-]{1,40}$/.test(a.key ?? "")) throw new BadInput("key must look like Return, super+t or KP_0");
        return ["press_key", { app: id, key: a.key }];
      case "set_value": return ["set_value", { app: id, element_index: el(a.element), value: str(a.value, "value") }];
      case "scroll": {
        if (a.element === undefined) throw new BadInput("this engine scrolls elements only; give element");
        if (!["up", "down", "left", "right"].includes(a.direction)) throw new BadInput("direction must be up, down, left or right");
        return ["scroll", { app: id, element_index: el(a.element), direction: a.direction, pages: a.pages === undefined ? 1 : num(a.pages, "pages") }];
      }
      case "drag": return ["drag", { app: id, ...xy(a.from_x, a.from_y, "from_x", "from_y"), ...xy(a.to_x, a.to_y, "to_x", "to_y") }];
      case "secondary_action": return ["perform_secondary_action", { app: id, element_index: el(a.element), action: str(a.action, "action", 100) }];
      default: throw new BadInput(`unknown action ${name}`);
    }
  }

  // Caps the tree (keeping the trailing focus and selection lines) and drops the screenshot
  // the engine attaches to every result, unless one was asked for.
  async shape(res, id, { cap, maxWidth, image = false, tree = true }) {
    const content = [];
    for (const c of res.content ?? []) {
      if (c.type === "image") {
        if (!image) continue;
        const scaled = await scaleImage(c, maxWidth);
        content.push(scaled.block);
        this.scales.set(`app:${id}`, scaled.scale);
        if (scaled.scale !== 1) content.push({ type: "text", text: `Screenshot scaled from ${scaled.width} to ${maxWidth} px wide; give coordinates from this image.` });
        continue;
      }
      if (c.type !== "text") {
        content.push(c);
        continue;
      }
      if (!tree && !res.isError) continue;
      let text = c.text;
      if (cap && text.length > cap) {
        const lines = text.split("\n");
        let k = lines.length;
        while (k > 0 && /^(The focused UI element|Selected text)/.test(lines[k - 1])) k--;
        const body = lines.slice(0, k).join("\n");
        const tail = lines.slice(k).join("\n");
        if (body.length > cap) {
          let cut = body.lastIndexOf("\n", cap);
          if (cut < cap * 0.8) cut = /[\uD800-\uDBFF]/.test(body[cap - 1]) ? cap - 1 : cap;
          text = `${body.slice(0, cut)}\n[Tree truncated: showing ${cut} of ${body.length} characters. Elements after this point exist but are not listed. To see them, call get_state with a larger max_chars (0 for no limit).]${tail ? `\n${tail}` : ""}`;
        }
      }
      content.push({ ...c, text });
    }
    return { content: content.length ? content : [{ type: "text", text: "ok" }], isError: !!res.isError };
  }

  async callFixed(name, a) {
    if (!this.tools.some((t) => t.name === name)) throw new BadInput(`unknown tool ${name}`);
    const maxWidth = this.maxWidth(a);
    const cap = this.treeCap(name, a);
    if (TAB_TOOLS.includes(name) || a.tab !== undefined) {
      if (!this.tabsOn) throw new BadInput("browser tabs are not available on this server");
      if (a.app !== undefined && a.tab !== undefined) throw new BadInput("give app or tab, not both");
      return this.callTab(name, a, { cap, maxWidth });
    }
    const ocu = async (tool, args, timeoutMs = 60_000) => (await this.cua()).call(tool, args, timeoutMs);
    switch (name) {
      case "release":
        return textResult(await this.stopEngine("released")
          ? "Released: agent tabs detached (they stay open) and the engine stopped. The next call restarts it."
          : "Nothing to release; the engine is not running.");
      case "list_apps": {
        const ids = this.cfg.approve === "all" ? null : this.cfg.allowApps.map((x) => x.toLowerCase());
        const apps = (await this.apps()).filter((x) => !ids || ids.includes(x.id.toLowerCase()));
        return textResult(JSON.stringify(apps, null, 1));
      }
      case "launch_app": {
        const id = await this.resolveApp(a.app);
        const byId = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(id);
        await new Promise((resolve, reject) => execFile("/usr/bin/open", ["-g", byId ? "-b" : "-a", id], (e) => (e ? reject(new BadInput(`could not launch ${id}: ${e.message}`)) : resolve())));
        return textResult(`launched ${id} in the background; call get_state to read its window`);
      }
      case "get_state": {
        const id = await this.resolveApp(a.app);
        const r = await ocu("get_app_state", { app: id, ...(cap === 0 ? { max_tree_nodes: 100_000 } : {}) });
        return this.shape(r, id, { cap, maxWidth, image: a.screenshot === true });
      }
      case "screenshot": {
        const id = await this.resolveApp(a.app);
        const r = await ocu("get_app_state", { app: id, max_tree_nodes: 1 });
        return this.shape(r, id, { cap, maxWidth, image: true, tree: false });
      }
      case "batch": {
        const id = await this.resolveApp(a.app);
        if (!Array.isArray(a.actions) || a.actions.length < 1 || a.actions.length > 25) throw new BadInput("actions must hold 1 to 25 steps");
        // Every step is checked before any runs.
        const steps = a.actions.map((s, i) => {
          if (typeof s !== "object" || s === null) throw new BadInput(`step ${i + 1} must be an object`);
          const { action, name: actionName, ...rest } = s;
          try {
            if (action === "wait") {
              const ms = int(rest.ms ?? 500, "ms");
              if (ms > 10_000) throw new BadInput("ms must be at most 10000");
              return { action, ms };
            }
            if (!OCU_ACTIONS.includes(action)) throw new BadInput(`unknown action ${action}`);
            return { action, call: this.ocuAction(action, action === "secondary_action" ? { ...rest, action: actionName } : rest, id) };
          } catch (e) {
            throw e instanceof BadInput ? new BadInput(`step ${i + 1} (${action}): ${e.message}`) : e;
          }
        });
        let last = null;
        for (const [i, s] of steps.entries()) {
          if (s.action === "wait") {
            await new Promise((r) => setTimeout(r, s.ms));
            last = null;
            continue;
          }
          last = await ocu(...s.call);
          if (last.isError) {
            const out = await this.shape(last, id, { cap, maxWidth });
            out.content.unshift({ type: "text", text: `Batch stopped at step ${i + 1} (${s.action}).` });
            return out;
          }
        }
        if (!last || a.screenshot === true) last = await ocu("get_app_state", { app: id });
        return this.shape(last, id, { cap, maxWidth, image: a.screenshot === true });
      }
      default: {
        const id = await this.resolveApp(a.app);
        return this.shape(await ocu(...this.ocuAction(name, a, id)), id, { cap, maxWidth });
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
    log(`serving on http://${cfg.host}:${cfg.port}/mcp; apps: ${cfg.allowApps.join(", ")}`);
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

// npm-installed commands run on the `node` on PATH, which a launchd service may lack.
const childEnv = () => ({ ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}` });
const run = (cmd, args, timeout = 30_000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, env: childEnv() }, (e, stdout, stderr) => resolve({ ok: !e, code: e?.code ?? 0, stdout: String(stdout), stderr: String(stderr) }));
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

const OBU_MANIFEST = join(homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.ifuryst.open_browser_use.extension.json");
const OBU_STORE = "https://chromewebstore.google.com/detail/open-browser-use/bgjoihaepiejlfjinojjfgokghnodnhd";

// What the bridge needs on this Mac: [{ ok, what, fix }].
async function prerequisites(cfg) {
  const out = [];
  const add = (ok, what, fix) => out.push({ ok, what, fix });
  const ocu = findOcu(cfg);
  if (!existsSync(ocu)) {
    add(false, "open-computer-use is not installed", "npm i -g open-computer-use, then run open-computer-use once and grant it Accessibility and Screen Recording");
  } else {
    const r = await run(ocu, ["doctor"], 30_000);
    const m = /accessibility=(\w+), screenRecording=(\w+)/.exec(r.stdout + r.stderr);
    if (!m) add(false, `open-computer-use doctor failed: ${lastLine(r.stderr || r.stdout) || `exit ${r.code}`}`, "reinstall it with npm i -g open-computer-use");
    else {
      add(m[1] === "granted" && m[2] === "granted", `open-computer-use (${ocu}): Accessibility ${m[1]}, Screen Recording ${m[2]}`,
        "run open-computer-use and grant both to Open Computer Use in System Settings > Privacy & Security");
    }
  }
  const allowed = new Set((cfg.allowApps ?? []).map((id) => id.toLowerCase()));
  if (!BROWSERS.some((id) => allowed.has(id.toLowerCase()))) {
    add(true, `browser tabs: off (allow ${BROWSERS.join(" or ")} to use them)`);
    return out;
  }
  add(existsSync(OBU_MANIFEST), `open-browser-use native host ${existsSync(OBU_MANIFEST) ? "registered" : "is not registered"}`,
    "npm i -g open-browser-use && open-browser-use install-manifest --browser chrome (also for Brave, which reads Chrome's folder)");
  const b = new ObuBrowser(cfg, "check");
  try {
    const tabs = await b.userTabs();
    add(true, `open-browser-use extension connected (${tabs.length} tabs)`);
  } catch (e) {
    add(false, `open-browser-use extension is not connected: ${e.message}`, `install the Open Browser Use extension in your browser (${OBU_STORE}), then quit and reopen the browser`);
  } finally {
    await b.close();
  }
  return out;
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
    delete cfg.engine;
    // A launchd service has a short PATH, so remember where npm put open-computer-use.
    if (!cfg.ocuCommand && !existsSync(findOcu(cfg))) {
      const r = await run(join(dirname(process.execPath), "npm"), ["prefix", "-g"], 15_000);
      const f = join(r.stdout.trim(), "bin/open-computer-use");
      if (r.ok && existsSync(f)) cfg.ocuCommand = f;
    }
    writePrivate(file, JSON.stringify(cfg, null, 2) + "\n");
    say(`Wrote ${file}`);

    say("\nChecking open-computer-use and open-browser-use...");
    for (const c of await prerequisites(cfg)) say(c.ok ? `  ok    ${c.what}` : `  FAIL  ${c.what}\n        fix: ${c.fix}`);

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
  for (const c of await prerequisites(cfg ?? {})) {
    line(c.ok, c.what);
    if (!c.ok) say(`      fix: ${c.fix}`);
  }
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

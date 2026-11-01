import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { childEnv, expand, lastLine, log } from "../common.mjs";
import { BadInput } from "../tools.mjs";

// ---------- agent-desktop engine ----------

export const AD_ENGINE = "agent-desktop";

export function findAd(cfg) {
  if (cfg.adCommand) return expand(cfg.adCommand);
  const dirs = [...(process.env.PATH ?? "").split(":"), dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".npm-global/bin")];
  return dirs.filter(Boolean).map((d) => join(d, AD_ENGINE)).find((f) => existsSync(f)) ?? AD_ENGINE;
}

// xdotool key names (the press_key syntax) to agent-desktop's.
export const AD_MODS = { super: "cmd", cmd: "cmd", command: "cmd", meta: "cmd", ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", shift: "shift" };
export const AD_KEYS = {
  return: "return", kp_enter: "return", enter: "return", escape: "escape", tab: "tab", space: "space",
  backspace: "delete", delete: "forwarddelete", up: "up", down: "down", left: "left", right: "right",
  home: "home", end: "end", page_up: "pageup", prior: "pageup", page_down: "pagedown", next: "pagedown",
};
export function adKey(spec) {
  const parts = spec.split("+");
  const key = parts.pop();
  const mods = parts.map((m) => {
    const v = AD_MODS[m.toLowerCase()];
    if (!v) throw new BadInput(`unknown modifier ${m}`);
    return v;
  });
  const k = AD_KEYS[key.toLowerCase()] ?? (/^F\d{1,2}$/i.test(key) ? key.toLowerCase() : /^KP_\d$/.test(key) ? key.slice(3) : key.length === 1 ? key : key.toLowerCase());
  return [...mods, k].join("+");
}

// Secondary action names (as listed in the tree) to agent-desktop commands that take only a ref.
export const AD_SECONDARY = {
  expand: "expand", collapse: "collapse", toggle: "toggle", check: "check", uncheck: "uncheck", focus: "focus",
  "scroll-to": "scroll-to", scrollto: "scroll-to", "scroll to visible": "scroll-to", scrolltovisible: "scroll-to",
  "right-click": "right-click", showmenu: "right-click", "show menu": "right-click", clear: "clear",
};

// agent-desktop's snapshot JSON as an open-computer-use style tree: numbered elements (the ones with
// refs), one per line, indented by depth, and a closing focus line. Returns the text and the refs.
export function adTree(data) {
  const refs = [];
  const lines = [`App: ${data.app}${data.window?.title ? ` — window "${data.window.title}"` : ""}`];
  let focused = null;
  const one = (s, max = 2000) => {
    const t = String(s).replace(/\s*\n\s*/g, " ⏎ ");
    return t.length > max ? `${t.slice(0, max)}…` : t;
  };
  const walk = (n, depth) => {
    let num = null;
    if (n.ref_id) {
      num = refs.length;
      refs.push(n.ref_id);
    }
    const states = (n.states ?? []).filter((s) => !["enabled", "visible", "focusable"].includes(s));
    if (num !== null && (n.states ?? []).includes("focused")) focused = num;
    const actions = (n.available_actions ?? []).filter((x) => x.toLowerCase() !== "click");
    let line = `${"\t".repeat(depth)}${num !== null ? `${num} ` : ""}${n.role}`;
    if (states.length) line += ` (${states.join(", ")})`;
    if (n.name) line += ` ${one(n.name)}`;
    if (n.value !== undefined && n.value !== null && n.value !== "" && n.value !== n.name) line += `, Value: ${one(n.value)}`;
    if (n.description && n.description !== n.name) line += `, Description: ${one(n.description, 500)}`;
    if (num !== null && actions.length) line += `, Secondary Actions: ${actions.join(", ")}`;
    if (n.children_count) line += ` [${n.children_count} children not shown]`;
    else if (n.subtree_truncated) line += " [more not shown]";
    lines.push(line);
    for (const c of n.children ?? []) walk(c, depth + 1);
  };
  if (data.tree) walk(data.tree, 0);
  if (data.complete === false) lines.push("[Partial tree: the app was slow to answer; call get_state again for more.]");
  if (focused !== null) lines.push(`The focused UI element is ${focused}.`);
  return { text: lines.join("\n"), refs, focused, window: data.window?.id ?? null };
}

// agent-desktop finds windows by what is on screen: one on another desktop (Space) is invisible to it.
const AD_HINTS = {
  WINDOW_NOT_FOUND: "agent-desktop sees only windows on the current desktop (Space) and minimized ones: bring the window to the desktop in use, or route this app to open-computer-use (apps.engineFor in the config)",
};
export class AdError extends Error {
  constructor(e) {
    const hint = AD_HINTS[e.code] && !/^No window with id|was not found$/.test(e.message ?? "") ? AD_HINTS[e.code] : e.suggestion;
    super(`${e.code ?? "ERROR"}: ${e.message ?? "agent-desktop failed"}${hint ? ` (${hint})` : ""}`);
    this.code = e.code;
  }
}

// agent-desktop (github.com/vercel-labs/agent-desktop) reads and operates apps through the
// accessibility tree, headless, with refs that belong to one snapshot. This adapter answers
// open-computer-use's tool calls, so clients see the same tools: element numbers map to the refs
// of the latest tree, and each action returns a fresh tree.
export class AdEngine {
  constructor(cfg, label) {
    this.cfg = cfg;
    this.label = label;
    this.dead = false;
    this.adSession = `cub-${randomUUID().slice(0, 8)}`;
    this.trees = new Map(); // app id -> { refs, focused } of the latest tree the client saw
    this.stale = new Set(); // app ids acted on since that tree (quiet batch steps)
    this.windows = new Map(); // app id -> window id for screenshots taken without a tree
    this.names = new Map(); // bundle id (lowercase) -> display name
    this.queue = Promise.resolve();
  }

  // One envelope per command; resolves to data, throws AdError on an error envelope.
  run(args, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      execFile(findAd(this.cfg), ["--session", this.adSession, ...args], { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, env: childEnv() }, (e, stdout, stderr) => {
        if (e?.code === "ENOENT") return reject(new Error(`agent-desktop not found; install it with "npm i -g agent-desktop" or set adCommand in the config`));
        let env = null;
        try { env = JSON.parse(String(stdout).trim().split("\n").pop()); } catch {}
        if (env?.ok) return resolve(env.data ?? {});
        if (env?.error) return reject(new AdError(env.error));
        reject(new Error(`agent-desktop ${args[0]} failed: ${lastLine(String(stderr)) || e?.message || "no output"}`));
      });
    });
  }

  async start() {
    const v = await this.run(["version"], 15_000);
    log(`[${this.label}] agent-desktop ${v.version ?? ""} ready (session ${this.adSession})`);
  }

  async listApps() {
    const d = await this.run(["list-apps"]);
    const apps = (d.apps ?? []).filter((x) => x.bundle_id && x.presentation !== undefined);
    this.names = new Map(apps.map((x) => [x.bundle_id.toLowerCase(), x.name]));
    return apps;
  }

  async appName(id) {
    if (!this.names.has(id.toLowerCase())) await this.listApps();
    const name = this.names.get(id.toLowerCase());
    if (!name) throw new BadInput(`${id} is not running; start it with launch_app`);
    return name;
  }

  ref(id, el) {
    const n = Number(el);
    const ref = this.trees.get(id)?.refs[n];
    if (ref === undefined) throw new BadInput(`element ${el} is not in the latest tree of ${id}; call get_state`);
    return ref;
  }

  async read(id) {
    return adTree(await this.run(["snapshot", "--app", await this.appName(id), "--compact", "--max-depth", String(this.cfg.adMaxDepth ?? 30), "--timeout-ms", String(this.cfg.adTimeoutMs ?? 15_000)]));
  }

  // Reads the tree the client will see; its element numbers replace the old ones.
  async snapshot(id) {
    const t = await this.read(id);
    this.trees.set(id, t);
    this.stale.delete(id);
    return t.text;
  }

  // The window of the latest tree (an app can have several, some off screen); read afresh when
  // there is none, or that window has gone.
  async image(id) {
    const shot = async (win) => this.run(["screenshot", "--app", await this.appName(id), "--window-id", String(win)]);
    let win = this.trees.get(id)?.window ?? this.windows.get(id);
    let d;
    try {
      if (!win) throw new AdError({ code: "WINDOW_NOT_FOUND", message: "No window with id" });
      d = await shot(win);
    } catch (e) {
      if (!(e instanceof AdError) || e.code !== "WINDOW_NOT_FOUND") throw e;
      win = (await this.read(id)).window;
      if (!win) throw new AdError({ code: "WINDOW_NOT_FOUND", message: `no window of ${id} to capture` });
      this.windows.set(id, win);
      d = await shot(win);
    }
    return { type: "image", mimeType: `image/${d.format ?? "png"}`, data: d.data };
  }

  // The agent-desktop command line for one open-computer-use action.
  async command(name, a) {
    const id = a.app;
    switch (name) {
      case "click":
        if (a.element_index === undefined) throw new BadInput("the agent-desktop engine clicks elements only (coordinates need physical input); give element");
        if ((a.click_count ?? 1) > 1) throw new BadInput("the agent-desktop engine cannot double-click (it needs physical input)");
        if (a.mouse_button === "middle") throw new BadInput("the agent-desktop engine cannot middle-click");
        return [a.mouse_button === "right" ? "right-click" : "click", this.ref(id, a.element_index)];
      case "type_text": {
        // After a quiet batch step (e.g. a click into another field) the client's tree predates the
        // focus change, so read focus afresh, without replacing the numbers later steps use.
        const t = this.stale.has(id) ? await this.read(id) : this.trees.get(id);
        if (t?.focused === null || t?.focused === undefined) throw new BadInput("the agent-desktop engine types into the focused element, and the app has none; click a text field first, or use set_value");
        return ["type", t.refs[t.focused], a.text];
      }
      case "press_key": return ["press", adKey(a.key), "--app", await this.appName(id)];
      case "set_value": return ["set-value", this.ref(id, a.element_index), a.value];
      case "scroll": return ["scroll", this.ref(id, a.element_index), "--direction", a.direction, "--amount", String(Math.max(1, Math.round(a.pages * 3)))];
      case "perform_secondary_action": {
        const cmd = AD_SECONDARY[a.action.toLowerCase()] ?? AD_SECONDARY[a.action.toLowerCase().replace(/^ax/, "")];
        if (!cmd) throw new BadInput(`the agent-desktop engine supports these secondary actions: ${[...new Set(Object.values(AD_SECONDARY))].join(", ")}`);
        return [cmd, this.ref(id, a.element_index)];
      }
      case "drag": throw new BadInput("the agent-desktop engine cannot drag (it needs physical input)");
      default: throw new BadInput(`unknown action ${name}`);
    }
  }

  // open-computer-use's tool calls. opts.image adds a screenshot; opts.quiet skips the tree after an
  // action (batch steps before the last), so element numbers stay those of the tree the client saw.
  call(name, args, timeoutMs, opts = {}) {
    const run = () => this.callOne(name, args, opts).catch((e) => {
      if (e instanceof AdError) return { content: [{ type: "text", text: e.message }], isError: true };
      throw e;
    });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async callOne(name, a, opts) {
    if (name === "list_apps") {
      const apps = await this.listApps();
      return { content: [{ type: "text", text: apps.map((x) => `${x.name} — ${x.bundle_id} [running]`).join("\n") }] };
    }
    if (name === "get_app_state") {
      const content = [];
      if (a.max_tree_nodes !== 1) content.push({ type: "text", text: await this.snapshot(a.app) });
      if (opts.image || a.max_tree_nodes === 1) content.push(await this.image(a.app));
      return { content };
    }
    const d = await this.run(await this.command(name, a));
    let text = `${name}: ${d.disposition?.delivery ?? "done"}${d.surfaces?.length ? `; open: ${d.surfaces.map((s) => s.kind ?? s.surface ?? s).join(", ")}` : ""}`;
    if (opts.quiet) this.stale.add(a.app);
    else text += `\n${await this.snapshot(a.app)}`;
    const content = [{ type: "text", text }];
    if (opts.image && !opts.quiet) content.push(await this.image(a.app));
    return { content };
  }

  async close() {
    if (this.dead) return;
    this.dead = true;
    await new Promise((r) => execFile(findAd(this.cfg), ["session", "end", this.adSession], { timeout: 10_000, env: childEnv() }, () => r()));
  }
}


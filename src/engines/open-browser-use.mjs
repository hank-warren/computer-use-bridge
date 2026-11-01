import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { endianness } from "node:os";
import { dirname, join } from "node:path";
import { J, expand, log, sleep } from "../common.mjs";
import { BadInput, imageWidth, int, num, str } from "../tools.mjs";

// ---------- open-browser-use: browser tabs for the open-computer-use engine ----------

// open-browser-use (github.com/iFurySt/open-browser-use) is a browser extension plus a native
// host that relays CDP for the tabs of a session. Agent tabs open in the background in the session's
// tab group of the focused window; the user's own tabs are never claimed. Each bridge session has its
// own open-browser-use session, so agents cannot see or act on each other's tabs.
export const OBU_SESSION = "computer-use-bridge";
export const OBU_REGISTRY = "/tmp/open-browser-use/active.json";

export function dialSocket(path, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(path);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("timed out")); }, timeoutMs);
    sock.once("connect", () => { clearTimeout(timer); resolve(sock); });
    sock.once("error", (e) => { clearTimeout(timer); sock.destroy(); reject(e); });
  });
}

// Connects to the open-browser-use native host: obuSocket if set, else the socket active.json
// names, else the only live socket beside it. macOS's nightly tmp_cleaner deletes active.json
// three days after the host wrote it while the host keeps listening, so the registry can vanish.
// Several live sockets mean several browsers; refuse to guess which one the agent should drive.
export async function findObuSocket(cfg) {
  if (cfg.obuSocket) {
    const path = expand(cfg.obuSocket);
    try { return { sock: await dialSocket(path), path, how: "obuSocket" }; } catch (e) {
      throw new Error(`cannot reach open-browser-use at obuSocket ${path} (${e.message}); is the browser running with its extension connected?`);
    }
  }
  const file = expand(cfg.obuRegistry ?? OBU_REGISTRY);
  let registered = null;
  let why = `no ${file}`;
  try { registered = JSON.parse(readFileSync(file, "utf8")).socketPath ?? null; } catch {}
  if (registered) {
    try { return { sock: await dialSocket(registered), path: registered, how: "registry" }; } catch (e) {
      why = `${file} names ${registered}, which is unreachable (${e.message})`;
    }
  } else if (existsSync(file)) why = `${file} is unreadable or has no socketPath`;
  const dir = dirname(file);
  let paths = [];
  try { paths = readdirSync(dir).filter((n) => n.endsWith(".sock")).map((n) => join(dir, n)).filter((p) => p !== registered); } catch {}
  const live = (await Promise.all(paths.map((path) => dialSocket(path).then((sock) => ({ sock, path }), () => null)))).filter(Boolean);
  if (live.length === 1) return { ...live[0], how: "scan", why };
  for (const l of live) l.sock.destroy();
  if (live.length) {
    throw new Error(`open-browser-use registry is unusable (${why}) and ${live.length} browsers are listening (${live.map((l) => l.path).join(", ")}); set obuSocket in the config to choose one`);
  }
  throw new Error(`open-browser-use is not connected (${why}; no live socket in ${dir}); install it, enable its extension in the browser, or quit and reopen the browser`);
}

// xdotool key name -> [key, code, keyCode, text]
export const CDP_KEYS = {
  Return: ["Enter", "Enter", 13, "\r"], KP_Enter: ["Enter", "NumpadEnter", 13, "\r"], Tab: ["Tab", "Tab", 9],
  Escape: ["Escape", "Escape", 27], BackSpace: ["Backspace", "Backspace", 8], Delete: ["Delete", "Delete", 46],
  space: [" ", "Space", 32, " "], Up: ["ArrowUp", "ArrowUp", 38], Down: ["ArrowDown", "ArrowDown", 40],
  Left: ["ArrowLeft", "ArrowLeft", 37], Right: ["ArrowRight", "ArrowRight", 39], Home: ["Home", "Home", 36],
  End: ["End", "End", 35], Page_Up: ["PageUp", "PageUp", 33], Page_Down: ["PageDown", "PageDown", 34],
  Insert: ["Insert", "Insert", 45],
  // Modifiers on their own, e.g. to hold Shift in a game.
  shift: ["Shift", "ShiftLeft", 16, undefined, 8], Shift_L: ["Shift", "ShiftLeft", 16, undefined, 8], Shift_R: ["Shift", "ShiftRight", 16, undefined, 8],
  ctrl: ["Control", "ControlLeft", 17, undefined, 2], Control_L: ["Control", "ControlLeft", 17, undefined, 2], Control_R: ["Control", "ControlRight", 17, undefined, 2],
  alt: ["Alt", "AltLeft", 18, undefined, 1], Alt_L: ["Alt", "AltLeft", 18, undefined, 1], Alt_R: ["Alt", "AltRight", 18, undefined, 1],
  super: ["Meta", "MetaLeft", 91, undefined, 4], Super_L: ["Meta", "MetaLeft", 91, undefined, 4], Super_R: ["Meta", "MetaRight", 92, undefined, 4],
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, [`F${i + 1}`, `F${i + 1}`, 112 + i]])),
};
export const CDP_MODIFIERS = { alt: 1, option: 1, ctrl: 2, control: 2, super: 4, cmd: 4, meta: 4, shift: 8 };
// Editing shortcuts need an explicit command when sent through CDP on macOS.
export const CDP_COMMANDS = { a: "selectAll", c: "copy", v: "paste", x: "cut", z: "undo" };

export function cdpKey(spec) {
  const parts = spec.split("+");
  const name = parts.pop();
  let modifiers = 0;
  for (const m of parts) {
    const bit = CDP_MODIFIERS[m.toLowerCase()];
    if (!bit) throw new BadInput(`unknown modifier ${m}`);
    modifiers |= bit;
  }
  let key, code, keyCode, text, own;
  if (CDP_KEYS[name]) [key, code, keyCode, text, own] = CDP_KEYS[name];
  else if (name.length === 1) {
    const upper = name.toUpperCase();
    key = modifiers & 8 && /[a-z]/.test(name) ? upper : name;
    code = /[a-z]/i.test(name) ? `Key${upper}` : /\d/.test(name) ? `Digit${name}` : "";
    keyCode = upper.charCodeAt(0);
    text = key;
  } else throw new BadInput(`unknown key ${name}`);
  modifiers |= own ?? 0;
  if (modifiers & (1 | 2 | 4)) text = undefined;
  const command = modifiers === 4 && CDP_COMMANDS[name.toLowerCase()];
  const redo = modifiers === (4 | 8) && name.toLowerCase() === "z";
  return { key, code, windowsVirtualKeyCode: keyCode, modifiers, text, commands: redo ? ["redo"] : command ? [command] : undefined };
}

// Finds elements for tab_locator kinds other than role; runs in the page.
export const FIND_ELEMENTS = `(spec) => {
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
export function pwKey(k) {
  const names = { Enter: "Return", Backspace: "BackSpace", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", PageUp: "Page_Up", PageDown: "Page_Down", Space: "space", " ": "space", Control: "ctrl", Meta: "super", Alt: "alt", Shift: "shift" };
  return k.split(/\+(?!$)/).map((p) => names[p] ?? p).join("+");
}

export class ObuBrowser {
  // session: { id, name } of the open-browser-use session; name titles its tab group.
  constructor(cfg, label, session = { id: OBU_SESSION }) {
    this.cfg = cfg;
    this.label = label;
    this.session = session;
    this.named = !session.name;
    this.sock = null;
    this.scanned = null; // why the registry was bypassed, when the socket came from a scan
    this.buf = Buffer.alloc(0);
    this.next = 1;
    this.pending = new Map();
    this.attached = new Set();
    this.elements = new Map(); // tab -> Map(element number -> backendDOMNodeId)
    this.held = new Map(); // tab -> Map(key code -> keyUp event) for keys held down
    this.scales = new Map(); // tab -> CSS px per screenshot px
  }

  async connect() {
    if (this.sock) return;
    const { sock, path, how, why } = await findObuSocket(this.cfg);
    this.scanned = how === "scan" ? `${why}; using ${path}` : null;
    if (this.scanned && this.label !== "check") log(`[${this.label}] open-browser-use registry unusable (${why}); found ${path} by scanning`);
    sock.on("error", () => {});
    sock.on("data", (d) => this.onData(d));
    sock.on("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("open-browser-use connection closed"));
      this.pending.clear();
      this.attached.clear();
      this.held.clear();
      if (this.sock === sock) this.sock = null;
    });
    this.sock = sock;
    if (this.label !== "check") log(`[${this.label}] open-browser-use connected (session ${this.session.id})`);
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
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params: { session_id: this.session.id, turn_id: this.session.id, ...params } }));
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
    if (!this.named) {
      await this.request("nameSession", { name: this.session.name }).catch(() => {});
      this.named = true;
    }
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

  // hold: "down" leaves the key pressed until "up" or releaseKeys; otherwise press and release.
  async key(tab, spec, hold) {
    const k = cdpKey(spec);
    const up = { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, modifiers: k.modifiers };
    const id = k.code || k.key;
    if (hold !== "up") await this.cdp(tab, "Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...k });
    if (hold === "down") {
      if (!this.held.has(tab)) this.held.set(tab, new Map());
      this.held.get(tab).set(id, up);
      return;
    }
    await this.cdp(tab, "Input.dispatchKeyEvent", up);
    this.held.get(tab)?.delete(id);
  }

  async releaseKeys() {
    for (const [tab, keys] of this.held) {
      for (const up of keys.values()) await this.cdp(tab, "Input.dispatchKeyEvent", up).catch(() => {});
    }
    this.held.clear();
  }

  async setValue(tab, backendNodeId, value) {
    await this.call(tab, backendNodeId, `function (v) {
  if (this.nodeType !== 1 || !(/^(INPUT|TEXTAREA|SELECT)$/.test(this.tagName) || this.isContentEditable || (this.tagName.includes("-") && "value" in this))) throw new Error("not a field");
  this.focus();
  if (this.isContentEditable) this.textContent = v;
  else {
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), "value");
    d && d.set ? d.set.call(this, v) : (this.value = v);
  }
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
}`, [value]).catch((e) => {
      throw /\bError: not a field\b/.test(e.message) ? new BadInput("that element does not take a value; give a text field, text area, select or editable element") : e;
    });
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

  // The browser scales the capture itself (clip.scale), so no image tool is needed.
  async screenshot(tab, maxWidth) {
    const vp = (await this.cdp(tab, "Page.getLayoutMetrics")).cssLayoutViewport;
    const dpr = Number(await this.eval(tab, "devicePixelRatio")) || 1;
    const width = Math.round(vp.clientWidth * dpr);
    const factor = maxWidth && width > maxWidth ? maxWidth / width : 1;
    const clip = factor !== 1 ? { clip: { x: vp.pageX, y: vp.pageY, width: vp.clientWidth, height: vp.clientHeight, scale: factor } } : {};
    const shot = await this.cdp(tab, "Page.captureScreenshot", { format: "jpeg", quality: 75, ...clip });
    const block = { type: "image", mimeType: "image/jpeg", data: shot.data };
    const sent = imageWidth(Buffer.from(shot.data, "base64"));
    if (sent) this.scales.set(tab, vp.clientWidth / sent);
    return { block, scale: factor === 1 ? 1 : width / (sent ?? maxWidth), width };
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
    await this.releaseKeys();
    await this.detachAll().catch(() => {});
    this.sock?.end();
    this.sock = null;
  }
}

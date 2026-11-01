import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { J, log, sleep } from "./common.mjs";
import { ACTIONS, BadInput, DEFAULT_MAX_WIDTH, DEFAULT_TREE_MAX, TAB_TOOLS, httpUrl, int, num, opt, scaleImage, str, textResult, toolDefs, toolSchema } from "./tools.mjs";
import { OcuChild } from "./engines/open-computer-use.mjs";
import { AD_ENGINE, AdEngine } from "./engines/agent-desktop.mjs";
import { OBU_SESSION, ObuBrowser, pwKey } from "./engines/open-browser-use.mjs";

export const OCU_ACTIONS = Object.keys(ACTIONS);

export class Session {
  constructor(cfg, label) {
    this.cfg = cfg;
    this.label = label;
    this.engines = new Map(); // app engine name -> running engine (open-computer-use, agent-desktop)
    this.starting = new Map();
    this.obu = null; // open-browser-use, for tabs
    // Kept for the life of the session, so its tabs survive release and the idle stop.
    const short = randomUUID().slice(0, 8);
    this.obuSession = { id: `${OBU_SESSION}-${short}`, name: `Agent ${short}` };
    this.appNames = null;
    this.lastUsed = Date.now();
    this.scales = new Map();
    this.busy = 0;
    this.notice = null;
    this.tabsOn = !!cfg.tabsOn;
    this.appsOn = !!cfg.appsOn;
    this.tools = toolDefs(this.tabsOn, this.appsOn).filter((t) => t.name !== "eval_tab" || cfg.tabEval !== false).map(toolSchema);
    // The engine holds screen capture and tab attachments while it runs, so it is
    // stopped when idle; the MCP session stays open and restarts it on demand.
    const idleMs = cfg.engineIdleMinutes * 60_000;
    if (idleMs > 0) {
      this.reaper = setInterval(() => {
        if ((this.engines.size || this.obu) && !this.busy && Date.now() - this.lastUsed >= idleMs) this.stopEngine("idle");
      }, Math.min(30_000, idleMs)).unref();
    }
  }

  // The app engine for an app (its apps.engineFor entry, else apps.engine), started on first use.
  async cua(app) {
    const name = app === undefined ? this.cfg.appEngine : this.cfg.appEngineFor(app);
    const running = this.engines.get(name);
    if (running && !running.dead) return running;
    if (!this.starting.has(name)) {
      this.starting.set(name, (async () => {
        const c = name === AD_ENGINE ? new AdEngine(this.cfg, this.label) : new OcuChild(this.cfg, this.label);
        await c.start();
        this.engines.set(name, c);
        this.appNames = null;
        if (this.stopReason) {
          this.notice = `The computer-use engine was restarted (${this.stopReason}), so element numbers from earlier trees are stale; call get_state before using them.`;
          this.stopReason = null;
        }
        return c;
      })().finally(() => this.starting.delete(name)));
    }
    return this.starting.get(name);
  }

  browser() {
    this.obu ??= new ObuBrowser(this.cfg, this.label, this.obuSession);
    return this.obu;
  }

  // Detaches agent tabs (they stay open) and stops open-computer-use; the next call restarts them.
  async stopEngine(why) {
    const engines = [...this.engines.values()];
    const b = this.obu;
    if (!engines.length && !b) return false;
    this.engines.clear();
    this.obu = null;
    this.stopReason = why;
    log(`[${this.label}] stopping engine (${why})`);
    await Promise.allSettled([...engines.map((c) => c.close()), b?.close()]);
    return true;
  }

  close() {
    clearInterval(this.reaper);
    return Promise.allSettled([...[...this.engines.values()].map((c) => c.close()), this.obu?.close()]);
  }

  listTools() {
    return this.tools;
  }

  async callTool(name, args = {}) {
    this.lastUsed = Date.now();
    this.busy++;
    try {
      const res = await this.callFixed(name, args ?? {});
      if (this.notice && this.engines.size && name !== "get_state") res.content.unshift({ type: "text", text: this.notice });
      if (this.engines.size) this.notice = null;
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
    if (!this.appsOn) {
      return `Browser use on "${hostname()}" through its browser's tabs; there is no desktop app control. ` +
        "open_tab opens a background tab in your own tab group and returns its tab ID; pass that tab to get_state, screenshot, batch and the actions. " +
        "Element numbers refer to the latest tree and change after every call; actions return the tab's tree. read_tab, eval_tab and tab_locator read and act on tabs too. " +
        "You can act only on tabs you opened; the user's tabs and other agents' tabs are listed but off limits. " +
        "Use batch to run several actions in one call. Screenshots come only from screenshot or get_state with screenshot: true; coordinates you give refer to the image you received. " +
        "Call release when you finish. Ask the user before sending messages, submitting forms, purchasing, or transmitting sensitive data.";
    }
    return `Computer use on the Mac "${hostname()}". Allowed apps: ${this.cfg.allowApps.join(", ") || "(none)"}. ` +
      "Call get_state(app) first; element numbers refer to the latest tree and change after every call. Actions return the window's tree. " +
      "Reading an app whose window is minimized or on another Space brings it forward, so prefer apps the user has on screen. " +
      this.adNote() +
      (this.tabsOn
        ? "For web pages, use tabs: open_tab opens a background tab in your own tab group; pass its tab ID instead of app to get_state, screenshot, batch and the actions; read_tab, eval_tab and tab_locator work on tabs. You can act only on tabs you opened; the user's tabs and other agents' tabs are listed but off limits. "
        : "There are no browser-tab tools. ") +
      "Use batch to run several actions in one call. Screenshots come only from screenshot or get_state with screenshot: true; coordinates you give refer to the image you received. " +
      "Call release when you finish with computer use. Input goes to the target without moving the user's cursor, but the user may be using the same window. " +
      "Ask the user before sending messages, submitting forms, purchasing, or transmitting sensitive data.";
  }

  // What clients need to know about apps that run on agent-desktop.
  adNote() {
    if (!this.cfg.appEngines?.includes(AD_ENGINE)) return "";
    const which = this.cfg.appEngine === AD_ENGINE
      ? (this.cfg.appEngines.length > 1 ? `Apps run on agent-desktop except ${this.cfg.allowApps.filter((id) => this.cfg.appEngineFor(id) !== AD_ENGINE).join(", ")}` : "Apps run on agent-desktop")
      : `${this.cfg.allowApps.filter((id) => this.cfg.appEngineFor(id) === AD_ENGINE).join(", ")} run on agent-desktop`;
    return `${which}, which acts through accessibility only: click (left or right), set_value, scroll and the listed secondary actions take element numbers, type_text types into the tree's focused element, and press_key goes to the app without focusing it. There are no coordinate clicks, double clicks or drags there; screenshots are for looking only. `;
  }

  // [{ id, displayName, isRunning }] from lines like "Discord — com.hnc.Discord [running, ...]".
  async apps() {
    if (this.appNames && this.engines.has(this.cfg.appEngine)) return this.appNames;
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
        if (a.hold !== undefined && a.hold !== "down" && a.hold !== "up") throw new BadInput("hold must be down or up");
        return b.key(tab, a.key, a.hold);
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
      return out(tab, `Opened tab ${tab} in tab group "${b.session.name}".\n`);
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
        b.held.delete(tab);
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
        if (a.hold !== undefined) throw new BadInput("hold works in tabs only");
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
    if (!this.appsOn && name !== "release") throw new BadInput("this server has browser tabs only; give tab (from open_tab or list_tabs)");
    // Each call goes to the app's engine. opts are for agent-desktop (image, quiet); open-computer-use ignores them.
    const ocu = async (tool, args, timeoutMs = 60_000, opts) => (await this.cua(args.app)).call(tool, args, timeoutMs, opts);
    switch (name) {
      case "release":
        return textResult(await this.stopEngine("released")
          ? "Released: held keys let go, agent tabs detached (they stay open) and the engine stopped. The next call restarts it."
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
        const r = await ocu("get_app_state", { app: id, ...(cap === 0 ? { max_tree_nodes: 100_000 } : {}) }, 60_000, { image: a.screenshot === true });
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
          last = await ocu(...s.call, 60_000, { quiet: i < steps.length - 1 });
          if (last.isError) {
            const out = await this.shape(last, id, { cap, maxWidth });
            out.content.unshift({ type: "text", text: `Batch stopped at step ${i + 1} (${s.action}).` });
            return out;
          }
        }
        if (!last || a.screenshot === true) last = await ocu("get_app_state", { app: id }, 60_000, { image: a.screenshot === true });
        return this.shape(last, id, { cap, maxWidth, image: a.screenshot === true });
      }
      default: {
        const id = await this.resolveApp(a.app);
        return this.shape(await ocu(...this.ocuAction(name, a, id)), id, { cap, maxWidth });
      }
    }
  }
}

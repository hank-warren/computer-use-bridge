import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { NAME, log } from "./common.mjs";
import { obuChild, ocuChild } from "./engines/native.mjs";

export class BadInput extends Error {}
export const textResult = (text, isError = false) => ({ content: [{ type: "text", text }], isError });

// open-computer-use list_apps lines: "Discord — com.hnc.Discord [running, last-used=…]".
export const parseAppLine = (line) => {
  const m = /^(.*) — (\S+) \[(.*)\]$/.exec(line.trim());
  return m ? { name: m[1], id: m[2] } : null;
};

// One client session: its own open-computer-use and open-browser-use MCP servers, whose tools
// pass through unchanged. The bridge adds only the app allowlist: every open-computer-use call
// names its app, which must be allowed; list_apps shows allowed apps only.
export class Session {
  constructor(cfg, label, { start } = {}) {
    this.cfg = cfg;
    this.label = label;
    // Kept for the life of the session, so its tab group survives engine restarts.
    this.obuSession = `${NAME}-${randomUUID().slice(0, 8)}`;
    this.start = start ?? ((kind) => (kind === "apps" ? ocuChild(cfg, label) : obuChild(cfg, label, this.obuSession)).start());
    this.kinds = [...(cfg.appsOn ? ["apps"] : []), ...(cfg.tabsOn ? ["tabs"] : [])];
    this.engines = new Map(); // kind -> running McpChild
    this.starting = new Map();
    this.catalog = null; // tool name -> { kind, tool }
    this.lastUsed = Date.now();
    this.busy = 0;
    // Engines hold screen capture and tab attachments while they run, so they stop when idle;
    // the session stays open and restarts them on the next call.
    const idleMs = cfg.engineIdleMinutes * 60_000;
    if (idleMs > 0) {
      this.reaper = setInterval(() => {
        if (this.engines.size && !this.busy && Date.now() - this.lastUsed >= idleMs) this.stopEngines("idle");
      }, Math.min(30_000, idleMs)).unref();
    }
  }

  engine(kind) {
    if (this.closed) return Promise.reject(new Error("the session is closed"));
    const running = this.engines.get(kind);
    if (running && !running.dead) return Promise.resolve(running);
    if (!this.starting.has(kind)) {
      this.starting.set(kind, this.start(kind)
        .then(async (c) => {
          // Closed while it started (evicted, idle): stop it rather than leave it running.
          if (this.closed) {
            await c.close();
            throw new Error("the session is closed");
          }
          this.engines.set(kind, c);
          return c;
        })
        .finally(() => this.starting.delete(kind)));
    }
    return this.starting.get(kind);
  }

  async stopEngines(why) {
    const running = [...this.engines.values()];
    this.engines.clear();
    if (running.length) log(`[${this.label}] stopping engines (${why})`);
    await Promise.allSettled(running.map((c) => c.close()));
  }

  async close() {
    this.closed = true;
    clearInterval(this.reaper);
    await this.stopEngines("closed");
    await Promise.allSettled([...this.starting.values()]);
  }

  // The engines' tools. open-computer-use tools are offered only if they take an app, so a tool
  // added upstream that the allowlist cannot check stays hidden.
  async loadCatalog() {
    if (this.catalog) return this.catalog;
    const catalog = new Map();
    const instructions = [];
    for (const kind of this.kinds) {
      let c;
      try { c = await this.engine(kind); } catch (e) {
        log(`[${this.label}] ${kind} engine unavailable: ${e.message}`);
        instructions.push(`(${kind === "apps" ? "App control" : "Browser tabs"} unavailable: ${e.message})`);
        continue;
      }
      if (c.instructions) instructions.push(c.instructions);
      for (const tool of c.tools) {
        if (kind === "apps" && tool.name !== "list_apps" && !tool.inputSchema?.properties?.app) {
          log(`[${this.label}] hiding open-computer-use tool ${tool.name}: it takes no app to check`);
          continue;
        }
        if (catalog.has(tool.name)) {
          log(`[${this.label}] hiding ${kind} tool ${tool.name}: the name is taken`);
          continue;
        }
        catalog.set(tool.name, { kind, tool });
      }
    }
    this.instructionText = instructions.join("\n\n");
    this.catalog = catalog;
    return catalog;
  }

  async instructions() {
    await this.loadCatalog();
    const where = this.cfg.appsOn
      ? `Remote control of the Mac "${hostname()}" through computer-use-bridge. Apps you may control: ${this.cfg.allowApps.join(", ") || "(none)"}; others are refused.`
      : `Remote browser control on "${hostname()}" through computer-use-bridge; there is no app control here.`;
    return [where, this.instructionText].filter(Boolean).join("\n\n");
  }

  async listTools() {
    return [...(await this.loadCatalog()).values()].map((e) => e.tool);
  }

  // An allowed bundle ID for app (a bundle ID or an app name), else BadInput. Only a bundle ID
  // listed in apps.allow skips the lookup; anything else (and everything under --approve-all) must
  // resolve to a bundle ID through list_apps, so hard-deny is checked on the ID.
  async resolveApp(app) {
    if (typeof app !== "string" || !app.trim() || app.length > 200) throw new BadInput("app must be a bundle ID or app name");
    if (this.cfg.listed(app)) return this.cfg.canonicalId(app);
    // A bundle ID, an exact name, else the only app whose name starts with it ("Brave" for "Brave Browser").
    const apps = await this.apps();
    const want = app.trim().toLowerCase();
    const starts = apps.filter((x) => x.name.toLowerCase().startsWith(want));
    const id = (apps.find((x) => x.id.toLowerCase() === want) ?? apps.find((x) => x.name.toLowerCase() === want) ?? (starts.length === 1 ? starts[0] : null))?.id;
    if (id && this.cfg.isAllowed(id)) return this.cfg.canonicalId(id);
    throw new BadInput(`app not allowed: ${app}${id ? ` (${id})` : ""}. Allowed: ${this.cfg.allowApps.join(", ") || "(none)"}`);
  }

  async apps() {
    const r = await (await this.engine("apps")).call("list_apps", {});
    return (r?.content ?? []).filter((c) => c.type === "text").flatMap((c) => c.text.split("\n")).map(parseAppLine).filter(Boolean);
  }

  async callTool(name, args) {
    this.lastUsed = Date.now();
    this.busy++;
    try {
      const entry = (await this.loadCatalog()).get(name);
      if (!entry) throw new BadInput(`unknown tool ${name}`);
      const a = args && typeof args === "object" && !Array.isArray(args) ? args : {};
      const c = await this.engine(entry.kind);
      if (entry.kind === "tabs") return await c.call(name, a);
      if (name === "list_apps") {
        const r = await c.call(name, a);
        return { ...r, content: (r?.content ?? []).map((x) => (x.type !== "text" ? x : { ...x, text: x.text.split("\n").filter((l) => { const p = parseAppLine(l); return p && this.cfg.isAllowed(p.id); }).join("\n") || `None of the allowed apps is running or recently used. Allowed: ${this.cfg.allowApps.join(", ") || "(none)"}` })) };
      }
      return await c.call(name, { ...a, app: await this.resolveApp(a.app) });
    } catch (e) {
      if (e instanceof BadInput) return textResult(e.message, true);
      throw e;
    } finally {
      this.busy--;
      this.lastUsed = Date.now();
    }
  }
}

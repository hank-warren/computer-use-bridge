import { spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface as createPrompt } from "node:readline/promises";
import { CONFIG_DIR, DEFAULT_CONFIG, DEFAULT_PORT, HARD_DENY, NAME, VERSION, expand, lastLine, readJson, run, say, sleep, writePrivate } from "./common.mjs";
import { APP_ENGINES, BROWSER_IDS, checkTunnel, configPath, migrateConfig, normalizeConfig } from "./config.mjs";
import { ENGINES, engineCheck, extensionCheck, installedVersion, npmInstall, npmPath, OBU_STORE, obuManifestCheck, ocuOnboard, ocuPermissions, registerObuHost } from "./engines/install.mjs";
import { binScript, brewServiceInstalled, installService, linger, logHint, serviceCommand, serviceState, stopBrewService } from "./service.mjs";

// ---------- setup, status and update ----------

const MAC = process.platform === "darwin";
const OS = MAC ? "Mac" : "machine";

export const LEGACY = {
  dir: join(homedir(), ".config/codex-cu-bridge"),
  label: "com.hank-warren.codex-cu-bridge",
  files: [join(homedir(), ".local/bin/codex-cu-bridge"), join(homedir(), ".local/share/codex-cu-bridge")],
};
export const LEGACY_PLIST = join(homedir(), "Library/LaunchAgents", `${LEGACY.label}.plist`);
export const KNOWN_APPS = [
  ["com.brave.Browser", "Brave Browser"], ["com.google.Chrome", "Google Chrome"], ["com.microsoft.edgemac", "Microsoft Edge"],
  ["com.tinyspeck.slackmacgap", "Slack"], ["com.hnc.Discord", "Discord"],
];

export const inRange = (ip, [base, bits]) => {
  const n = (s) => s.split(".").reduce((a, o) => a * 256 + Number(o), 0);
  const mask = 2 ** 32 - 2 ** (32 - bits);
  return (n(ip) & mask) >>> 0 === (n(base) & mask) >>> 0;
};

// Tailscale's IPv4 from its CLI. Not guessed from interfaces: other VPNs (e.g. WARP) use the same range.
export async function tailscaleIp() {
  const clis = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale", "/usr/bin/tailscale", "/usr/sbin/tailscale"];
  for (const cli of clis) {
    if (!existsSync(cli)) continue;
    const r = await run(cli, ["ip", "-4"], 5000);
    const ip = r.stdout.trim().split("\n")[0];
    if (r.ok && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
  }
  return null;
}

// Private addresses on physical interfaces; VPN tunnels are skipped.
export function lanIps() {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (/^(utun|ipsec|ppp|gif|stf|tailscale|wg|tun|docker|br-|veth|virbr)/.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if ([["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16]].some((r) => inRange(a.address, r))) out.push({ ip: a.address, name });
    }
  }
  return out;
}

export async function installedApps() {
  if (!MAC) return [];
  const found = [];
  for (const [id, label] of KNOWN_APPS) {
    const r = await run("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${id}'`], 5000);
    if (r.stdout.trim() || existsSync(`/Applications/${label}.app`)) found.push([id, label]);
  }
  return found;
}

const installedBrowser = () => {
  if (MAC) return existsSync("/Applications/Brave Browser.app") ? "brave" : existsSync("/Applications/Google Chrome.app") ? "chrome" : null;
  const onPath = (c) => (process.env.PATH ?? "").split(":").some((d) => existsSync(join(d, c)));
  return onPath("brave") || onPath("brave-browser") ? "brave" : onPath("google-chrome") || onPath("google-chrome-stable") ? "chrome" : null;
};

export async function health(host, port, waitMs = 0, tokenFile) {
  const until = Date.now() + waitMs;
  let headers = {};
  try { if (tokenFile) headers = { Authorization: `Bearer ${readFileSync(expand(tokenFile), "utf8").trim()}` }; } catch {}
  for (;;) {
    try {
      const r = await fetch(`http://${host}:${port}/healthz`, { headers, signal: AbortSignal.timeout(2000) });
      if (r.ok) return await r.json();
    } catch {}
    if (Date.now() >= until) return null;
    await sleep(1000);
  }
}

export const hostName = () => hostname().split(".")[0].toLowerCase();

// What this machine needs for the config: [{ ok, warn?, human?, what, fix? }]. human marks steps
// only a person at the machine can do (permission prompts, the browser extension).
export async function checks(cfg) {
  const out = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  out.push(nodeMajor >= 20 ? { ok: true, what: `Node ${process.versions.node} (${process.execPath})` } : { ok: false, what: `Node ${process.versions.node} is too old`, fix: "install Node 20 or later" });
  if (cfg.appsOn) {
    out.push(engineCheck("open-computer-use", cfg));
    if (installedVersion("open-computer-use", cfg)) out.push(await ocuPermissions(cfg));
  }
  if (cfg.appsOn === false) out.push({ ok: true, what: MAC ? "apps: off" : `apps: off (app control needs macOS; ${process.platform} serves browser tabs)` });
  if (cfg.tabsOn) {
    const c = engineCheck("open-browser-use", cfg);
    out.push(c);
    if (installedVersion("open-browser-use", cfg)) {
      out.push(obuManifestCheck(cfg.tabs.browser));
      out.push(await extensionCheck(cfg));
    }
  } else out.push({ ok: true, what: "browser tabs: off" });
  return out;
}

const mark = (c) => (c.ok && !c.warn ? "ok  " : c.ok ? "warn" : "FAIL");
const printChecks = (list) => {
  for (const c of list) {
    say(`${mark(c)}  ${c.what}`);
    if ((!c.ok || c.warn) && c.fix) say(`      fix: ${c.fix}`);
  }
};

export function clientHelp(cfg, file) {
  const name = hostName();
  const urls = cfg.tunnels?.length
    ? cfg.tunnels.map((t) => `http://127.0.0.1:${t.remotePort}/mcp on ${t.ssh} (through the tunnel)`)
    : [`http://${cfg.host}:${cfg.port}/mcp`];
  say(`
Connect an agent: on the client machine (with ${NAME} installed there too), run
  ${NAME} connect ${name}${file !== DEFAULT_CONFIG ? ` --remote-config ${file}` : ""}
It copies the token over SSH without printing it and adds "${name}" to pi's ~/.pi/agent/mcp.json
(--print shows the configuration and the Claude Code command instead).
Server: ${urls.join("; ")}`);
}

const parseList = (s) => String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

export async function setup(opts) {
  // Absolute, because the service starts in another working directory.
  const file = configPath(opts.config);
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
  const choose = async (q, choices, def) => {
    if (!rl) return def;
    say(`\n${q}`);
    choices.forEach(([, label], i) => say(`  ${i + 1}) ${label}`));
    const d = Math.max(0, choices.findIndex(([v]) => v === def)) + 1;
    const pick = String(await ask("Choose a number", String(d)));
    const c = choices[Number(pick) - 1];
    if (!c) throw new Error(`no choice ${pick}`);
    return c[0];
  };
  try {
    say(`${NAME} ${VERSION} setup on ${hostName()} (${MAC ? "macOS" : process.platform})`);
    if (Number(process.versions.node.split(".")[0]) < 20) throw new Error(`Node ${process.versions.node} is too old; install Node 20 or later`);

    // Older installs: codex-cu-bridge's config and LaunchAgent, and 0.x's Homebrew service.
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
    if (MAC && file === DEFAULT_CONFIG && existsSync(LEGACY_PLIST) && await confirm(`Remove the old LaunchAgent ${LEGACY.label}? It would hold the same port`)) {
      await run("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${LEGACY.label}`]);
      rmSync(LEGACY_PLIST, { force: true });
      for (const f of LEGACY.files) rmSync(f, { recursive: true, force: true });
      say("Removed the old LaunchAgent and program files.");
    }
    let brewLeft = false;
    if (opts.service && brewServiceInstalled() && await confirm("Stop the Homebrew computer-use-bridge service from 0.x? This install replaces it and needs its port")) {
      await stopBrewService();
      brewLeft = true;
      say("Stopped the Homebrew service.");
    }

    const { cfg, migrated } = migrateConfig(existsSync(file) ? readJson(file) : {});
    if (migrated) say("Converting the config to 2.0: apps run on open-computer-use, and settings of the removed tools and agent-desktop are dropped.");

    // What to serve: apps (macOS) and browser tabs.
    let appsEngine = opts.apps ?? cfg.apps?.engine;
    if (!MAC) {
      if (opts.apps && opts.apps !== "off") throw new Error(`app control needs macOS; on ${process.platform} use --apps off`);
      appsEngine = "off";
    } else if (opts.apps === undefined) {
      appsEngine = await choose("Control apps through open-computer-use?", [
        ["open-computer-use", "yes: agents may use the apps you allow"],
        ["off", "off: browser tabs only"],
      ], appsEngine ?? "open-computer-use");
    }
    if (![...APP_ENGINES, "off"].includes(appsEngine)) throw new Error(`--apps must be ${APP_ENGINES.join(", ")} or off`);
    let allow = opts.allow !== undefined ? parseList(opts.allow) : cfg.apps?.allow;
    if (appsEngine !== "off" && (opts.allow === undefined && (interactive || !allow))) {
      const found = await installedApps();
      const current = allow ?? found.filter(([id]) => !["com.google.Chrome", "com.microsoft.edgemac"].includes(id)).map(([id]) => id);
      if (rl) {
        say("\nApps agents may control (comma-separated bundle IDs). Installed and supported here:");
        for (const [id, label] of found) say(`  ${id}  ${label}`);
        say("Find any app's ID with: osascript -e 'id of app \"App Name\"'");
      }
      allow = parseList(await ask("Allow", current.join(",")));
    }
    allow ??= [];
    const denied = allow.filter((id) => HARD_DENY.has(id.toLowerCase()));
    if (denied.length) say(`Ignoring always-denied apps: ${denied.join(", ")}`);
    allow = allow.filter((id) => !HARD_DENY.has(id.toLowerCase()));

    let tabs = opts.tabs ?? (cfg.tabs ? (cfg.tabs.engine === "off" ? "off" : cfg.tabs.browser ?? "brave") : undefined);
    if (opts.tabs === undefined) {
      tabs = await choose("Browser tabs through open-browser-use (agents open their own background tabs in your browser)?", [
        ["brave", "Brave"], ["chrome", "Google Chrome"], ["off", "off"],
      ], tabs ?? installedBrowser() ?? "brave");
    }
    if (![...Object.keys(BROWSER_IDS), "off"].includes(tabs)) throw new Error(`--tabs must be ${Object.keys(BROWSER_IDS).join(", ")} or off`);
    if (appsEngine === "off" && tabs === "off") throw new Error("apps and tabs are both off, so there would be nothing to serve");

    // Where clients connect: an address of this machine, or a reverse tunnel to machines that cannot reach it.
    const ts = await tailscaleIp();
    const lans = lanIps();
    let host = opts.host;
    let tunnelMode = opts.tunnel !== undefined;
    if (host === "tailscale") host = ts ?? (() => { throw new Error(`Tailscale is not connected on this ${OS}`); })();
    if (host === "localhost") host = "127.0.0.1";
    if (!host && !tunnelMode) {
      const choices = [];
      if (ts) choices.push({ ip: ts, label: "Tailscale (recommended: only your tailnet can reach it, and traffic is encrypted)" });
      for (const l of lans) choices.push({ ip: l.ip, label: `local network on ${l.name} (plain HTTP: anyone on this network can see traffic and the token)` });
      choices.push({ ip: "127.0.0.1", label: `this ${OS} only (local clients)` });
      choices.push({ tunnel: true, label: `a remote machine over SSH: for a VM you can SSH into but that cannot reach this ${OS} (e.g. over WARP); this ${OS} keeps a reverse tunnel open` });
      if (cfg.host && !cfg.tunnels?.length && !choices.some((c) => c.ip === cfg.host)) choices.unshift({ ip: cfg.host, label: `current config (not an address of this ${OS} right now)` });
      const def = (cfg.tunnels?.length ? choices.findIndex((c) => c.tunnel) : Math.max(0, choices.findIndex((c) => c.ip === cfg.host))) + 1;
      if (rl) {
        say("\nHow will clients connect?");
        choices.forEach((c, i) => say(`  ${i + 1}) ${c.ip ? `${c.ip}  ` : ""}${c.label}`));
      }
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
      for (const part of parseList(spec)) {
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

    const tokenFile = expand(cfg.tokenFile ?? join(CONFIG_DIR, "token"));
    if (!existsSync(tokenFile) || readFileSync(tokenFile, "utf8").trim().length < 32) {
      writePrivate(tokenFile, randomBytes(32).toString("hex") + "\n");
      say(`Generated a new token in ${tokenFile}`);
    }
    chmodSync(tokenFile, 0o600);

    for (const t of tunnels) {
      say(`\nChecking that this ${OS} can log in to ${t.ssh} without prompts (the service runs in the background)...`);
      const err = await checkSsh(t.ssh, rl && withTerminal);
      if (err) {
        say(`Login to ${t.ssh} failed: ${err}\nThe tunnel needs key login without prompts: use an SSH key${MAC ? ", and if it has a passphrase, store it in the Keychain (UseKeychain yes and AddKeysToAgent yes in ~/.ssh/config)" : " loaded in an agent the service can reach"}. Then run setup again.`);
        continue;
      }
      say("Login OK.");
      if (await confirm(`Copy the token to ${t.ssh} now (~/.config/${NAME}/${hostName()}.token there)?`)) {
        const r = await sshWrite(t.ssh, `umask 077; mkdir -p ~/.config/${NAME}; cat > ~/.config/${NAME}/${hostName()}.token`, readFileSync(tokenFile));
        say(r ? `Copying failed: ${r}` : "Token copied.");
      }
    }

    // The config file: 2.0 shape, without older keys.
    const out = { ...cfg, host, port, tokenFile };
    out.apps = { engine: appsEngine, allow };
    out.tabs = tabs === "off" ? { engine: "off" } : { engine: "open-browser-use", browser: tabs };
    if (tunnels.length) out.tunnels = tunnels;
    else delete out.tunnels;
    for (const k of ["allowApps", "appEngine", "engine", "ocuCommand"]) if (k === "ocuCommand" ? out[k] && !existsSync(expand(out[k])) : true) delete out[k];
    const norm = normalizeConfig(out, { file });

    // Engines: install the tested version of any that is missing or another version.
    const needed = [...(norm.appsOn ? ["open-computer-use"] : []), ...(norm.tabsOn ? ["open-browser-use"] : [])];
    const stale = needed.filter((n) => {
      const v = installedVersion(n, norm);
      return !v || (v !== "unknown" && v !== ENGINES[n].pin);
    });
    if (stale.length && opts.install !== false) {
      const specs = stale.map((n) => `${n}@${ENGINES[n].pin}`);
      if (await confirm(`\nInstall ${specs.join(", ")} with npm (${npmPath()})?`)) {
        say(`$ npm i -g ${specs.join(" ")}`);
        const err = await npmInstall(specs);
        say(err ? `npm failed: ${err}` : "Installed.");
      }
    }
    if (norm.tabsOn && installedVersion("open-browser-use", norm)) {
      const err = await registerObuHost(norm, tabs);
      say(err ? `Registering open-browser-use's native host failed: ${err}` : `Registered open-browser-use's native host for ${tabs === "brave" ? "Brave" : "Chrome"}.`);
    }

    writePrivate(file, JSON.stringify(out, null, 2) + "\n");
    say(`Wrote ${file}`);

    // Steps only a person can do; interactive setup opens them and waits.
    if (rl && norm.appsOn && installedVersion("open-computer-use", norm) && !(await ocuPermissions(norm)).ok) {
      say("\nopen-computer-use needs Accessibility and Screen Recording. Opening its setup; grant both to Open Computer Use in System Settings...");
      await ocuOnboard(norm);
      await waitFor(() => ocuPermissions(norm), "permissions granted", 180);
    }
    if (rl && norm.tabsOn && installedVersion("open-browser-use", norm) && !(await extensionCheck(norm)).ok) {
      const browser = tabs === "brave" ? "Brave" : "Chrome";
      say(`\nIn ${browser}, add the Open Browser Use extension to the profile agents should use:\n  ${OBU_STORE}\nThen quit and reopen ${browser}.`);
      if (await confirm("Open that page now?")) openUrl(OBU_STORE, tabs);
      await waitFor(() => extensionCheck(norm), "extension connected", 300);
    }

    // The service, and whether clients can reach it: these count toward the exit status too.
    const served = [];
    if (opts.service) {
      say(`\nInstalling the service (${MAC ? "LaunchAgent" : "systemd user unit"})...`);
      const npmBin = (await run(npmPath(), ["prefix", "-g"], 15_000)).stdout.trim();
      const notes = await installService(file, npmBin ? [join(npmBin, "bin")] : []);
      for (const n of notes) say(`Note: ${n}`);
      const h = await health(host, port, 15_000);
      const svc = await serviceState();
      served.push(svc.running ? { ok: true, what: `service ${svc.detail}` } : { ok: false, what: `service ${svc.detail}`, fix: `see ${logHint()}` });
      served.push(h ? { ok: true, what: `server answering on http://${host}:${port}/mcp (version ${h.version})` } : { ok: false, what: `server not answering on http://${host}:${port}`, fix: `see ${logHint()}` });
      if (h && tunnels.length) {
        let states = [];
        for (let i = 0; i < 25; i++) {
          states = (await health(host, port, 0, tokenFile))?.tunnels ?? [];
          if (states.length && states.every((s) => s.up)) break;
          await sleep(1000);
        }
        for (const t of tunnels) {
          const s = states.find((x) => x.ssh === t.ssh);
          served.push(s?.up ? { ok: true, what: `tunnel to ${t.ssh}: port ${t.remotePort} there reaches this server` }
            : { ok: false, what: `tunnel to ${t.ssh} is not up${s?.error ? `: ${s.error}` : ""}`, fix: `it keeps retrying; check SSH key login to ${t.ssh} and "${NAME} status"` });
        }
      }
    } else say(`\nNo service installed (--no-service); run "${NAME} serve --config ${file}" under your own supervisor.`);
    if (brewLeft) say(`\nThe Homebrew formula is no longer used; remove it with: brew uninstall ${NAME} && brew untap hank-warren/${NAME}`);

    say("\nChecks:");
    const list = [...served, ...await checks(norm)];
    printChecks(list);
    const todo = list.filter((c) => !c.ok);
    if (todo.length) {
      say(`\nNeeds ${todo.some((c) => c.human) ? "a person at this " + OS : "attention"}:`);
      for (const c of todo) say(`  - ${c.what}\n    ${c.fix ?? ""}`);
      say(`Then run "${NAME} status".`);
    }
    clientHelp(norm, file);
    return todo.length ? 3 : 0;
  } finally {
    rl?.close();
  }
}

async function waitFor(check, done, seconds) {
  say(`Waiting up to ${Math.round(seconds / 60)} min for ${done} (Ctrl-C stops setup; run it again later)...`);
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const c = await check();
    if (c.ok) return say(`  ${c.what}`);
    await sleep(3000);
  }
  say("  Still waiting; continuing. The checks below say what is left.");
}

function openUrl(url, browser) {
  const cmd = MAC ? ["/usr/bin/open", ["-a", browser === "chrome" ? "Google Chrome" : "Brave Browser", url]] : ["xdg-open", [url]];
  try { spawn(...cmd, { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch {}
}

const SSH_CHECK_OPTS = ["-o", "ConnectTimeout=15", "-o", "RemoteCommand=none", "-o", "RequestTTY=no", "-o", "ControlMaster=no", "-o", "ControlPath=none"];
const SSH = MAC ? "/usr/bin/ssh" : "ssh";

// Checks key login without prompts; if it fails and setup is interactive, connects
// once interactively first (to accept a new host key or unlock a key).
export async function checkSsh(dest, withTerminal) {
  const batch = () => run(SSH, ["-o", "BatchMode=yes", ...SSH_CHECK_OPTS, dest, "true"], 30_000);
  let r = await batch();
  if (!r.ok && withTerminal) {
    say(`Background login failed (${lastLine(r.stderr) || "no error"}). Connecting interactively once, e.g. to accept its host key:`);
    await withTerminal(() => new Promise((res) => spawn(SSH, [...SSH_CHECK_OPTS, dest, "true"], { stdio: "inherit" }).on("exit", res)));
    r = await batch();
  }
  return r.ok ? null : lastLine(r.stderr) || `ssh exited ${r.code}`;
}

// Runs a command over SSH with data on its stdin; returns an error message or null.
export function sshWrite(dest, command, data) {
  return new Promise((resolve) => {
    const p = spawn(SSH, ["-o", "BatchMode=yes", ...SSH_CHECK_OPTS, dest, command], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", (e) => resolve(e.message));
    p.on("close", (code) => resolve(code === 0 ? null : lastLine(err) || `ssh exited ${code}`));
    p.stdin.end(data);
  });
}

// npm i -g computer-use-bridge@latest, then the new version's own setup --yes, which keeps the
// config, installs its tested engine versions and rewrites and restarts the service.
export async function update(opts) {
  const pkg = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
  const root = (await run(npmPath(), ["root", "-g"], 15_000)).stdout.trim();
  let global = false;
  try { global = !!root && pkg.startsWith(realpathSync(root)); } catch {}
  if (global) {
    say(`$ npm i -g ${NAME}@latest`);
    const err = await npmInstall([`${NAME}@latest`]);
    if (err) throw new Error(`npm failed: ${err}`);
  } else say(`${pkg} is not an npm global install, so it is not upgraded here (git pull a checkout). Refreshing the engines and service...`);
  const args = [binScript(), "setup", "--yes", "--config", configPath(opts.config), ...(opts.service ? [] : ["--no-service"])];
  return new Promise((resolve) => spawn(process.execPath, args, { stdio: "inherit" }).on("exit", (code) => resolve(code ?? 1)));
}

export async function status(opts) {
  const file = expand(opts.config);
  const report = { version: VERSION, host: hostName(), platform: process.platform, config: file, ok: true, checks: [] };
  const add = (c) => {
    report.checks.push(c);
    if (!c.ok) report.ok = false;
  };
  let cfg = null;
  try {
    const raw = readJson(file);
    cfg = normalizeConfig(raw, { file });
    const tokenOk = existsSync(expand(cfg.tokenFile ?? "")) && readFileSync(expand(cfg.tokenFile), "utf8").trim().length >= 32;
    add({ ok: true, what: `config ${file}${migrateConfig(raw).migrated ? ' (0.x format; run "setup" to convert it)' : ""}` });
    add(tokenOk ? { ok: true, what: `token ${cfg.tokenFile}` } : { ok: false, what: `token ${cfg.tokenFile ?? "(none)"} is missing or short`, fix: `run "${NAME} setup"` });
    report.server = { url: `http://${cfg.host}:${cfg.port}/mcp`, apps: cfg.appsOn ? { engine: "open-computer-use", allow: cfg.allowApps } : "off", tabs: cfg.tabsOn ? cfg.tabs.browser : "off" };
  } catch (e) {
    add({ ok: false, what: `config: ${e.message}`, fix: `run "${NAME} setup"` });
  }
  // Look for engines where the service would: beside its node (nvm keeps globals there).
  const sc = serviceCommand();
  if (sc?.node && existsSync(sc.node) && sc.node !== process.execPath) {
    process.env.PATH = `${dirname(sc.node)}:${process.env.PATH ?? ""}`;
    report.serviceNode = sc.node;
  }
  const svc = await serviceState();
  report.service = svc;
  add(svc.installed ? { ok: svc.running, what: `service ${svc.detail}`, fix: `see ${logHint()}` } : { ok: false, what: "service not installed", fix: `run "${NAME} setup" (or run "${NAME} serve" yourself)` });
  if (sc?.node && !existsSync(sc.node)) add({ ok: false, what: `the service runs ${sc.node}, which no longer exists (Node was upgraded or switched)`, fix: `run "${NAME} setup --yes" to point it at this Node` });
  if (sc?.script && !existsSync(sc.script)) add({ ok: false, what: `the service runs ${sc.script}, which no longer exists`, fix: `run "${NAME} setup --yes"` });
  if (svc.installed && !MAC && !(await linger())) add({ ok: true, warn: true, what: "lingering is off: the service stops at logout and does not start at boot", fix: `sudo loginctl enable-linger ${process.env.USER ?? "$USER"}` });
  if (brewServiceInstalled()) add({ ok: false, what: "the 0.x Homebrew service is still installed and holds the same port", fix: `run "${NAME} setup", or: brew services stop ${NAME} && brew uninstall ${NAME}` });
  if (MAC && existsSync(LEGACY_PLIST)) add({ ok: false, what: `old LaunchAgent still installed (${LEGACY.label})`, fix: `run "${NAME} setup" to remove it` });
  if (cfg) {
    const h = await health(cfg.host, cfg.port, 0, cfg.tokenFile);
    report.server.answering = !!h;
    add(h ? { ok: true, warn: h.version !== VERSION, what: `server answering, version ${h.version}`, fix: h.version !== VERSION ? `restart the service to run ${VERSION}` : undefined } : { ok: false, what: `server not answering on ${cfg.host}:${cfg.port}`, fix: `see ${logHint()}` });
    for (const t of h?.tunnels ?? []) add({ ok: t.up, what: `tunnel to ${t.ssh} port ${t.remotePort} ${t.up ? "up" : `down: ${t.error}`}` });
    for (const c of await checks(cfg)) add(c);
  }
  if (opts.json) say(JSON.stringify(report, null, 2));
  else {
    say(`${NAME} ${VERSION} on ${report.host}${report.serviceNode ? ` (the service runs ${report.serviceNode})` : ""}`);
    printChecks(report.checks);
  }
  return report.ok ? 0 : 1;
}

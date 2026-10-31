import { spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { createInterface as createPrompt } from "node:readline/promises";
import { APPS_SUPPORTED, BROWSERS, CONFIG_DIR, DEFAULT_CONFIG, DEFAULT_PORT, HARD_DENY, NAME, TABS_ONLY_HINT, VERSION, expand, lastLine, readJson, run, say, writePrivate } from "./common.mjs";
import { checkTunnel, loadConfig } from "./config.mjs";
import { findOcu } from "./engines/open-computer-use.mjs";
import { ObuBrowser } from "./engines/open-browser-use.mjs";

// ---------- setup and status ----------

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
  for (const cli of ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"]) {
    if (!existsSync(cli)) continue;
    const r = await run(cli, ["ip", "-4"], 5000);
    const ip = r.stdout.trim().split("\n")[0];
    if (r.ok && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
  }
  return null;
}

// Private addresses on physical interfaces; VPN tunnels (utun, ipsec, ppp) are skipped.
export function lanIps() {
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

export async function installedApps() {
  const found = [];
  for (const [id, label] of KNOWN_APPS) {
    const r = await run("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${id}'`], 5000);
    if (r.stdout.trim() || existsSync(`/Applications/${label}.app`)) found.push([id, label]);
  }
  return found;
}

export function brewPath() {
  for (const p of [process.env.HOMEBREW_PREFIX && join(process.env.HOMEBREW_PREFIX, "bin/brew"), "/opt/homebrew/bin/brew", "/usr/local/bin/brew"]) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

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
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// Where browsers look for open-browser-use's native host. On macOS Brave reads Chrome's folder; on Linux each has its own.
export const OBU_HOST = "NativeMessagingHosts/com.ifuryst.open_browser_use.extension.json";
export const OBU_MANIFESTS = APPS_SUPPORTED
  ? [join(homedir(), "Library/Application Support/Google/Chrome", OBU_HOST)]
  : [join(homedir(), ".config/BraveSoftware/Brave-Browser", OBU_HOST), join(homedir(), ".config/google-chrome", OBU_HOST)];
export const OBU_MANIFEST_FIX = APPS_SUPPORTED
  ? "npm i -g open-browser-use && open-browser-use install-manifest --browser chrome (also for Brave, which reads Chrome's folder)"
  : `npm i -g open-browser-use && open-browser-use install-manifest --output ~/${OBU_MANIFESTS[0].slice(homedir().length + 1)} (Brave; Chrome uses ~/.config/google-chrome)`;
export const OBU_STORE = "https://chromewebstore.google.com/detail/open-browser-use/bgjoihaepiejlfjinojjfgokghnodnhd";

// What the bridge needs on this Mac: [{ ok, what, fix }].
export async function prerequisites(cfg) {
  const out = [];
  const add = (ok, what, fix) => out.push({ ok, what, fix });
  const ocu = findOcu(cfg);
  if (!APPS_SUPPORTED) {
    add(true, `apps: off (open-computer-use runs on macOS only; ${process.platform} gets browser tabs)`);
  } else if (!existsSync(ocu)) {
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
    if (APPS_SUPPORTED) add(true, `browser tabs: off (allow ${BROWSERS.join(" or ")} to use them)`);
    else add(false, "browser tabs: off, so there is nothing to serve", TABS_ONLY_HINT);
    return out;
  }
  const manifest = OBU_MANIFESTS.find((f) => existsSync(f));
  add(!!manifest, `open-browser-use native host ${manifest ? `registered (${manifest})` : "is not registered"}`, OBU_MANIFEST_FIX);
  const b = new ObuBrowser(cfg, "check");
  try {
    const tabs = await b.userTabs();
    if (b.scanned) out.push({ ok: true, warn: true, what: `open-browser-use extension connected (${tabs.length} tabs) by socket scan: ${b.scanned}`, fix: "optional: disable and re-enable the extension so its native host rewrites active.json" });
    else add(true, `open-browser-use extension connected (${tabs.length} tabs)`);
  } catch (e) {
    add(false, `open-browser-use extension is not connected: ${e.message}`, `install the Open Browser Use extension in your browser (${OBU_STORE}), then quit and reopen the browser`);
  } finally {
    await b.close();
  }
  return out;
}

export const macName = () => hostname().split(".")[0].toLowerCase();

export const clientConfigs = (mac, url, tokenPath) => `   pi (~/.pi/agent/mcp.json, under "mcpServers"):
     "${mac}-cu": {
       "url": "${url}",
       "headers": { "Authorization": "!echo Bearer $(cat ${tokenPath})" },
       "timeout": 120
     }

   Claude Code:
     claude mcp add --transport http ${mac}-cu ${url} --header "Authorization: Bearer $(cat ${tokenPath})"`;

export function clientHelp(cfg) {
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

export async function setup(opts) {
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
    if (!APPS_SUPPORTED) throw new Error(`setup is macOS-only; on ${process.platform}, write ${DEFAULT_CONFIG} by hand and run "${NAME} serve" as a service (see the README's Linux section)`);
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
    for (const c of await prerequisites(cfg)) say(c.ok && !c.warn ? `  ok    ${c.what}` : `  ${c.ok ? "warn" : "FAIL"}  ${c.what}\n        fix: ${c.fix}`);

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

export const SSH_CHECK_OPTS = ["-o", "ConnectTimeout=15", "-o", "RemoteCommand=none", "-o", "RequestTTY=no", "-o", "ControlMaster=no", "-o", "ControlPath=none"];

// Checks key login without prompts; if it fails and setup is interactive, connects
// once interactively first (to accept a new host key or unlock a key).
export async function checkSsh(dest, withTerminal) {
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
export function sshWrite(dest, command, data) {
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
export async function update() {
  if (!APPS_SUPPORTED) throw new Error(`update is macOS-only; on ${process.platform}, update the checkout (git pull) and restart your service`);
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

export async function status(opts) {
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
    if (c.warn) say(`warn  ${c.what}`);
    else line(c.ok, c.what);
    if (!c.ok || c.warn) say(`      fix: ${c.fix}`);
  }
  return bad ? 1 : 0;
}

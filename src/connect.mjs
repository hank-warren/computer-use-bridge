import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR, NAME, expand, lastLine, say, writePrivate } from "./common.mjs";
import { loadConfig } from "./config.mjs";
import { hostName } from "./setup.mjs";

// ---------- connect: run on the client ----------

const SSH = process.platform === "darwin" ? "/usr/bin/ssh" : "ssh";
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "RequestTTY=no"];
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// A remote command line that finds computer-use-bridge and its node even in a non-login SSH shell
// (npm global bins and Homebrew are often only on the login PATH).
export function remoteCommand(args, bin) {
  const tail = args.map(shq).join(" ");
  return `for c in ${bin ? `${shq(bin)} ` : ""}"$(command -v ${NAME} 2>/dev/null)" "$HOME/.npm-global/bin/${NAME}" /opt/homebrew/bin/${NAME} /usr/local/bin/${NAME} "$HOME/.local/bin/${NAME}" "$HOME"/.nvm/versions/node/*/bin/${NAME}; do ` +
    `if [ -x "$c" ]; then PATH="$(dirname "$c"):/opt/homebrew/bin:/usr/local/bin:$PATH" exec "$c" ${tail}; fi; done; echo "${NAME} is not installed there (npm i -g ${NAME})" >&2; exit 127`;
}

const sshOut = (dest, command, timeoutMs = 60_000) => new Promise((resolve) => {
  const p = spawn(SSH, [...SSH_OPTS, dest, command], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  const timer = setTimeout(() => p.kill(), timeoutMs);
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { err += d; });
  p.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, out, err: e.message }); });
  p.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, out, err }); });
});

// Server side of connect: what a client needs, as JSON. The token is included only with
// --with-token and never to a terminal.
export async function clientInfo(opts) {
  const cfg = loadConfig({ ...opts, mode: "serve" });
  const info = {
    name: hostName(), version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
    host: cfg.host, port: cfg.port, tunnels: cfg.tunnels,
    apps: cfg.appsOn ? cfg.allowApps : [], tabs: cfg.tabsOn ? cfg.tabs.browser : "off",
  };
  if (opts.withToken) {
    if (process.stdout.isTTY) throw new Error("refusing to print the token to a terminal; connect reads it over SSH");
    info.token = readFileSync(expand(cfg.tokenFile), "utf8").trim();
  }
  process.stdout.write(JSON.stringify(info) + "\n");
  return 0;
}

const describe = (info) => {
  const parts = [];
  if (info.apps.length) parts.push(`apps ${info.apps.join(", ")}`);
  if (info.tabs !== "off") parts.push(`${info.tabs === "chrome" ? "Chrome" : "Brave"} tabs`);
  return `Computer use on ${info.name} through ${NAME} ${info.version} (${parts.join("; ") || "nothing allowed"}).`;
};

export async function connect(opts) {
  const dest = opts.host;
  if (!dest || !/^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,252}$/.test(dest)) throw new Error("connect needs an SSH destination, e.g. connect pikachu or connect me@my-mac");
  say(`Asking ${dest} for its ${NAME} settings over SSH...`);
  const r = await sshOut(dest, remoteCommand(["client-info", "--with-token", ...(opts.remoteConfig ? ["--config", opts.remoteConfig] : [])], opts.remoteBin));
  if (!r.ok) throw new Error(`ssh ${dest} failed: ${lastLine(r.err) || "no output"}`);
  let info;
  try { info = JSON.parse(r.out.trim().split("\n").pop()); } catch { throw new Error(`unexpected answer from ${dest}: ${lastLine(r.err || r.out)}`); }
  const name = opts.name ?? info.name;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error(`--name must be letters, digits, - or _ (got ${name})`);

  // How this client reaches the server: its tunnel port here, its address, or stdio over SSH.
  const tunnel = info.tunnels?.find((t) => t.ssh === opts.tunnelName) ?? (info.tunnels?.length === 1 ? info.tunnels[0] : null);
  let url = null;
  if (info.tunnels?.length) {
    if (!tunnel) throw new Error(`${dest} has tunnels to ${info.tunnels.map((t) => t.ssh).join(", ")}; pass --tunnel-name with the one for this machine`);
    url = `http://127.0.0.1:${tunnel.remotePort}/mcp`;
  } else if (info.host !== "127.0.0.1") url = `http://${info.host}:${info.port}/mcp`;

  const tokenFile = join(CONFIG_DIR, `${name}.token`);
  const tokenRef = `~/.config/${NAME}/${name}.token`;
  if (url) {
    writePrivate(tokenFile, info.token + "\n");
    say(`Saved the token to ${tokenFile} (mode 600).`);
    try {
      const h = await fetch(url.replace(/\/mcp$/, "/healthz"), { headers: { Authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(5000) });
      say(h.ok ? `Reached ${url} (version ${(await h.json()).version}).` : `Warning: ${url} answered ${h.status}.`);
    } catch (e) {
      say(`Warning: cannot reach ${url} from here (${e.cause?.code ?? e.message}). Check Tailscale (and its ACLs) or the tunnel.`);
    }
  } else say(`${dest} listens on 127.0.0.1 only, so this client uses stdio over SSH.`);

  const entry = url
    ? { url, headers: { Authorization: `!echo Bearer $(cat ${tokenRef})` }, timeout: 120, description: describe(info) }
    : { command: "ssh", args: ["-T", "-o", "BatchMode=yes", dest, remoteCommand(["stdio", ...(opts.remoteConfig ? ["--config", opts.remoteConfig] : [])], opts.remoteBin)], timeout: 180, description: describe(info) };

  if (opts.print) {
    say(`\npi (~/.pi/agent/mcp.json, under "mcpServers"):\n${JSON.stringify({ [name]: entry }, null, 2)}`);
    if (url) say(`\nClaude Code:\n  claude mcp add --transport http ${name} ${url} --header "Authorization: Bearer $(cat ${tokenRef})"`);
    return 0;
  }
  const piFile = expand(opts.piConfig ?? join(homedir(), ".pi/agent/mcp.json"));
  let pi = { mcpServers: {} };
  if (existsSync(piFile)) {
    pi = JSON.parse(readFileSync(piFile, "utf8"));
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    copyFileSync(piFile, `${piFile}.bak.${stamp}`);
    say(`Backed up ${piFile} to ${piFile}.bak.${stamp}`);
  }
  pi.mcpServers ??= {};
  const replaced = name in pi.mcpServers;
  pi.mcpServers[name] = entry;
  const mode = existsSync(piFile) ? statSync(piFile).mode & 0o777 : 0o600;
  writePrivate(piFile, JSON.stringify(pi, null, 2) + "\n");
  if (mode !== 0o600) chmodSync(piFile, mode);
  say(`${replaced ? "Updated" : "Added"} "${name}" in ${piFile}. Reload pi (or start a new session) to use it; --print shows the Claude Code command.`);
  return 0;
}

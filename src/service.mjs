import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NAME, run, sleep, writePrivate } from "./common.mjs";

// The bridge runs as a per-user service: a LaunchAgent on macOS, a systemd user unit on Linux.
export const LABEL = "com.hank-warren.computer-use-bridge";
export const PLIST = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
export const UNIT = join(homedir(), ".config/systemd/user", `${NAME}.service`);
export const MAC_LOG = join(homedir(), "Library/Logs", `${NAME}.log`);
// 0.x's Homebrew service: newer Homebrew labels it sh.brew.*, older homebrew.mxcl.*.
const BREW_LABELS = [`sh.brew.${NAME}`, `homebrew.mxcl.${NAME}`];
const brewPlists = () => BREW_LABELS.map((l) => join(homedir(), "Library/LaunchAgents", `${l}.plist`)).filter((f) => existsSync(f));
const MAC = process.platform === "darwin";

export const binScript = () => realpathSync(fileURLToPath(new URL("../bin/computer-use-bridge.mjs", import.meta.url)));

// A node path that survives upgrades where one exists: Homebrew's opt link rather than its Cellar
// directory. Version managers (nvm, fnm) only have versioned paths; setup and update rewrite the
// service when the version changes, and status flags a path that no longer exists.
export function stableNode(execPath = process.execPath) {
  const m = /^(.*)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/.exec(execPath);
  if (m && existsSync(join(m[1], "opt", m[2], "bin/node"))) return join(m[1], "opt", m[2], "bin/node");
  return execPath;
}
export const versionedNode = (p) => /\/(\.nvm|\.fnm|fnm|\.volta|mise|\.asdf)\//.test(p) || /\/Cellar\//.test(p);

// The PATH the service runs with: node's directory first (npm launchers run `node`), then the
// usual places npm and Homebrew put global commands.
export function servicePath(node, extra = []) {
  const dirs = [dirname(node), ...extra, join(homedir(), ".npm-global/bin"), join(homedir(), ".local/bin")];
  if (MAC) dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  dirs.push("/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin");
  return [...new Set(dirs)].join(":");
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function plist(node, script, config, extra = []) {
  const args = [node, script, "serve", "--config", config].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(servicePath(node, extra))}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(MAC_LOG)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(MAC_LOG)}</string>
</dict>
</plist>
`;
}

const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, "\\$1")}"`);
export function unit(node, script, config, extra = []) {
  return `[Unit]
Description=${NAME}: MCP access to this machine's browser tabs${MAC ? " and apps" : ""}
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${[node, script, "serve", "--config", config].map(q).join(" ")}
Environment=PATH=${servicePath(node, extra)}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

// The node and script a service file starts, or null.
export function serviceCommand() {
  const f = MAC ? PLIST : UNIT;
  if (!existsSync(f)) return null;
  const text = readFileSync(f, "utf8");
  if (MAC) {
    const args = [...text.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
    const i = args.findIndex((a) => a === LABEL);
    return { file: f, node: args[i + 1], script: args[i + 2] };
  }
  const m = /^ExecStart=("([^"]*)"|\S+) ("([^"]*)"|\S+)/m.exec(text);
  const spec = (s) => s?.replace(/%h/g, homedir()).replace(/%u/g, userInfo().username);
  return m ? { file: f, node: spec(m[2] ?? m[1]), script: spec(m[4] ?? m[3]) } : { file: f };
}

const uid = () => userInfo().uid;

// launchctl bootout returns before the job has unloaded, and a bootstrap meanwhile fails with
// "5: Input/output error", leaving the service down: wait for the old job to go, and retry.
// lc runs launchctl with the given arguments.
export async function launchdReload(lc, { label = LABEL, plistFile = PLIST, domain = `gui/${uid()}`, wait = sleep } = {}) {
  await lc(["bootout", `${domain}/${label}`]);
  for (let i = 0; i < 40 && (await lc(["print", `${domain}/${label}`])).ok; i++) await wait(250);
  const loaded = (r) => r.ok || /already|in progress/i.test(r.stderr ?? "");
  let r;
  for (let i = 0; i < 5; i++) {
    r = await lc(["bootstrap", domain, plistFile]);
    if (loaded(r)) break;
    await wait(1000);
  }
  if (!loaded(r)) throw new Error(`launchctl bootstrap failed: ${(r.stderr ?? "").trim() || r.code}. The service is not running; start it with: launchctl bootstrap ${domain} ${plistFile}`);
  // The plist has RunAtLoad, so bootstrap started it; a job that was still loaded needs a restart.
  if (!r.ok) await lc(["kickstart", "-k", `${domain}/${label}`]);
}

// Writes the service for this node and config and (re)starts it. extra: more PATH directories
// (npm's global bin). Returns notes for the user.
export async function installService(config, extra = []) {
  const node = stableNode();
  const script = binScript();
  const notes = [];
  if (versionedNode(node)) notes.push(`The service runs ${node}, which belongs to one Node version; after switching versions run "${NAME} setup" again (or "${NAME} update").`);
  if (MAC) {
    writePrivate(PLIST, plist(node, script, config, extra));
    await launchdReload((args) => run("/bin/launchctl", args, 15_000));
    return notes;
  }
  writePrivate(UNIT, unit(node, script, config, extra));
  const sc = (...a) => run("systemctl", ["--user", ...a], 30_000);
  let r = await sc("daemon-reload");
  if (!r.ok) throw new Error(`systemctl --user daemon-reload failed: ${r.stderr.trim()} (is there a user systemd session?)`);
  r = await sc("enable", `${NAME}.service`);
  if (!r.ok) throw new Error(`systemctl --user enable failed: ${r.stderr.trim()}`);
  r = await sc("restart", `${NAME}.service`);
  if (!r.ok) throw new Error(`systemctl --user restart failed: ${r.stderr.trim()}`);
  if (!(await linger())) notes.push(`Lingering is off, so the service stops when you log out and does not start at boot. Turn it on with: sudo loginctl enable-linger ${userInfo().username}`);
  return notes;
}

export async function restartService() {
  if (MAC) return run("/bin/launchctl", ["kickstart", "-k", `gui/${uid()}/${LABEL}`], 15_000);
  return run("systemctl", ["--user", "restart", `${NAME}.service`], 30_000);
}

export async function linger() {
  if (MAC) return true;
  const r = await run("loginctl", ["show-user", userInfo().username, "-p", "Linger"], 10_000);
  return /Linger=yes/.test(r.stdout);
}

// { installed, running, pid?, detail }
export async function serviceState() {
  if (MAC) {
    if (!existsSync(PLIST)) return { installed: false, running: false, detail: "not installed" };
    const r = await run("/bin/launchctl", ["print", `gui/${uid()}/${LABEL}`], 10_000);
    const pid = /\bpid = (\d+)/.exec(r.stdout)?.[1];
    return { installed: true, running: !!pid, pid, detail: pid ? `running (pid ${pid})` : r.ok ? "loaded, not running" : "not loaded" };
  }
  if (!existsSync(UNIT)) return { installed: false, running: false, detail: "not installed" };
  const r = await run("systemctl", ["--user", "show", `${NAME}.service`, "-p", "ActiveState", "-p", "MainPID", "-p", "UnitFileState"], 10_000);
  const get = (k) => new RegExp(`^${k}=(.*)$`, "m").exec(r.stdout)?.[1];
  const running = get("ActiveState") === "active";
  return { installed: true, running, pid: get("MainPID"), detail: `${get("ActiveState") ?? "unknown"}${get("UnitFileState") ? `, ${get("UnitFileState")}` : ""}` };
}

// The 0.x Homebrew service, which holds the same port.
export const brewServiceInstalled = () => MAC && brewPlists().length > 0;
export async function stopBrewService() {
  const brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find((b) => existsSync(b));
  if (brew) await run(brew, ["services", "stop", NAME], 60_000);
  for (const l of BREW_LABELS) await run("/bin/launchctl", ["bootout", `gui/${uid()}/${l}`], 15_000);
  for (const f of brewPlists()) rmSync(f, { force: true });
}

export const logHint = () => (MAC ? `tail -f ${MAC_LOG}` : `journalctl --user -u ${NAME} -f`);

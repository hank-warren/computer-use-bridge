import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const NAME = "computer-use-bridge";
export const CONFIG_DIR = join(homedir(), ".config", NAME);
export const DEFAULT_CONFIG = join(CONFIG_DIR, "config.json");
export const DEFAULT_PORT = 47800;
// App engines drive macOS apps only; elsewhere (Linux) the bridge serves browser tabs alone.
export const APPS_SUPPORTED = process.platform === "darwin";

// Never controllable, even if listed in apps.allow:
// shells, script runners, credential stores, system settings and mail/messages.
export const HARD_DENY = new Set([
  "com.apple.Terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty",
  "com.github.wez.wezterm", "net.kovidgoyal.kitty", "org.alacritty",
  "dev.warp.Warp-Stable", "dev.warp.Warp", "co.zeit.hyper",
  "com.apple.ScriptEditor2", "com.apple.Automator", "com.apple.shortcuts",
  "com.apple.systempreferences", "com.apple.keychainaccess", "com.apple.Passwords",
  "com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop",
  "com.apple.mail", "com.apple.MobileSMS",
].map((id) => id.toLowerCase()));

export const log = (...a) => process.stderr.write(`${new Date().toISOString()} ${NAME}: ${a.join(" ")}\n`);
export const expand = (p) => (p?.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const J = JSON.stringify;
// npm-installed commands run on the `node` on PATH, which a launchd service may lack.
export const childEnv = () => ({ ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}` });
export const run = (cmd, args, timeout = 30_000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, env: childEnv() }, (e, stdout, stderr) => resolve({ ok: !e, code: e?.code ?? 0, stdout: String(stdout), stderr: String(stderr) }));
});
export const say = (s = "") => process.stdout.write(s + "\n");
export const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
export const writePrivate = (f, text) => {
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  writeFileSync(f, text, { mode: 0o600 });
  chmodSync(f, 0o600);
};
export const lastLine = (s) => s.trim().split("\n").filter((l) => l.trim() && !l.startsWith("debug")).at(-1) ?? "";

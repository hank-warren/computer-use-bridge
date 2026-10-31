import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { lastLine, run } from "../common.mjs";
import { BROWSER_IDS } from "../config.mjs";
import { findAd } from "./agent-desktop.mjs";
import { ObuBrowser } from "./open-browser-use.mjs";
import { findOcu } from "./open-computer-use.mjs";

// The engine versions this release is tested with. setup installs these; status warns when the
// installed major version differs.
export const ENGINES = {
  "open-computer-use": { pin: "1.1.2", find: findOcu, repo: "https://github.com/iFurySt/open-computer-use" },
  "agent-desktop": { pin: "1.0.2", find: findAd, repo: "https://github.com/vercel-labs/agent-desktop" },
  "open-browser-use": { pin: "1.1.0", find: findObu, repo: "https://github.com/iFurySt/open-browser-use" },
};

export const OBU_STORE = "https://chromewebstore.google.com/detail/open-browser-use/bgjoihaepiejlfjinojjfgokghnodnhd";
const MAC = process.platform === "darwin";
const OBU_HOST = "NativeMessagingHosts/com.ifuryst.open_browser_use.extension.json";

export function findObu(cfg = {}) {
  if (cfg.obuCommand) return cfg.obuCommand;
  const dirs = [...(process.env.PATH ?? "").split(":"), dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".npm-global/bin")];
  return dirs.filter(Boolean).map((d) => join(d, "open-browser-use")).find((f) => existsSync(f)) ?? "open-browser-use";
}

// The npm package version behind an installed command, from its package.json.
export function installedVersion(name, cfg = {}) {
  const cmd = ENGINES[name].find(cfg);
  if (!existsSync(cmd)) return null;
  let d = dirname(realpathSync(cmd));
  for (let i = 0; i < 6; i++, d = dirname(d)) {
    try {
      const p = JSON.parse(readFileSync(join(d, "package.json"), "utf8"));
      if (p.name === name) return p.version;
    } catch {}
  }
  return "unknown";
}

const major = (v) => Number(String(v).split(".")[0]);
export const engineCheck = (name, cfg) => {
  const v = installedVersion(name, cfg);
  const pin = ENGINES[name].pin;
  if (!v) return { ok: false, what: `${name} is not installed`, fix: `npm i -g ${name}@${pin} (or let "setup" install it)` };
  if (v !== "unknown" && major(v) !== major(pin)) return { ok: true, warn: true, what: `${name} ${v} (this release is tested with ${pin})`, fix: `npm i -g ${name}@${pin}` };
  return { ok: true, what: `${name} ${v}` };
};

// npm beside this node, so globals land where this node's npm puts them.
export const npmPath = () => {
  const p = join(dirname(process.execPath), "npm");
  return existsSync(p) ? p : "npm";
};
export async function npmInstall(specs) {
  // Their install scripts only place native helpers; npm 11 asks for them to be allowed.
  const r = await run(npmPath(), ["i", "-g", ...specs, `--allow-scripts=${specs.map((s) => s.replace(/@[^@]*$/, "")).join(",")}`], 300_000);
  if (r.ok) return null;
  // Older npm does not know --allow-scripts.
  if (/allow-scripts/.test(r.stderr)) {
    const r2 = await run(npmPath(), ["i", "-g", ...specs], 300_000);
    if (r2.ok) return null;
    return lastLine(r2.stderr) || `npm exited ${r2.code}`;
  }
  return lastLine(r.stderr) || `npm exited ${r.code}`;
}

// Where the browser looks for open-browser-use's native host. Brave on macOS reads Chrome's folder.
export function obuManifest(browser) {
  if (MAC) return join(homedir(), "Library/Application Support/Google/Chrome", OBU_HOST);
  return browser === "brave" ? join(homedir(), ".config/BraveSoftware/Brave-Browser", OBU_HOST) : join(homedir(), ".config/google-chrome", OBU_HOST);
}
export async function registerObuHost(cfg, browser) {
  const out = obuManifest(browser);
  const args = MAC || browser === "chrome" ? ["install-manifest", "--browser", "chrome"] : ["install-manifest", "--output", out];
  const r = await run(findObu(cfg), args, 60_000);
  return r.ok && existsSync(out) ? null : lastLine(r.stderr || r.stdout) || `exit ${r.code}`;
}
export function obuManifestCheck(browser) {
  const f = obuManifest(browser);
  if (!existsSync(f)) return { ok: false, what: "open-browser-use native host is not registered", fix: `"setup" registers it (open-browser-use install-manifest ${MAC || browser === "chrome" ? "--browser chrome" : `--output ${f}`})` };
  try {
    const host = JSON.parse(readFileSync(f, "utf8")).path;
    if (!existsSync(host)) return { ok: false, what: `open-browser-use native host points at a missing file (${host})`, fix: `run "setup" again to re-register it (it moves when Node or npm's prefix changes)` };
  } catch {}
  return { ok: true, what: `open-browser-use native host registered (${f})` };
}

export async function extensionCheck(cfg) {
  const b = new ObuBrowser(cfg, "check");
  try {
    const tabs = await b.userTabs();
    if (b.scanned) return { ok: true, warn: true, what: `open-browser-use extension connected (${tabs.length} tabs; found by socket scan: ${b.scanned})`, fix: "optional: disable and re-enable the extension so its native host rewrites active.json" };
    return { ok: true, what: `open-browser-use extension connected (${tabs.length} tabs)` };
  } catch (e) {
    const name = cfg.tabs?.browser === "chrome" ? "Chrome" : "Brave";
    return { ok: false, human: true, what: `open-browser-use extension is not connected: ${e.message}`, fix: `in ${name}, install Open Browser Use from ${OBU_STORE} (one profile, the one agents should use), then quit and reopen ${name}` };
  } finally {
    await b.close();
  }
}

// doctor --json (1.1+) reads permissions without opening onboarding; plain doctor opens it when
// something is missing, which setup uses on purpose.
export async function ocuPermissions(cfg) {
  const fix = 'run "open-computer-use doctor" on this Mac and grant Accessibility and Screen Recording to Open Computer Use in System Settings > Privacy & Security';
  const r = await run(findOcu(cfg), ["doctor", "--json"], 30_000);
  let ax, sr;
  try {
    const j = JSON.parse(r.stdout);
    ax = j.accessibilityTrusted ? "granted" : "missing";
    sr = j.screenCaptureGranted ? "granted" : "missing";
  } catch {
    const m = /accessibility=(\w+), screenRecording=(\w+)/.exec(r.stdout + r.stderr);
    if (!m) return { ok: false, what: `open-computer-use doctor failed: ${lastLine(r.stderr || r.stdout) || `exit ${r.code}`}`, fix: `npm i -g open-computer-use@${ENGINES["open-computer-use"].pin}` };
    [, ax, sr] = m;
  }
  const ok = ax === "granted" && sr === "granted";
  return { ok, human: !ok, what: `open-computer-use permissions: Accessibility ${ax}, Screen Recording ${sr}`, fix };
}
export const ocuOnboard = (cfg) => run(findOcu(cfg), ["doctor"], 60_000);

export async function adPermissions(cfg) {
  const r = await run(findAd(cfg), ["permissions"], 30_000);
  let p = null;
  try { p = JSON.parse(r.stdout).data; } catch {}
  if (!p) return { ok: false, what: `agent-desktop permissions check failed: ${lastLine(r.stderr || r.stdout) || `exit ${r.code}`}`, fix: `npm i -g agent-desktop@${ENGINES["agent-desktop"].pin}` };
  const ax = p.accessibility?.state;
  const sr = p.screen_recording?.state;
  return {
    ok: ax === "granted", warn: ax === "granted" && sr !== "granted", human: ax !== "granted",
    what: `agent-desktop permissions, as launched from here: Accessibility ${ax}, Screen Recording ${sr}`,
    fix: "macOS grants agent-desktop through the app that launches it. Grant Accessibility (and Screen Recording, for screenshots) to that app; see the README's agent-desktop section",
  };
}

export const browserId = (cfg) => BROWSER_IDS[cfg.tabs?.browser ?? "brave"];

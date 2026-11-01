# computer-use-bridge

Lets your agents (pi, Claude Code, Codex and other MCP clients) use another machine's apps and
browser tabs: your Mac's Slack or Discord, or background tabs in your logged-in Brave or Chrome on
a Mac or Linux box. The agent runs anywhere (a VPS, a VM, your laptop); the bridge runs on the
machine it controls and serves it over [Tailscale](https://tailscale.com) or SSH, with a token, an
app allowlist and a fixed set of tools.

It drives three open-source engines, which run locally and need no account:

| Engine | What it drives | Platforms |
|---|---|---|
| [open-computer-use](https://github.com/iFurySt/open-computer-use) | Apps, through accessibility plus background clicks and keys; also pixel-only apps such as games | macOS |
| [agent-desktop](https://github.com/vercel-labs/agent-desktop) (experimental) | Apps, through accessibility only, with references that fail rather than hit the wrong element | macOS |
| [open-browser-use](https://github.com/iFurySt/open-browser-use) | Browser tabs, through a browser extension: agents get their own background tabs | macOS, Linux |

## Quick start

You need Node 20 or later on both machines. On the machine agents will control:

```bash
npm i -g computer-use-bridge
computer-use-bridge setup
```

`setup` asks which engine controls apps (macOS), which apps agents may use, which browser to use
for tabs, and how clients connect (Tailscale recommended). It then installs the engines, writes the
config, installs a service that starts at login (a LaunchAgent on macOS, a systemd user unit on
Linux) and checks everything. Two steps need a person at the machine, and `setup` opens and waits
for them:

- **macOS permissions** for open-computer-use: Accessibility and Screen Recording.
- **The browser extension**: add [Open Browser Use](https://chromewebstore.google.com/detail/open-browser-use/bgjoihaepiejlfjinojjfgokghnodnhd)
  to the browser profile agents should use, then quit and reopen the browser.

On the machine your agent runs on:

```bash
npm i -g computer-use-bridge
computer-use-bridge connect my-mac          # any SSH destination: my-mac, me@100.x.y.z
```

`connect` reads the server's address and token over SSH (the token is never printed), saves the
token with mode 600 and adds `my-mac` to pi's `~/.pi/agent/mcp.json`, after a backup. `--print`
shows the configuration and the Claude Code command instead. Reload pi and the tools are there.

Non-interactive, for scripts and agents (see [AGENTS.md](AGENTS.md)):

```bash
computer-use-bridge setup --yes --apps open-computer-use --allow com.hnc.Discord,com.tinyspeck.slackmacgap \
  --tabs brave --host tailscale
computer-use-bridge status --json
```

`setup` exits 0 when everything works and 3 when a person still has to grant a permission or add
the extension; `status` lists what is left.

## Configuration

`setup` writes `~/.config/computer-use-bridge/config.json`. Run `setup` again to change it, or
edit it and restart the service (`computer-use-bridge setup --yes` rewrites and restarts it).

```json
{
  "host": "100.101.136.127",
  "port": 47800,
  "tokenFile": "/Users/me/.config/computer-use-bridge/token",
  "apps": {
    "engine": "agent-desktop",
    "allow": ["com.hnc.Discord", "com.tinyspeck.slackmacgap", "com.playstack.balatro"],
    "engineFor": { "com.playstack.balatro": "open-computer-use" }
  },
  "tabs": { "engine": "open-browser-use", "browser": "brave" }
}
```

| Key | Meaning |
|---|---|
| `host`, `port` | Listen address (default port 47800). |
| `apps.engine` | `open-computer-use`, `agent-desktop` or `off`. Linux: `off`. |
| `apps.allow` | Bundle IDs agents may control. Find one with `osascript -e 'id of app "Slack"'`. |
| `apps.engineFor` | Per-app engine, overriding `apps.engine`: e.g. games on open-computer-use while the rest use agent-desktop. |
| `tabs.engine` | `open-browser-use` or `off`. Allowing a browser in `apps.allow` is separate: that lets agents drive the browser window itself. |
| `tabs.browser` | `brave` or `chrome`: where `setup` registers the extension's native host. |
| `tunnels` | Reverse SSH tunnels, e.g. `[{"ssh": "devvm", "remotePort": 47801}]`; see below. |
| `idleMinutes` | Close a client session after this long without a request (default 30). |
| `maxSessions` | Most client sessions at once; the least recently used is closed beyond this (default 4). |
| `engineIdleMinutes` | Stop a session's engines after this long without a call (default 10; 0 never). |
| `treeMaxChars` | Most characters of a tree per result (default 20000; 0 for no limit). |
| `screenshotMaxWidth` | Screenshot width (default 1280; 0 keeps full size). |
| `tabEval` | `false` removes the `eval_tab` tool. |
| `obuCursor` | `false` hides the cursor drawn in tabs. |
| `ocuVisualCursor` | `true` shows open-computer-use's on-screen cursor for app clicks (default off). |
| `ocuCommand`, `adCommand` | Engine paths, if they are not on the service's `PATH`. |
| `adMaxDepth`, `adTimeoutMs` | agent-desktop snapshot depth (default 30) and time limit (default 15000 ms). |
| `obuSocket` | open-browser-use socket to use when several browsers run its extension (`ls /tmp/open-browser-use`). |

Configs from 0.x (`allowApps`, `appEngine`) still load; `setup` converts them.

## Choosing an app engine

- **open-computer-use** is the default. It reads accessibility trees and also clicks coordinates
  and sends keys to background windows, so it handles apps with little accessibility (games).
- **agent-desktop** acts through accessibility only, without focus or cursor movement. Its element
  references belong to one snapshot, so a list that changed returns `STALE_REF` instead of a click
  on whatever moved into place. It cannot click coordinates, double-click or drag,
  `type_text` types into the focused element only, and it sees only windows on the current desktop
  (Space) and minimized ones. **Permissions:** it has no app of its own, so macOS
  checks the app that launched it: for the service, the `node` running the bridge. Granting
  Accessibility to `node` covers every program that `node` runs, and Homebrew's ad-hoc signed
  `node` loses the grant on each upgrade. To try it, run a second server from a terminal that
  has Accessibility, on another port: `computer-use-bridge serve --config ~/.config/cub-ad/config.json`.

## Tools

**Apps** (macOS)

- `get_state(app)` returns the app's window as an accessibility tree with numbered elements.
  `launch_app` starts an allowed app in the background; `list_apps` lists the allowed ones.
- `click`, `set_value`, `scroll` and `secondary_action` act on element numbers; `screenshot` gives
  coordinates for `click` and `drag`. Actions return the window's new tree. An element number keeps
  pointing at its element as the window changes; if that element changed or is gone, the action is
  refused and the current tree returned, rather than clicking whatever took its place.
- `type_text` types into the focused text field; with none focused (a calculator, a game), letters,
  digits, space, Return, Tab and `+ - * / = .` are pressed as keys. `press_key` takes xdotool
  syntax: `Return`, `super+a`.
- `batch` runs up to 25 actions in one call.

**Browser tabs**

- `open_tab(url)` opens a background tab in the agent's own tab group, in the browser window you
  used last. `navigate_tab` and `close_tab` work on agent tabs. Pass `tab` instead of `app` to
  `get_state`, `screenshot`, `batch` and the actions.
- `read_tab` returns page text or HTML; `eval_tab` evaluates an expression that may not change
  anything.
- `tab_locator` clicks, fills or reads elements by CSS, role, text, label, placeholder or test ID.
- `press_key` with `hold: "down"` keeps a key pressed in a tab until `hold: "up"` or `release`.
- `list_tabs` lists agent tabs and, by title and URL only, your own.

Agents can only act on tabs they opened. Your tabs are never attached, grouped or changed, and each
client session (a pi session, a subagent, a `stdio` process) has its own tab group, so agents cannot
act on each other's tabs either.

**Session**: `release` lets go of held keys, detaches agent tabs (they stay open) and stops the
engines; the bridge also does this after `engineIdleMinutes`. The next call restarts them.

Each result shows at most 20,000 characters of a tree; call `get_state` with `max_chars: 0` for all
of it. Screenshots are scaled to 1280 px wide.

### Limits

- open-computer-use brings an app to the front to read a window that is minimized or on another
  desktop (Space); agent-desktop cannot see such a window at all.
- In apps, `scroll` needs an element, and some lists ignore it (Discord's conversation list).
- Agent input goes to the same windows you use, so your input and the agent's can interleave.
- Tabs render in the background, but real-time games need their tab in front to run at full speed.

## Safety

- The HTTP server listens only on the address you chose, requires the token, and rejects requests
  from web browsers.
- Clients can only act on allowed apps and on tabs they opened. Shells, script runners, password
  managers, Keychain, System Settings, Mail and Messages are always blocked.
- Clients send parameters, not code. The one exception is `eval_tab`: the browser evaluates its
  expression in the page and refuses anything with side effects. `tabEval: false` removes it.

## Commands

| Command | What it does |
|---|---|
| `setup` | Configure, install engines and the service, check everything. `--yes` takes defaults; flags: `--apps`, `--allow`, `--engine-for ID=ENGINE,...`, `--tabs`, `--host`, `--port`, `--tunnel`, `--no-service`, `--no-install`. |
| `status [--json]` | Check the config, engines, permissions, extension, service and server; print fixes. |
| `update` | `npm i -g computer-use-bridge@latest`, then install that release's tested engine versions and restart the service. |
| `connect HOST` | On a client: add the server at SSH destination `HOST` to pi. `--name`, `--print`, `--pi-config`, `--remote-config`, `--remote-bin`, `--tunnel-name`. |
| `serve`, `stdio` | Run the HTTP server (what the service runs), or speak MCP on stdin/stdout. |

## Remote machines over SSH

For a client that can't reach the machine, such as a VM behind a one-way VPN, the bridge can open
a reverse SSH tunnel to it; the server then appears at `http://127.0.0.1:<port>/mcp` on the VM. Run
`setup` and choose "a remote machine over SSH", or `setup --tunnel devvm:47801`.

- The bridge machine must log in to the VM with an SSH key, without prompts (on a Mac, keep a key's
  passphrase in the Keychain: `UseKeychain yes` and `AddKeysToAgent yes` in `~/.ssh/config`).
- `setup` can copy the token to the VM; `connect` on the VM then picks the tunnel's port.
- Other users of a shared VM can reach the port but still need the token, so give each person
  their own port. The tunnel reconnects on its own; `status` shows whether it is up.

A server that listens on `127.0.0.1` without tunnels is reached over SSH instead: `connect` then
configures pi to run `computer-use-bridge stdio` over SSH.

## Upgrading from 0.x (Homebrew)

```bash
npm i -g computer-use-bridge
computer-use-bridge setup                     # converts the config, keeps the token, replaces the service
brew uninstall computer-use-bridge && brew untap hank-warren/computer-use-bridge
```

`setup` stops the Homebrew service (it holds the same port) and keeps your token, so clients keep
working.

## Troubleshooting

- `computer-use-bridge status` checks everything and prints fixes.
- Logs: `tail -f ~/Library/Logs/computer-use-bridge.log` on macOS,
  `journalctl --user -u computer-use-bridge -f` on Linux.
- **"the service runs .../node, which no longer exists"**: Node was upgraded or switched (nvm);
  run `computer-use-bridge setup --yes`.
- **Linux: the service stops at logout**: `sudo loginctl enable-linger $USER`.
- **"open-browser-use is not connected"**: the browser isn't running, or the extension isn't
  installed and enabled. Quit and reopen the browser.
- **"connected ... by socket scan"**: macOS's `/tmp` cleaner removed
  `/tmp/open-browser-use/active.json`; the bridge finds the live socket itself. Disabling and
  re-enabling the extension rewrites it. With several browsers running the extension, set
  `obuSocket`.
- **"not an agent tab"**: agents can only use tabs they opened; use `open_tab`.
- **"Grouping is not supported by tabs in this window"**: the last window you used is an installed
  web app. Click into an ordinary browser window and retry.

## Development

```bash
npm test                                   # engine-free tests (CI runs them on macOS and Linux)
node dev/live-test.mjs -- node bin/computer-use-bridge.mjs stdio --config ./config.json
node dev/mcp-call.mjs --list '[]' -- node bin/computer-use-bridge.mjs stdio --config ./config.json
```

`dev/live-test.mjs` runs every tool against real engines (Calculator for apps, example.com and
httpbin.org for tabs; the config must allow `com.apple.calculator`). `dev/mcp-call.mjs` is a small
MCP client for calling a server by hand. Both work over SSH on the machine under test.
[AGENTS.md](AGENTS.md) has the layout, conventions and release steps.

## License

MIT

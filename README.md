# computer-use-bridge

Lets your agents (pi, Claude Code, Codex and other MCP clients) use another machine's apps and
browser tabs: your Mac's Slack or Discord, or background tabs in your logged-in Brave or Chrome on
a Mac or Linux box. The agent runs anywhere (a VPS, a VM, your laptop); the bridge runs on the
machine it controls and serves it over [Tailscale](https://tailscale.com) or SSH, with a token and
an app allowlist.

The bridge is a remote doorway to two open-source engines that run locally and need no account.
Agents get each engine's own MCP tools, unchanged, as if it ran on their machine:

| Engine | What it drives | Platforms |
|---|---|---|
| [open-computer-use](https://github.com/iFurySt/open-computer-use) | Apps, through accessibility plus background clicks and keys; also pixel-only apps such as games | macOS |
| [open-browser-use](https://github.com/iFurySt/open-browser-use) | Browser tabs, through a browser extension | macOS, Linux |

## Quick start

You need Node 20 or later on both machines. On the machine agents will control:

```bash
npm i -g computer-use-bridge
computer-use-bridge setup
```

`setup` asks whether agents may control apps (macOS) and which ones, which browser to use
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
  "apps": { "engine": "open-computer-use", "allow": ["com.hnc.Discord", "com.tinyspeck.slackmacgap"] },
  "tabs": { "engine": "open-browser-use", "browser": "brave" }
}
```

| Key | Meaning |
|---|---|
| `host`, `port` | Listen address (default port 47800). |
| `apps.engine` | `open-computer-use` or `off`. Linux: `off`. |
| `apps.allow` | Bundle IDs agents may control. Find one with `osascript -e 'id of app "Slack"'`. |
| `tabs.engine` | `open-browser-use` or `off`. Allowing a browser in `apps.allow` is separate: that lets agents drive the browser window itself. |
| `tabs.browser` | `brave` or `chrome`: where `setup` registers the extension's native host. |
| `tunnels` | Reverse SSH tunnels, e.g. `[{"ssh": "devvm", "remotePort": 47801}]`; see below. |
| `idleMinutes` | Close a client session after this long without a request (default 30). |
| `maxSessions` | Most client sessions at once; the least recently used is closed beyond this (default 4). |
| `engineIdleMinutes` | Stop a session's engines after this long without a call (default 10; 0 never). The next call starts them again. |
| `ocuVisualCursor` | `true` shows open-computer-use's on-screen cursor for app clicks (default off). |
| `ocuCommand`, `obuCommand` | Engine paths, if they are not on the service's `PATH`. |
| `obuSocket` | open-browser-use socket to use when several browsers run its extension (`ls /tmp/open-browser-use`). |

The engines have their own settings too. For example, open-computer-use's screenshot format and
size: `ocu config set image.format jpg` (see its
[configuration](https://github.com/iFurySt/open-computer-use/blob/main/docs/configuration.md)).

Older configs still load; `setup` converts them: 0.x `allowApps`, and 1.x `agent-desktop` and the
settings of 1.x's own tools, which are dropped.

## Tools

Each client session gets its own `open-computer-use mcp` and `open-browser-use mcp` processes on
the server, and the client sees their tools, descriptions and server instructions exactly as the
engines publish them:

- **open-computer-use** (macOS): `list_apps`, `get_app_state`, `click`, `type_text`, `press_key`,
  `scroll`, `set_value`, `drag`, `perform_secondary_action`, `query`.
- **open-browser-use**: `open_tab`, `navigate`, `wait_load`, `page_info`, `cdp`, `run_action_plan`,
  `tabs`, `user_tabs`, `claim_tab`, `history`, `finalize_tabs`, `name_session`, `turn_ended`, file
  chooser tools, `move_mouse`, `call`, `ping`, `info`.

Read the engines' documentation for how to use them. The bridge changes only this:

- Every open-computer-use call names its app, which must be in `apps.allow` (by bundle ID or app
  name) and not on the hard-deny list; `list_apps` lists allowed apps only. An open-computer-use
  tool that takes no app could not be checked, so it is not offered.
- Each client session has its own open-browser-use session, and so its own tab group.

The bridge pins the engine versions it was tested with (`setup` installs them), so a new engine
release reaches agents after it passes the bridge's live test.

## Safety

- The HTTP server listens only on the address you chose, requires the token, and rejects requests
  from web browsers.
- App control is limited to allowed apps. Shells, script runners, password managers, Keychain,
  System Settings, Mail and Messages are always blocked, even if listed.
- Browser tabs are open-browser-use's full tool set, as it runs locally: agents can list your tabs,
  claim one, search your history and run DevTools commands in the tabs they manage. Use a browser
  profile you are willing to share with agents, or set `tabs.engine` to `off`.

## Commands

| Command | What it does |
|---|---|
| `setup` | Configure, install engines and the service, check everything. `--yes` takes defaults; flags: `--apps`, `--allow`, `--tabs`, `--host`, `--port`, `--tunnel`, `--no-service`, `--no-install`. |
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

## Upgrading from 1.x

`computer-use-bridge update` installs 2.0 and converts the config. Agents see the engines' own
tools instead of 1.x's (`get_state` is now `get_app_state`, tabs use `open_tab`, `page_info` and
`cdp`, and there is no `batch` or `release`), so reload them after updating.

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
- **Several browsers run the extension**: set `obuSocket` to the one agents should use.
- **"app not allowed"**: add the app's bundle ID to `apps.allow` and restart the service.

## Development

```bash
npm test                                   # engine-free tests (CI runs them on macOS and Linux)
node dev/live-test.mjs -- node bin/computer-use-bridge.mjs stdio --config ./config.json
node dev/mcp-call.mjs --list '[]' -- node bin/computer-use-bridge.mjs stdio --config ./config.json
```

`dev/live-test.mjs` checks the native tools through the bridge against real engines (Calculator for
apps, example.com for tabs; the config must allow `com.apple.calculator`) and the allowlist. `dev/mcp-call.mjs` is a small
MCP client for calling a server by hand. Both work over SSH on the machine under test.
[AGENTS.md](AGENTS.md) has the layout, conventions and release steps.

## License

MIT

# AGENTS.md: computer-use-bridge

computer-use-bridge lets MCP clients (pi, Claude Code, Codex) use one machine's apps (macOS) and
browser tabs (macOS, Linux). There are two roles: the **server**, the machine agents will
control, and the **client**, the machine the agent runs on. Both need Node 20+ and the npm package.

## Setting it up for a user

Ask the user before you start: which machine is the server, which apps agents may control (macOS
bundle IDs; never add apps they did not name), and which browser (`brave` or `chrome`) for tabs.

On the server:

```bash
node -v                                   # 20 or later; if not, ask before installing or switching Node
npm i -g computer-use-bridge
computer-use-bridge setup --yes --apps open-computer-use --allow com.hnc.Discord --tabs brave --host tailscale
# Linux: --apps off (apps are macOS only)
computer-use-bridge status --json
```

`setup` installs the engines at their tested versions, writes `~/.config/computer-use-bridge/config.json`,
installs and starts the service and runs the checks. Exit 0 means ready; exit 3 means a person must
act, listed under "Needs a person". Only the user can do these; relay them, then re-run
`status --json` until `ok` is true:

- macOS: grant Accessibility and Screen Recording to Open Computer Use (`open-computer-use doctor`
  opens the prompts).
- Add the Open Browser Use extension to the browser profile agents should use, then quit and reopen
  the browser.
- Linux: `sudo loginctl enable-linger $USER`, so the service survives logout. Ask before using sudo.

On the client (it must reach the server by SSH key login):

```bash
npm i -g computer-use-bridge
computer-use-bridge connect <ssh-destination>      # adds it to ~/.pi/agent/mcp.json (backed up first)
computer-use-bridge connect <ssh-destination> --print   # Claude Code or other clients
```

Then the user reloads pi. Rules while doing this:

- Never print, `cat`, echo or paste the token. `connect` moves it over SSH into a mode-600 file.
- Do not run any of it with `sudo`, and do not hand-edit the LaunchAgent or systemd unit: run
  `setup --yes` again.
- agent-desktop (`--apps agent-desktop`) needs Accessibility granted to the app that launches the
  bridge; read the README's "Choosing an app engine" before offering it.

## Working on the code

| Path | What |
|---|---|
| `bin/computer-use-bridge.mjs` | CLI entry. |
| `src/config.mjs` | Arguments, config v2 (`apps`, `tabs`), 0.x migration, validation. |
| `src/session.mjs` | One MCP session: tools to engines, the allowlist, own-tabs-only. |
| `src/server.mjs` | HTTP (bearer token) and stdio transports, reverse SSH tunnels. |
| `src/tools.mjs` | Tool schemas and argument checks. |
| `src/engines/*.mjs` | Engine adapters (open-computer-use, agent-desktop, open-browser-use) and `install.mjs`: tested versions (`ENGINES` pins), installs, permission and extension checks. |
| `src/service.mjs` | LaunchAgent (macOS) and systemd user unit (Linux). |
| `src/setup.mjs`, `src/connect.mjs` | `setup`, `status`, `update`; `connect` and `client-info`. |
| `dev/logic-test.mjs` | Engine-free tests with fake engines; `npm test`. CI runs it on macOS and Linux. |
| `dev/live-test.mjs` | Every tool against real engines over stdio or HTTP: Calculator for apps, public pages for tabs. |
| `dev/mcp-call.mjs` | Small MCP client for driving a server over stdio by hand. |

- **The security boundary is the product.** `HARD_DENY` (in `src/common.mjs`) and `apps.allow`
  gate every app call; agents act only on tabs they opened; the HTTP token comparison stays
  constant-time; clients never send code. `.github/pi/review.md` lists what review blocks on.
- **Engine output contracts.** Changing how engine output is parsed (`list_apps` lines,
  `doctor --json`, trees and their focus line, agent-desktop envelopes, open-browser-use messages)
  needs a test in `dev/logic-test.mjs`. Bump an `ENGINES` pin only after `dev/live-test.mjs`
  passes against the new version.
- **Element numbers belong to the tree the client saw.** open-computer-use renumbers on every call,
  so its adapter maps numbers to the engine's latest tree (`ocuRemap`) and refuses an element that
  changed; agent-desktop's refs and tab DOM nodes stay put by themselves.
- **Config compatibility.** Older config files must keep loading: extend `migrateConfig`.
- **Live tests never touch the user's running service.** `npm pack`, copy the tarball to the
  target, `npm i -g --prefix /tmp/cubtest <tgz>`, then `setup --yes --no-service --config
  /tmp/cubtest/config.json --port 47899` and `dev/live-test.mjs` over SSH against
  `.../bin/computer-use-bridge.mjs stdio --config /tmp/cubtest/config.json` (allow
  `com.apple.calculator`). agent-desktop needs a server started from a terminal with Accessibility;
  test it with `--url` and `--token-file`. Clean up afterwards.
- **Versions** live only in `package.json`.

## Releasing

1. Bump `version` in `package.json` in the pull request and merge it.
2. `git tag vX.Y.Z origin/main && git push origin vX.Y.Z`. The release workflow checks the tag
   matches `package.json`, creates the GitHub release and publishes to npm through trusted
   publishing (no token; provenance attached).
3. On each server: `computer-use-bridge update`.

The Homebrew formula in `Formula/` is deprecated at 0.6.0 and is no longer updated.

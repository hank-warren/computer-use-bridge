# AGENTS.md: computer-use-bridge

computer-use-bridge lets MCP clients (pi, Claude Code, Codex) use one machine's apps (macOS) and
browser tabs (macOS, Linux) through the native MCP servers of open-computer-use and
open-browser-use, when the agent runs elsewhere. There are two roles: the **server**, the machine agents will
control, and the **client**, the machine the agent runs on. Both need Node 20+ and the npm package.

## Setting it up for a user

The README's "Quick start" is the full procedure; follow it. In short:

1. **Ask first:** where the agent runs, which machine it should control, which apps agents may
   control (macOS bundle IDs, from `osascript -e 'id of app "Slack"'`; never add apps they did not
   name), which browser (`brave` or `chrome`), and which agent client (pi, Claude Code, Codex).
2. **Same machine?** If the agent runs on the machine it controls, do not install the bridge: set up
   the engines directly (README, "Do you need the bridge?").
3. **Prerequisites** (README, "Before you start"): Node 20+ on both machines (ask before installing
   or switching Node), `npm i -g` without sudo (fix `EACCES` with an npm prefix in the home
   directory, never `sudo npm`), the client reaching the server (Tailscale), and SSH key login from
   client to server (on a Mac server, Remote Login). Check SSH with
   `ssh -o BatchMode=yes <server> true` before going on; the user does any step needing a password,
   sudo or a GUI.
4. **Server:**

   ```bash
   npm i -g computer-use-bridge
   computer-use-bridge setup --yes --apps open-computer-use --allow <ids> --tabs brave --host tailscale
   # Linux: --apps off (apps are macOS only)
   computer-use-bridge status --json
   ```

   Exit 0 means ready; exit 3 means something needs attention. For the items under "Needs a
   person", relay them to the user, then re-run `status --json` until `ok` is true:
   - macOS: grant Accessibility and Screen Recording to Open Computer Use
     (`open-computer-use doctor` opens the prompts).
   - Add the Open Browser Use extension to the browser profile agents should use, then quit and
     reopen the browser.
   - Linux: `sudo loginctl enable-linger $USER`, so the service survives logout. Ask before using
     sudo.
5. **Client:** `computer-use-bridge connect <ssh-destination> --name <name>` registers it with pi
   (without `--name`, the name is the server's hostname). For Claude Code or Codex, use
   `connect <ssh-destination> --name <name> --print`, then the README's `claude mcp add` or
   `codex mcp add` command; for Codex, the token's environment variable must be set where Codex
   starts.
6. **Verify:** after the user restarts or reloads the agent, call `list_apps` (when apps are on) and
   `ping` (when tabs are on) through the new server.

Rules while doing this:

- Never print, `cat`, echo or paste the token. `connect` moves it over SSH into a mode-600 file; the
  README's client commands read it from that file.
- Do not run any of it with `sudo`, and do not hand-edit the LaunchAgent or systemd unit: run
  `setup --yes` again.
- To remove it: `computer-use-bridge uninstall` on the server, then remove each client's entry.

## Working on the code

**Keep the bridge dead simple: it is a remote transport for the engines' own MCP servers.** Agents
must get `ocu mcp` and `obu mcp` tools exactly as those engines publish them. Do not add, rename,
wrap or re-describe tools, reshape results, or work around engine behaviour in the bridge; report
engine bugs upstream and bump the pin when they are fixed. The bridge's own logic is limited to
transport (HTTP with a token, stdio, tunnels), sessions and engine processes, the app allowlist,
and setup/status/update/service.

| Path | What |
|---|---|
| `bin/computer-use-bridge.mjs` | CLI entry. |
| `src/config.mjs` | Arguments, config v2 (`apps`, `tabs`), 0.x migration, validation. |
| `src/session.mjs` | One MCP session: starts the engines' MCP servers, passes their tools through, applies the app allowlist. |
| `src/server.mjs` | HTTP (bearer token) and stdio transports, reverse SSH tunnels. |
| `src/engines/mcp-child.mjs` | MCP client for an engine's stdio server. |
| `src/engines/native.mjs` | How each engine's server is found and started. |
| `src/engines/install.mjs` | Tested versions (`ENGINES` pins), installs, permission and extension checks. |
| `src/service.mjs` | LaunchAgent (macOS) and systemd user unit (Linux). |
| `src/setup.mjs`, `src/connect.mjs` | `setup`, `status`, `update`; `connect` and `client-info`. |
| `dev/logic-test.mjs` | Engine-free tests with fake engines and a fake MCP server; `npm test`. CI runs it on macOS and Linux. |
| `dev/live-test.mjs` | The native tools through the bridge against real engines over stdio or HTTP: Calculator for apps, example.com for tabs, and the allowlist. |
| `dev/mcp-call.mjs` | Small MCP client for driving a server over stdio by hand. |

- **The boundary.** `HARD_DENY` (in `src/common.mjs`) and `apps.allow` gate every
  open-computer-use call through its `app` argument, and an open-computer-use tool without `app` is
  not offered; the HTTP token comparison stays constant-time. open-browser-use's tools pass
  through in full, by decision. `.github/pi/review.md` lists what review blocks on.
- **Engine output contracts.** The bridge parses only `list_apps` lines, `doctor --json` and
  open-browser-use's `info`; changing that needs a test in `dev/logic-test.mjs`. Bump an `ENGINES`
  pin only after `dev/live-test.mjs` passes against the new version.
- **Config compatibility.** Older config files must keep loading: extend `migrateConfig`.
- **Live tests never touch the user's running service.** `npm pack`, copy the tarball to the
  target, `npm i -g --prefix /tmp/cubtest <tgz>`, then `setup --yes --no-service --config
  /tmp/cubtest/config.json --port 47899` and `dev/live-test.mjs` over SSH against
  `.../bin/computer-use-bridge.mjs stdio --config /tmp/cubtest/config.json` (allow
  `com.apple.calculator`). Test HTTP with `--url` and `--token-file`. Clean up afterwards.
- **Versions** live only in `package.json`.

## Releasing

1. Bump `version` in `package.json` in the pull request and merge it.
2. `git tag vX.Y.Z origin/main && git push origin vX.Y.Z`. The release workflow checks the tag
   matches `package.json`, creates the GitHub release and publishes to npm through trusted
   publishing (no token; provenance attached).
3. On each server: `computer-use-bridge update`.

The Homebrew formula in `Formula/` is deprecated at 0.6.0 and is no longer updated.

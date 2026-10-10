# computer-use-bridge

Lets any MCP client (pi, Claude Code, Codex, and others) control apps and
browser tabs on your Mac. Clicks and keystrokes go to an app's window in the
background without moving your cursor, and agents open their own tabs in your
browser without taking focus.

It runs on two open-source projects by iFurySt, both MIT-licensed, which run
locally and need no account:

- [open-computer-use](https://github.com/iFurySt/open-codex-computer-use)
  drives native apps through the macOS accessibility API.
- [open-browser-use](https://github.com/iFurySt/open-browser-use) drives
  browser tabs through a browser extension (Brave or Chrome).

The bridge serves them over your tailnet (or SSH) with a token, an app
allowlist and a fixed set of tools.

## Install

On the Mac you want to control you need [Homebrew](https://brew.sh). For
clients on other machines, [Tailscale](https://tailscale.com) is the easiest
way to connect.

**1. The bridge and the engines.** The formula brings Node, which the engines
install with:

```bash
brew tap hank-warren/computer-use-bridge https://github.com/hank-warren/computer-use-bridge
brew trust hank-warren/computer-use-bridge   # Homebrew 7+ requires this for third-party taps
brew install computer-use-bridge
npm i -g open-computer-use open-browser-use
```

**2. Permissions for open-computer-use.** Run it once and grant
**Accessibility** and **Screen Recording** to "Open Computer Use" when macOS
asks (System Settings > Privacy & Security):

```bash
open-computer-use
open-computer-use doctor   # should print accessibility=granted, screenRecording=granted
```

**3. Browser tabs** (optional; Brave or Chrome).

1. Register the extension's native host:

   ```bash
   open-browser-use install-manifest --browser chrome
   ```

   **Use `--browser chrome` for Brave too.** On macOS, Brave looks for
   native-messaging hosts in Chrome's folder
   (`~/Library/Application Support/Google/Chrome/NativeMessagingHosts`), not
   in its own.
2. In the browser, install
   [Open Browser Use](https://chromewebstore.google.com/detail/open-browser-use/bgjoihaepiejlfjinojjfgokghnodnhd)
   from the Chrome Web Store. Add it to just one profile: the one agents should
   use.
3. Quit and reopen the browser so the extension connects.

Skip `open-browser-use setup`, which opens Chrome. `open-browser-use profiles`
reports no profiles for Brave, because it only looks at Chrome's; that is
harmless.

**4. Set up the server:**

```bash
computer-use-bridge setup
```

`setup` asks three things:

1. **How clients connect**:
   - Tailscale (recommended)
   - Local network (plain HTTP; trusted networks only)
   - This Mac only (`127.0.0.1`)
   - A remote machine over SSH (see [Remote machines over SSH](#remote-machines-over-ssh))
2. **The port** (default 47800).
3. **Which apps clients may control.** Allow Brave or Chrome to get the tab
   tools.

It then creates a token, writes `~/.config/computer-use-bridge/config.json`,
and starts a background service (which also starts at login). It checks the
engines, printing a fix for anything missing, and prints the client
configuration. Run it again to change settings.

Other commands:

```bash
computer-use-bridge status   # check the engines, config, service and server
computer-use-bridge update   # upgrade and restart
```

**Upgrading from 0.4**, which ran on ChatGPT's engine: follow steps 1 to 3,
then run `setup` again. It keeps your settings and token and drops the old
`engine` key. ChatGPT is no longer needed.

## Connect a client

Copy the token to the client machine without printing it:

```bash
ssh <mac> 'cat ~/.config/computer-use-bridge/token' \
  | (umask 077; mkdir -p ~/.config/computer-use-bridge; cat > ~/.config/computer-use-bridge/<mac>.token)
```

**Claude Code:**

```bash
claude mcp add --transport http <mac>-cu http://<address>:47800/mcp \
  --header "Authorization: Bearer $(cat ~/.config/computer-use-bridge/<mac>.token)"
```

**pi** (`~/.pi/agent/mcp.json`, under `mcpServers`):

```json
"<mac>-cu": {
  "url": "http://<address>:47800/mcp",
  "headers": { "Authorization": "!echo Bearer $(cat ~/.config/computer-use-bridge/<mac>.token)" },
  "timeout": 120
}
```

**Over SSH** (no token needed, for clients that can already SSH to the Mac):

```json
"<mac>-cu": {
  "command": "ssh",
  "args": ["-T", "-o", "BatchMode=yes", "<mac>", "/opt/homebrew/bin/computer-use-bridge", "stdio"],
  "timeout": 180
}
```

If your tailnet uses ACLs, the client must be allowed to reach `<mac>:47800`.

## Tools

**Apps**

- `get_state(app)` returns the app's window as an accessibility tree with
  numbered elements. `launch_app` starts an allowed app in the background.
- `click`, `set_value`, `scroll` and `secondary_action` act on element
  numbers; `screenshot` gives coordinates for `click` and `drag`. Actions
  return the window's new tree.
- `type_text` and `press_key` (xdotool syntax: `Return`, `super+a`).
- `batch` runs up to 25 actions in one call.

**Browser tabs**

- `open_tab(url)` opens a background tab in the agent's tab group, in the
  browser window you used last. `navigate_tab` and `close_tab` work on agent
  tabs. Pass `tab` instead of `app` to `get_state`, `screenshot`, `batch` and
  the actions.
- `read_tab` returns page text or HTML; `eval_tab` evaluates an expression
  that may not change anything.
- `tab_locator` clicks, fills or reads elements by CSS, role, text, label,
  placeholder or test ID.
- `list_tabs` lists agent tabs and, by title and URL only, your own.

Agents can only act on tabs they opened. Your tabs are never attached,
grouped or changed. Clicks in a tab show the extension's cursor, so you can
watch what the agent does.

**Session**

- `release` detaches agent tabs (they stay open) and stops the engine. Agents
  should call it when they finish. The bridge also does this after
  `engineIdleMinutes` without a call; the next call restarts the engine in
  about a second.

Each result shows at most 20,000 characters of a tree, because a big page's
tree can run past 200,000. Call `get_state` with `max_chars: 0` for the whole
tree. Screenshots are scaled to 1280 px wide.

### Limits

- Reading an app whose window is minimized or on another Space brings that
  app to the front. Apps on the current screen are read in the background.
- In apps, `scroll` needs an element, and some lists ignore it (Discord's
  conversation list, for one).
- Agent input goes to the same windows you use, so if you use an app at the
  same time, your input and the agent's can interleave.

## Safety

- The HTTP server listens only on the address you chose, requires the token,
  and rejects requests from web browsers.
- Clients can only act on allowed apps, and in the browser only on tabs they
  opened. Shells, script runners, password managers, Keychain, System
  Settings, Mail and Messages are always blocked.
- Clients send parameters, not code. The one exception is `eval_tab`: the
  browser evaluates its expression in the page and refuses anything with side
  effects. `tabEval: false` removes the tool.

## Configuration

`setup` writes `~/.config/computer-use-bridge/config.json`. After editing it,
run `brew services restart computer-use-bridge`.

| Key | Meaning |
|---|---|
| `host`, `port` | Listen address. |
| `allowApps` | Bundle IDs clients may control. Find one with `osascript -e 'id of app "Brave Browser"'`. `com.brave.Browser` or `com.google.Chrome` turns on the tab tools. |
| `idleMinutes` | Close a client session after this long without a request (default 30). |
| `maxSessions` | Most client sessions at once; the least recently used is closed beyond this (default 4). |
| `engineIdleMinutes` | Stop a session's engine after this long without a call (default 10; 0 never). |
| `treeMaxChars` | Most characters of a tree per result (default 20000; 0 for no limit). |
| `screenshotMaxWidth` | Screenshot width (default 1280; 0 keeps full size). |
| `tabEval` | `false` removes the `eval_tab` tool. |
| `obuCursor` | `false` hides the cursor drawn in tabs. |
| `ocuVisualCursor` | `true` shows open-computer-use's on-screen cursor for app clicks (default off). |
| `ocuCommand` | Path to `open-computer-use`, if `setup` cannot find it. |
| `tunnels` | Reverse SSH tunnels, e.g. `[{"ssh": "devvm", "remotePort": 47801}]`. |

## What you'll see

- **Agent tabs** appear in the background in a tab group, in the browser
  window you used last. They stay open after `release`; close them when you
  like.
- **A debugging notice**: while an agent tab is attached, the browser says
  Open Browser Use is debugging it, until `release` or the idle stop.

## Remote machines over SSH

For a client that can't reach your Mac, such as a VM behind a one-way VPN,
the bridge can open a reverse SSH tunnel to it. The server then appears at
`http://127.0.0.1:<port>/mcp` on the VM. Run `setup` and choose "a remote
machine over SSH", or use `setup --tunnel devvm:47801`.

- Your Mac must log in to the VM with an SSH key, without prompts. If the key
  has a passphrase, store it in the Keychain (`UseKeychain yes` and
  `AddKeysToAgent yes` in `~/.ssh/config`).
- `setup` can copy the token to the VM and prints the client configuration.
- Other users of a shared VM can reach the port but still need the token, so
  give each person their own port.
- The tunnel reconnects on its own after network drops or sleep;
  `computer-use-bridge status` shows whether it is up.

## Troubleshooting

- `computer-use-bridge status` checks everything and prints fixes.
- Log: `tail -f /opt/homebrew/var/log/computer-use-bridge.log`.
- **"open-computer-use not found"**: `npm i -g open-computer-use`, or set
  `ocuCommand` to its path (`npm prefix -g` shows where npm installs).
- **"Accessibility permission is required"**: run `open-computer-use doctor`
  and grant both permissions to Open Computer Use.
- **"open-browser-use is not connected"**: the extension isn't running. Check
  that it is installed and enabled, that the native host is registered (step
  3), and quit and reopen the browser.
- **"not an agent tab"**: agents can only use tabs they opened; use
  `open_tab`.
- **"Grouping is not supported by tabs in this window"**: the last window you
  used is an installed web app. Click into an ordinary browser window and
  retry.

## Development

`dev/mcp-call.mjs` is a small MCP client for testing the bridge over stdio
without installing it:

```bash
scp computer-use-bridge.mjs mac:/tmp/cub-dev/
node dev/mcp-call.mjs --var 'tab=Opened tab (\d+)' \
  '[{"name":"open_tab","arguments":{"url":"https://example.com/"}},
    {"name":"close_tab","arguments":{"tab":"{{tab}}"}}]' \
  -- ssh -T mac /opt/homebrew/bin/node /tmp/cub-dev/computer-use-bridge.mjs stdio --config /tmp/cub-dev/config.json
```

`node dev/logic-test.mjs` runs the engine-free tests, which CI also runs.

**Releasing:** bump `VERSION` in `computer-use-bridge.mjs` in a PR and merge
it. Then tag and push the merge commit (`git tag vX.Y.Z origin/main && git
push origin vX.Y.Z`). The release workflow publishes the release and updates
the Homebrew formula.

# computer-use-bridge

Lets any MCP client (pi, Claude Code, Codex, and others) control apps on your
Mac using the computer-use engine that ships with the ChatGPT app. Clicks and
keystrokes go to an app's window in the background without moving your
cursor, and browser tabs are driven through ChatGPT's browser extension.

**Unofficial.** It relies on ChatGPT.app internals, so a ChatGPT update can
break it.

## Before you start

On the Mac you want to control:

1. **Install the [ChatGPT app for macOS](https://openai.com/chatgpt/download/)**
   in `/Applications` and sign in.
2. **Turn on Computer Use in Codex** inside the ChatGPT app, and grant the
   macOS permissions it asks for (Accessibility and Screen Recording).
3. **For browser tabs** (optional): install ChatGPT's browser extension in
   Brave, Chrome, Edge or Chromium.
4. **Quit ChatGPT.** It only has to be installed; see
   [Screen indicators](#screen-indicators).
5. **Install [Homebrew](https://brew.sh)** if you don't have it. For clients
   on other machines, [Tailscale](https://tailscale.com) is the easiest way
   to connect.

## Install

```bash
brew tap hank-warren/computer-use-bridge https://github.com/hank-warren/computer-use-bridge
brew trust hank-warren/computer-use-bridge   # Homebrew 7+ requires this for third-party taps
brew install computer-use-bridge
computer-use-bridge setup
```

`setup` asks three things:

1. **How clients connect**:
   - Tailscale (recommended)
   - Local network (plain HTTP; trusted networks only)
   - This Mac only (`127.0.0.1`)
   - A remote machine over SSH (see [Remote machines over SSH](#remote-machines-over-ssh))
2. **The port** (default 47800).
3. **Which apps clients may control.**

It then creates a token, writes `~/.config/computer-use-bridge/config.json`,
starts a background service (which also starts at login), and prints the
client configuration. Run it again to change settings.

Other commands:

```bash
computer-use-bridge status   # check the engine, config, service and server
computer-use-bridge update   # upgrade and restart
```

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

- `get_state(app)` returns the app's accessibility tree with numbered
  elements. Use `rebind: true` after its front window changes. `launch_app`
  starts an allowed app in the background.
- `click`, `set_value`, `select_text`, `scroll` and `secondary_action` act on
  element numbers; `screenshot` gives coordinates for `click` and `drag`.
  Actions return what changed in the tree.
- `type_text`, `press_key` (xdotool syntax: `Return`, `super+t`) and `paste`.
- `batch` runs up to 25 actions in one call.

**Browser tabs**

- `list_tabs`, `open_tab(url)`, `navigate_tab`, `close_tab`. Pass `tab`
  instead of `app` to `get_state`, `screenshot`, `batch` and the actions.
- `read_tab` returns page text or a DOM snapshot; `eval_tab` runs a read-only
  expression in the page.
- `tab_locator` clicks, fills or reads elements by CSS, role, text, label,
  placeholder or test ID.

**Session**

- `release` detaches tabs and stops the engine. Agents should call it when
  they finish. The bridge also does this after `engineIdleMinutes` without a
  call; the next call restarts the engine in about a second.

Each result shows at most 20,000 characters of a tree, because a big page's
tree can run past 200,000. Call `get_state` with `full: true` and
`max_chars: 0` to get the whole tree. Screenshots are scaled to 1280 px wide.

Agent input goes to the same windows you use, so if you are using an app at
the same time, your input and the agent's can interleave.

## Safety

- The HTTP server listens only on the address you chose, requires the token,
  and rejects requests from web browsers.
- Clients can only act on allowed apps. They send parameters, not code; the
  one exception is `eval_tab`, whose expression runs in the page's read-only
  sandbox (`tabEval: false` removes it). Shells, script runners, password
  managers, Keychain, System Settings, Mail and Messages are always blocked.
- `stdio --raw` gives cua_repl's own `js` tool, which runs any JavaScript as
  you. It is only available over SSH, for clients that already have a shell
  on the Mac.

## Configuration

`setup` writes `~/.config/computer-use-bridge/config.json`. After editing it,
run `brew services restart computer-use-bridge`.

| Key | Meaning |
|---|---|
| `host`, `port` | Listen address. |
| `allowApps` | Bundle IDs clients may control. Find one with `osascript -e 'id of app "Brave Browser"'`. |
| `idleMinutes` | Close a client session after this long without a request (default 30). |
| `maxSessions` | Most client sessions at once; the least recently used is closed beyond this (default 4). |
| `engineIdleMinutes` | Stop a session's engine after this long without a call (default 10; 0 never). |
| `treeMaxChars` | Most characters of a tree per result (default 20000; 0 for no limit). |
| `screenshotMaxWidth` | Screenshot width (default 1280; 0 keeps full size). |
| `tabEval` | `false` removes the `eval_tab` tool. |
| `tunnels` | Reverse SSH tunnels, e.g. `[{"ssh": "devvm", "remotePort": 47801}]`. |

## Screen indicators

Keep the ChatGPT app quit. The engine starts ChatGPT's computer-use helper by
itself.

- **ChatGPT quit:** macOS shows its purple screen-recording icon only while
  the engine is capturing.
- **ChatGPT running:** a "ChatGPT: Currently Sharing" item appears and stays
  until you choose Stop Sharing or quit ChatGPT. It lists every app captured,
  including apps that aren't allowed.

While an agent has a tab open, the browser also shows that ChatGPT is
debugging it, until `release` or the idle stop.

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

- `computer-use-bridge status` checks everything.
- Log: `tail -f /opt/homebrew/var/log/computer-use-bridge.log`.
- **"ChatGPT.app ... is required"**: ChatGPT must be in `/Applications`.
- **"no unified-computer-use plugin"**: open ChatGPT and turn on Computer Use
  in Codex.
- **"Unable to load browser request-header policy"**: a temporary problem
  inside ChatGPT's engine. Wait a few minutes and retry.
- **"Debugger unattached"**: the bridge re-attaches the tab and retries if
  that is safe. Otherwise it returns the current tree and says whether your
  action ran.
- **A password manager's autofill menu blocks a tab**: `press_key` Escape on
  the browser app.

## Development

`dev/mcp-call.mjs` is a small MCP client for testing the bridge over stdio
without installing it:

```bash
scp computer-use-bridge.mjs mac:/tmp/cub-dev/
node dev/mcp-call.mjs --var 'tab=Opened tab (\d+)' \
  '[{"name":"open_tab","arguments":{"url":"https://example.com/"}},
    {"name":"close_tab","arguments":{"tab":"{{tab}}"}}]' \
  -- ssh -T mac /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node /tmp/cub-dev/computer-use-bridge.mjs stdio
```

`node dev/logic-test.mjs` runs the engine-free tests, which CI also runs.

**Releasing:** bump `VERSION` in `computer-use-bridge.mjs` in a PR and merge
it. Then tag and push the merge commit (`git tag vX.Y.Z origin/main && git
push origin vX.Y.Z`). The release workflow publishes the release and updates
the Homebrew formula.

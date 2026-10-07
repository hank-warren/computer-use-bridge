# computer-use-bridge

Use the computer-use engine bundled with ChatGPT.app on macOS (Codex's
`cua_repl`) from any MCP client, such as pi, Claude Code or Codex on another
machine. The engine sends real clicks and keystrokes to an app's window in the
background without moving your cursor, and drives browser tabs through
ChatGPT's browser extension.

**Unofficial.** It runs the `cua_repl` entry from ChatGPT.app's
`unified-computer-use` plugin. The bridge picks up the newest plugin version
automatically, but a ChatGPT update can change the internals and break it.

## Install

On the Mac whose apps you want to control. You need ChatGPT.app with Computer
Use set up in Codex (its permissions granted). ChatGPT has to be installed but
not running; see [Screen indicators](#screen-indicators). Clients on other
machines connect over Tailscale, or over a reverse SSH tunnel when they cannot
reach this Mac.

```bash
brew tap hank-warren/computer-use-bridge https://github.com/hank-warren/computer-use-bridge
brew trust hank-warren/computer-use-bridge   # Homebrew 7+ asks you to trust third-party taps
brew install computer-use-bridge
computer-use-bridge setup
```

`setup` walks you through:

1. **How clients connect.**
   - Your Tailscale address (recommended: only your tailnet can reach it, and
     traffic is encrypted).
   - A local-network address: plain HTTP, so anyone on that network can see
     requests and the token. Use it only on a network you trust.
   - `127.0.0.1`, for clients on this Mac.
   - A remote machine over SSH, for a VM you can SSH into but that cannot
     reach this Mac, such as one behind Cloudflare WARP or another one-way
     VPN. See [Remote machines over SSH](#remote-machines-over-ssh).
2. **The port** (default 47800).
3. **Which apps clients may control**, as bundle IDs. It lists the supported
   browsers and chat apps it finds.

It then creates a random token, writes `~/.config/computer-use-bridge/config.json`,
checks that the engine works, starts the Homebrew service (which also starts at
login), and prints the client configuration for pi and Claude Code.

Run it again at any time to change these settings. For scripts:
`computer-use-bridge setup --host tailscale --port 47800 --allow com.brave.Browser,com.hnc.Discord --yes`,
or `--tunnel devvm:47801` instead of `--host` for the SSH tunnel.

### Update

```bash
computer-use-bridge update   # brew update, brew upgrade computer-use-bridge, brew services restart
```

`brew upgrade` alone installs the new version but leaves the old one running
until `brew services restart computer-use-bridge`.

### Check

```bash
computer-use-bridge status   # engine, config, token, service, listener, and a live engine probe
```

### Moving from the codex-cu-bridge install script

`setup` copies `~/.config/codex-cu-bridge` (config and token, so clients keep
working), removes the old `com.hank-warren.codex-cu-bridge` LaunchAgent and its
files, and starts the Homebrew service on the same address and port.

## Clients

`setup` prints these with your address filled in.

Copy the token to the client without printing it:

```bash
ssh <mac> 'cat ~/.config/computer-use-bridge/token' \
  | (umask 077; mkdir -p ~/.config/computer-use-bridge; cat > ~/.config/computer-use-bridge/<mac>.token)
```

**pi** (`~/.pi/agent/mcp.json`, under `mcpServers`):

```json
"<mac>-cu": {
  "url": "http://<address>:47800/mcp",
  "headers": { "Authorization": "!echo Bearer $(cat ~/.config/computer-use-bridge/<mac>.token)" },
  "timeout": 120
}
```

**Claude Code:**

```bash
claude mcp add --transport http <mac>-cu http://<address>:47800/mcp \
  --header "Authorization: Bearer $(cat ~/.config/computer-use-bridge/<mac>.token)"
```

On a tailnet with ACLs, the client must be allowed to reach `<mac>:47800`.

**Over SSH** (no listener, no token; for clients that already have a shell on the Mac):

```json
"<mac>-cu": {
  "command": "ssh",
  "args": ["-T", "-o", "BatchMode=yes", "<mac>", "/opt/homebrew/bin/computer-use-bridge", "stdio"],
  "timeout": 180
}
```

Add `--raw --approve-all` after `stdio` for the raw surface (below).

## Two surfaces

| Surface | Tools | Who should get it |
|---|---|---|
| `fixed` | Apps: `list_apps`, `launch_app`, `get_state`, `screenshot`, `click`, `type_text`, `press_key`, `paste`, `set_value`, `select_text`, `scroll`, `drag`, `secondary_action`, `batch`. Browser tabs: `list_tabs`, `open_tab`, `navigate_tab`, `close_tab`, `read_tab`, `eval_tab`, `tab_locator`. Session: `release` | Anything. No client-supplied code runs on the Mac; the bridge generates the JavaScript from validated parameters, and every call is limited to the allowed apps. `eval_tab` runs client expressions only inside the page's read-only sandbox. |
| `raw` | cua_repl's own `js`, `js_reset`, `js_add_node_module_dir` | Clients that **already have a shell** on the Mac (stdio over SSH only). `js` runs arbitrary JavaScript as the Mac user, including `child_process`. |

The bridge answers cua_repl's per-app approval prompts itself, because most MCP
clients cannot show them. In allowlist mode it accepts only per-app approvals
for allowed apps and declines audio recording, browser-history and raw-CDP
prompts. Shells, script runners, password managers, Keychain, System Settings,
Mail and Messages are always denied, even if listed. `--approve-all` (stdio
only) accepts everything. The HTTP server only offers the fixed surface with
the allowlist.

## Configuration

`~/.config/computer-use-bridge/config.json`, written by `setup`:

```json
{
  "host": "100.64.0.1",
  "port": 47800,
  "tokenFile": "/Users/you/.config/computer-use-bridge/token",
  "allowApps": ["com.brave.Browser", "com.tinyspeck.slackmacgap", "com.hnc.Discord"],
  "idleMinutes": 30,
  "maxSessions": 4,
  "engineIdleMinutes": 10
}
```

| Key | Meaning |
|---|---|
| `idleMinutes` | Close an MCP session after this long without a request. |
| `maxSessions` | Evict the least recently used session beyond this many. |
| `engineIdleMinutes` | Stop a session's engine after this long without a call (0 never stops it). See below. |
| `tunnels` | Reverse SSH tunnels, e.g. `[{"ssh": "devvm", "remotePort": 47801}]`. See [Remote machines over SSH](#remote-machines-over-ssh). |
| `screenshotMaxWidth` | Downscale screenshots to this width (default 1280; 0 keeps full size). |
| `tabEval` | `false` removes the `eval_tab` tool. |
| `treeMaxChars` | Cap on the accessibility tree in each result (default 20000; 0 for no limit). See [Result size](#result-size). |

After editing it by hand, run `brew services restart computer-use-bridge`.
Find an app's bundle ID with `osascript -e 'id of app "Brave Browser"'`.

The server listens only on `host`, requires `Authorization: Bearer <token>`,
and rejects requests with an `Origin` header (browsers).

### Sessions and the engine

Each MCP session gets its own engine process, so several agents can drive
different apps at once. While a session has browser tabs attached, the browser
shows that ChatGPT is debugging it.

MCP clients usually keep their session open for as long as they run, so the
bridge stops the engine on its own:

- **`release`**: agents should call it when they finish with computer use, or
  before waiting more than a few minutes. It detaches tabs (they stay open,
  and the debugging banner goes away) and stops the engine.
- **Idle stop**: after `engineIdleMinutes` without a call, the bridge does
  the same.

The session stays open either way, and the next call starts a new engine
(about a second). Window and tab bindings are restored automatically, but
element numbers from earlier trees are stale, so the first result after a
restart says to call `get_state` again.

### Screen indicators

Keep ChatGPT.app quit on this Mac. The bridge only needs it installed: the
engine starts ChatGPT's computer-use helper by itself.

- **ChatGPT quit:** macOS shows its small purple screen-recording icon only
  while the engine captures (each `get_state`, `screenshot` or action), and
  nothing afterwards.
- **ChatGPT running:** the helper runs under ChatGPT, and macOS shows a
  "ChatGPT: Currently Sharing" item that lists every app it has captured. It
  stays after the engine stops, `release` does not clear it, and it only goes
  away with Stop Sharing or by quitting ChatGPT. Stop Sharing is safe whenever
  no agent is in the middle of a task.

The allowlist limits which apps agents can act on. It does not limit what the
helper captures internally: with ChatGPT running, the sharing list showed other
windows on screen too.

### Remote machines over SSH

A client that cannot connect to this Mac, such as an agent on a VM that you
reach through Cloudflare WARP (traffic only flows from your Mac to the VM), can
still use the bridge through a reverse SSH tunnel. The bridge keeps
`ssh -R` open to the VM, so the server appears on the VM's own loopback:

```bash
computer-use-bridge setup   # choose "a remote machine over SSH", then give the host
```

- `setup` checks that this Mac can log in to the VM without prompts (the
  service runs in the background), connecting interactively once if needed to
  accept the host key. Use an SSH key; if it has a passphrase, store it in the
  Keychain (`UseKeychain yes` and `AddKeysToAgent yes` in `~/.ssh/config`).
- It offers to copy the token to `~/.config/computer-use-bridge/<mac>.token`
  on the VM and prints the client configuration for
  `http://127.0.0.1:<remotePort>/mcp`.
- The server itself listens on `127.0.0.1` on the Mac. The tunnel opens the
  port only on the VM's loopback. Other users of a shared VM can reach that
  port but still need the token, so give each person their own port.
- The service reconnects with backoff (2 s, doubling to 60 s) when the
  network, the VM or the laptop's sleep drops the connection, and stops the
  tunnels when it stops. `status` shows each tunnel as up or down with the
  last error.
- The tunnel uses its own SSH connection, never a shared `ControlMaster` one.
- After an unclean disconnect, the VM's SSH server may keep the old port for
  a minute; the tunnel retries until it is free. Do not kill the process
  holding that port on the VM: with Tailscale SSH it is `tailscaled` itself.

The Tailscale and SSH tunnel options are separate: without `tunnels` in the
config, nothing about SSH runs.

## Using the fixed tools

### Apps

1. `get_state(app)` binds to the app's frontmost window and returns its
   accessibility tree. Use `rebind: true` after the frontmost window changes.
   `launch_app` starts an allowed app in the background (`open -g`).
2. Act on element numbers from the latest tree with `click`, `set_value`,
   `select_text`, `scroll` or `secondary_action`, or on coordinates from
   `screenshot`. Each action returns a diff of the tree.
3. `press_key` uses xdotool syntax, e.g. `Return`, `super+t` (Cmd+T),
   `super+l` (focus the address bar). `paste` inserts long text through the
   clipboard and restores it.
4. `batch` runs up to 25 actions (plus `wait` steps) in one call and returns
   the tree once; it stops at the first failing step.

The bound window may also be the one you are using, so agent input and yours
can interleave.

### Result size

The tree of a big page or app runs to hundreds of thousands of characters (a
Wikipedia article is about 200,000), which would fill an agent's context in a
few calls. Every result keeps only the first `treeMaxChars` characters of each
tree (default 20,000) and says how much it left out. Element numbers in the
part shown stay valid. For more, call `get_state` with `max_chars` (0 for the
whole tree); for page content, `read_tab` and `tab_locator` are more precise.

Clients that call tools from code (pi's codemode, for example) can filter
large results before they reach the model, which is how ChatGPT itself uses
the engine; the cap protects clients that pass results straight through.

Screenshots are downscaled to `max_width` (default 1280) with `sips` before
they leave the Mac. Coordinates a client sends back refer to the image it
received; the bridge maps them to the window.

### Browser tabs

For web pages in an allowed browser (Brave, Chrome, Edge or Chromium with
ChatGPT's browser extension connected), work on tabs instead of the window:

- `list_tabs` lists open tabs; `open_tab(url)` opens a new one and returns
  its tab ID. Pass `tab` instead of `app` to `get_state`, `screenshot`,
  `batch` and every action. Tabs keep working when you switch windows.
- `navigate_tab` (goto, back, forward, reload) and `close_tab`.
- `read_tab` returns the visible text (optionally of a CSS selector) or a DOM
  snapshot. `eval_tab` evaluates an expression in the page's read-only
  sandbox: DOM reads only, with no writes, events, cookies, storage or
  network.
- `tab_locator` acts through Playwright locators (CSS, role and name, text,
  label, placeholder or test ID): click, fill, type, press, check, select an
  option, or read text or a count.

How tabs are handled, and why:

- `open_tab` opens an ordinary tab with Cmd+T, types the URL into the address
  bar (pasting it through the clipboard, which is restored) and attaches only
  once the tab is on the real page. It takes about 3 s, or about 6 s as the
  first browser call of a new engine.
  - The engine's own `createBrowserTab` (what ChatGPT uses) is faster once warm,
    but always puts the tab in a tab group, and it took 12-20 s on about one in
    three new engines.
  - Attaching while the tab was still on the browser's new-tab page sometimes
    hung for about 20 s or left the tab with a dead debugger.
  - It refreshes the window's state before pressing keys, because the engine
    refuses input to a window that changed since it last looked (e.g. after
    you used the browser).
- If a tab's debugger detaches ("Debugger unattached"), the bridge re-attaches
  and retries the call once. If that fails too, the dead attachment belongs to
  the session's engine (a new engine attaches the same tab fine), so the bridge
  restarts the engine and retries once more. A batch is only retried if nothing
  in it ran yet.
- A tab attached by one session is locked to it until that session's engine
  stops (`release`, idle stop, or the session closing). If the engine dies
  without that, its tabs can only be closed by hand.
- `javascript:` URLs are refused by the browser policy, and `evaluate` is
  read-only, so there is no way to hold keys down or run page scripts with
  side effects.
- A password manager's inline autofill menu blocks tab automation on that
  page until it closes; `press_key` Escape on the browser app dismisses it.

macOS has no window inventory in cua_repl, so there is no tool to pick a
window by title; use tabs for the browser and `rebind` for other apps.

## Troubleshooting

- `computer-use-bridge status` checks everything at once.
- `tail -f /opt/homebrew/var/log/computer-use-bridge.log` shows sessions,
  approvals, engine starts and stops, and rejected requests.
- `curl http://<address>:47800/healthz` checks the listener without a token;
  with the token it also reports SSH tunnels.
- The service retries until the listen address exists, e.g. until Tailscale
  is up after login.
- `no unified-computer-use plugin`: open ChatGPT.app and set up Computer Use
  in Codex.

## Development

`dev/mcp-call.mjs` is a minimal MCP client for exercising the bridge over
stdio without installing it, e.g. from another machine:

```bash
scp computer-use-bridge.mjs mac:/tmp/cub-dev/
node dev/mcp-call.mjs --list --var 'tab=Opened tab (\d+)' \
  '[{"name":"open_tab","arguments":{"url":"https://example.com/"}},
    {"name":"read_tab","arguments":{"tab":"{{tab}}"}},
    {"sleep":1000},
    {"name":"close_tab","arguments":{"tab":"{{tab}}"}}]' \
  -- ssh -T mac /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node /tmp/cub-dev/computer-use-bridge.mjs stdio
```

`--var` captures a value from any result for `{{name}}` (or a number for a
quoted `"{{#name}}"`) in later calls; `{"sleep": ms}` pauses; images are saved
under `--out`.

### Releasing

1. Bump `VERSION` in `computer-use-bridge.mjs` in a PR and merge it.
2. Tag the merge commit on `main` and push the tag:
   `git tag v0.4.0 origin/main && git push origin v0.4.0`.

The release workflow checks that the tag matches `VERSION`, creates the GitHub
release, and commits the new tarball URL and checksum to
`Formula/computer-use-bridge.rb` on `main`. Macs pick it up with
`computer-use-bridge update`.

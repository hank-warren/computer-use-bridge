# codex-cu-bridge

Use the Codex computer-use engine bundled with ChatGPT.app on macOS
(`cua_repl`) from other MCP clients, such as pi or Claude Code on another machine.
The engine sends real clicks and keystrokes to an app's window in the background
without moving your cursor.

**Unofficial.** It launches the `cua_repl` entry from ChatGPT.app's
`unified-computer-use` plugin. The bridge picks up the newest plugin version
automatically, but a ChatGPT update can change the internals and break it.

## Two surfaces

| Surface | Tools | Who should get it |
|---|---|---|
| `raw` | cua_repl's own `js`, `js_reset`, `js_add_node_module_dir` | Clients that **already have a shell** on the Mac. `js` runs arbitrary JavaScript as the Mac user (including `child_process`), so it is equivalent to shell access. |
| `fixed` | Apps: `list_apps`, `launch_app`, `get_state`, `screenshot`, `click`, `type_text`, `press_key`, `paste`, `set_value`, `select_text`, `scroll`, `drag`, `secondary_action`, `batch`. Browser tabs: `list_tabs`, `open_tab`, `navigate_tab`, `close_tab`, `read_tab`, `eval_tab`, `tab_locator` | Anything else. No client-supplied code runs on the Mac; the bridge generates the JavaScript from validated parameters, and every call is limited to the `allowApps` bundle IDs. `eval_tab` runs client expressions only inside the page's read-only sandbox (see below). |

The bridge answers cua_repl's per-app approval prompts itself, because most
MCP clients cannot show them. Use `--approve-all` to accept every app, or the
allowlist mode, which accepts only per-app approvals for `allowApps`. The
allowlist mode declines audio recording, browser-history and raw-CDP prompts.
Shells, script runners, password managers, Keychain, System Settings, Mail and
Messages are hard-denied in allowlist mode, even if listed.

The HTTP server (`serve`) only offers the fixed surface with the allowlist.

## Install on a Mac

Requirements: ChatGPT.app with Codex computer use set up (its permissions
granted), and Tailscale if remote clients will use HTTP. No other dependencies:
the bridge runs on ChatGPT.app's bundled Node.

```bash
git clone git@github.com:hank-warren/codex-cu-bridge.git && cd codex-cu-bridge
./install.sh                 # stdio command + always-on HTTP LaunchAgent
./install.sh --stdio-only    # stdio command only (SSH clients), no listener
./install.sh --uninstall     # remove the LaunchAgent and program (keeps config/token)
```

`install.sh` installs:

- `~/.local/share/codex-cu-bridge/codex-cu-bridge.mjs` and the
  `~/.local/bin/codex-cu-bridge` launcher.
- On first run, `~/.config/codex-cu-bridge/config.json` and a random `token`
  (mode 600). Re-running keeps both.
- The LaunchAgent `com.hank-warren.codex-cu-bridge`, logging to
  `~/Library/Logs/codex-cu-bridge.log`.

Options: `--port` (default 47800), `--host` (default: this Mac's Tailscale IPv4)
and `--allow "id,id"` (default Brave, Slack, Discord). The options only apply
when the config is first created; after that, edit `config.json` and re-run
`./install.sh` to restart:

```json
{
  "host": "100.101.136.127",
  "port": 47800,
  "tokenFile": "/Users/hank/.config/codex-cu-bridge/token",
  "allowApps": ["com.brave.Browser", "com.tinyspeck.slackmacgap", "com.hnc.Discord"],
  "idleMinutes": 30,
  "maxSessions": 4
}
```

Optional keys: `screenshotMaxWidth` (default 1280; 0 keeps full-size
screenshots) and `tabEval: false` to remove the `eval_tab` tool.

Find an app's bundle ID with `osascript -e 'id of app "Brave Browser"'`.

The server listens only on `host`. It requires `Authorization: Bearer <token>`
and rejects requests that carry an `Origin` header (browsers). Each MCP session
gets its own cua_repl process. A session is closed after `idleMinutes` without
use, and the least recently used session is evicted beyond `maxSessions`.

## Clients

**Over SSH (raw surface, approve everything)**, e.g. pi in `~/.pi/agent/mcp.json`:

```json
"codex-cu": {
  "command": "ssh",
  "args": ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30",
           "pikachu", "/Users/hank/.local/bin/codex-cu-bridge", "stdio", "--raw", "--approve-all"],
  "timeout": 180
}
```

Without `--raw`, stdio mode offers the fixed surface. Without `--approve-all`,
it uses the config's `allowApps`.

**Over HTTP (fixed surface)**: copy the token to the client without printing
it, e.g. `ssh pikachu 'cat ~/.config/codex-cu-bridge/token' | ssh client 'umask 077; mkdir -p ~/.config/codex-cu-bridge; cat > ~/.config/codex-cu-bridge/pikachu.token'`.
Then configure pi:

```json
"pikachu-cu": {
  "url": "http://100.101.136.127:47800/mcp",
  "headers": { "Authorization": "!echo Bearer $(cat ~/.config/codex-cu-bridge/pikachu.token)" },
  "timeout": 120
}
```

The client must also be allowed to reach `<mac>:<port>` on the tailnet. For
tagged devices such as `tag:work`, that is an explicit grant in
`hank-warren/tailnet-gitops`.

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

- `open_tab` opens the tab natively (Cmd+T in the front window) and then
  attaches to it, because tabs created through the browser API always land
  in a "ChatGPT" tab group. The new tab becomes the active tab.
- A tab attached by one session is locked to it. The bridge sends
  `turn_ended` when a session closes (stdio EOF or signal, HTTP DELETE, idle
  or eviction), which releases its tabs; they stay open. If cua_repl dies
  without that, its tabs can only be closed by hand.
- `javascript:` URLs are refused by the browser policy, and `evaluate` is
  read-only, so there is no way to hold keys down or run page scripts with
  side effects.
- A password manager's inline autofill menu blocks tab automation on that
  page until it closes; `press_key` Escape on the browser app dismisses it.

macOS has no window inventory in cua_repl, so there is no tool to pick a
window by title; use tabs for the browser and `rebind` for other apps.

## Development

`dev/mcp-call.mjs` is a minimal MCP client for exercising the bridge over
stdio without installing it, e.g. from another machine:

```bash
scp codex-cu-bridge.mjs pikachu:/tmp/cub-dev/
node dev/mcp-call.mjs --list --var 'tab=Opened tab (\d+)' \
  '[{"name":"open_tab","arguments":{"url":"https://example.com/"}},
    {"name":"read_tab","arguments":{"tab":"{{tab}}"}},
    {"name":"close_tab","arguments":{"tab":"{{tab}}"}}]' \
  -- ssh -T pikachu /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node /tmp/cub-dev/codex-cu-bridge.mjs stdio
```

`--var` captures a value from any result for `{{name}}` (or a number for a
quoted `"{{#name}}"`) in later calls; images are saved under `--out`.

## Troubleshooting

- `tail -f ~/Library/Logs/codex-cu-bridge.log` shows sessions, approvals and rejected requests.
- `curl http://<host>:<port>/healthz` checks the listener without a token.
- `launchctl print gui/$(id -u)/com.hank-warren.codex-cu-bridge` shows the
  LaunchAgent state. Binding fails, and launchd retries, until Tailscale is up.
- `no unified-computer-use plugin`: open ChatGPT.app and enable Computer Use.

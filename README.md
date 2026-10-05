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
| `fixed` | `list_apps`, `get_state`, `screenshot`, `click`, `type_text`, `press_key`, `set_value`, `scroll`, `drag`, `secondary_action` | Anything else. No client-supplied code runs; the bridge generates the JavaScript from validated parameters, and every call is limited to the `allowApps` bundle IDs. |

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

1. `get_state(app)` binds to the app's frontmost window and returns its
   accessibility tree. Use `rebind: true` after the frontmost window changes.
2. Act on element numbers from the latest tree with `click`, `set_value`,
   `scroll` or `secondary_action`, or on window coordinates from `screenshot`.
   Each action returns a diff of the tree.
3. `press_key` uses xdotool syntax, e.g. `Return`, `super+t` (Cmd+T),
   `super+l` (focus the address bar).

The bound window may also be the one you are using, so agent input and yours
can interleave.

## Troubleshooting

- `tail -f ~/Library/Logs/codex-cu-bridge.log` shows sessions, approvals and rejected requests.
- `curl http://<host>:<port>/healthz` checks the listener without a token.
- `launchctl print gui/$(id -u)/com.hank-warren.codex-cu-bridge` shows the
  LaunchAgent state. Binding fails, and launchd retries, until Tailscale is up.
- `no unified-computer-use plugin`: open ChatGPT.app and enable Computer Use.

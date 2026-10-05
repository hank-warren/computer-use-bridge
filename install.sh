#!/bin/bash
# Install codex-cu-bridge for the current macOS user.
#
#   ./install.sh                     stdio command + HTTP LaunchAgent on the tailnet IP
#   ./install.sh --stdio-only        just the stdio command (SSH clients), no listener
#   ./install.sh --uninstall         remove LaunchAgent and installed files (keeps config/token)
#
# Options: --port N (default 47800), --host IP (default: this Mac's Tailscale IPv4),
#          --allow "id,id" (default Brave, Slack, Discord; only used when creating config)
set -euo pipefail

LABEL="com.hank-warren.codex-cu-bridge"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
SHARE="$HOME/.local/share/codex-cu-bridge"
BIN="$HOME/.local/bin/codex-cu-bridge"
CONF_DIR="$HOME/.config/codex-cu-bridge"
CONF="$CONF_DIR/config.json"
TOKEN="$CONF_DIR/token"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/codex-cu-bridge.log"
NODE="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"

port=47800
host=""
allow="com.brave.Browser,com.tinyspeck.slackmacgap,com.hnc.Discord"
mode="full"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) port="$2"; shift 2 ;;
    --host) host="$2"; shift 2 ;;
    --allow) allow="$2"; shift 2 ;;
    --stdio-only) mode="stdio"; shift ;;
    --uninstall) mode="uninstall"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || { echo "macOS only" >&2; exit 1; }

if [[ "$mode" == "uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST" "$BIN"
  rm -rf "$SHARE"
  echo "Removed LaunchAgent and program files. Config and token kept in $CONF_DIR."
  exit 0
fi

[[ -x "$NODE" ]] || { echo "ChatGPT.app (with computer use) not found: $NODE" >&2; exit 1; }

mkdir -p "$SHARE" "$(dirname "$BIN")"
install -m 644 "$SRC_DIR/codex-cu-bridge.mjs" "$SHARE/codex-cu-bridge.mjs"
cat > "$BIN" <<EOF
#!/bin/bash
# Runs on ChatGPT.app's bundled Node, which every Mac with Codex computer use has.
exec "$NODE" "$SHARE/codex-cu-bridge.mjs" "\$@"
EOF
chmod 755 "$BIN"
echo "Installed $BIN"

if [[ "$mode" == "stdio" ]]; then
  echo "SSH clients: ssh <this-mac> $BIN stdio --raw --approve-all"
  exit 0
fi

if [[ -z "$host" ]]; then
  ts="$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
  host="$("$ts" ip -4 2>/dev/null | head -1 || true)"
  [[ -n "$host" ]] || { echo "could not read the Tailscale IPv4; pass --host" >&2; exit 1; }
fi

mkdir -p "$CONF_DIR"
chmod 700 "$CONF_DIR"
if [[ ! -s "$TOKEN" ]]; then
  (umask 077 && openssl rand -hex 32 > "$TOKEN")
  echo "Generated token in $TOKEN"
fi
chmod 600 "$TOKEN"

if [[ ! -f "$CONF" ]]; then
  CONF="$CONF" HOST="$host" PORT="$port" TOKEN="$TOKEN" ALLOW="$allow" "$NODE" -e '
    const e = process.env;
    const cfg = { host: e.HOST, port: Number(e.PORT), tokenFile: e.TOKEN,
      allowApps: e.ALLOW.split(",").map((s) => s.trim()).filter(Boolean), idleMinutes: 30, maxSessions: 4 };
    require("fs").writeFileSync(e.CONF, JSON.stringify(cfg, null, 2) + "\n");'
  echo "Wrote $CONF"
else
  echo "Kept existing $CONF (edit it to change host, port or allowApps)"
fi

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$BIN</string><string>serve</string><string>--config</string><string>$CONF</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# bootout returns before the job is gone; bootstrapping too early fails with error 5.
for _ in $(seq 1 20); do
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Started LaunchAgent $LABEL (log: $LOG)"

sleep 2
cfg_host="$("$NODE" -e 'console.log(require(process.argv[1]).host)' "$CONF")"
cfg_port="$("$NODE" -e 'console.log(require(process.argv[1]).port)' "$CONF")"
if curl -fsS "http://$cfg_host:$cfg_port/healthz" >/dev/null; then
  echo "Listening on http://$cfg_host:$cfg_port/mcp"
else
  echo "Not answering yet on http://$cfg_host:$cfg_port; check $LOG" >&2
fi
echo "Copy $TOKEN to the client over a trusted channel; never commit it."

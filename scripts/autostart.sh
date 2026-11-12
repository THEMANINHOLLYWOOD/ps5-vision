#!/usr/bin/env bash
# Runs the bridge in the background whenever you're logged in to the Mac, so
# playing never needs a Terminal window.
#
#   npm run autostart            turn it on (and start it now)
#   npm run autostart -- off     turn it off
#   npm run autostart -- status  is it running, and where to open it
set -euo pipefail

LABEL="io.github.ps5vision.bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/ps5-vision.log"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="gui/$(id -u)"

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

show_status() {
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    echo "The bridge starts by itself when you log in, and is running now."
  else
    echo "Automatic start is off."
    return 0
  fi
  # The bridge prints where to open it and the access code when it starts.
  if [[ -f "$LOG" ]]; then
    local start
    start=$(grep -n "PS5 Vision bridge" "$LOG" | tail -1 | cut -d: -f1 || true)
    [[ -n "$start" ]] && tail -n "+$start" "$LOG" | grep -E "https://|Access code|Console:|No PS5|not built" | head -6
  fi
  echo "Log: $LOG"
}

case "${1:-on}" in
  on)
    [[ "$(uname)" == "Darwin" ]] || { echo "Automatic start is only set up for macOS."; exit 1; }
    NODE="$(command -v node)" || { echo "Node.js was not found."; exit 1; }
    mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
    cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE")</string>
    <string>$(xml_escape "$ROOT/server/index.js")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$ROOT")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- Start again if it stops by itself, but not after a normal shutdown. -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(xml_escape "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$LOG")</string>
</dict>
</plist>
EOF
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    : >"$LOG"
    launchctl bootstrap "$DOMAIN" "$PLIST"
    sleep 3
    show_status
    echo
    echo "If macOS asks whether node may find devices on your local network"
    echo "or open files in this folder, choose Allow."
    ;;
  off)
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    rm -f "$PLIST"
    echo "Automatic start is off. Use npm start to run the bridge by hand."
    ;;
  status)
    show_status
    ;;
  *)
    echo "usage: npm run autostart [-- on|off|status]"
    exit 2
    ;;
esac

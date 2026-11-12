#!/usr/bin/env bash
# Pairs your Vision Pro with this Mac from the terminal, the same way Xcode's
# Devices window does.
#
#   npm run vision:pair
#
# Put on the headset and open Settings > General > Remote Devices first. The
# headset then shows a code; type it here when asked.
set -euo pipefail

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

find_headset() {
  xcrun devicectl list devices --json-output "$WORK/devices.json" >/dev/null 2>&1 || true
  node -e '
    const fs = require("fs");
    let devices = [];
    try { devices = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).result.devices; } catch {}
    const headset = devices.find((d) => d.hardwareProperties?.platform === "visionOS"
      && d.hardwareProperties?.reality === "physical");
    if (headset) console.log(`${headset.identifier} ${headset.connectionProperties?.pairingState ?? "unknown"}`);
  ' "$WORK/devices.json"
}

echo "On the Vision Pro: open Settings > General > Remote Devices and stay there."
echo "Make sure it is on the same Wi-Fi as this Mac."
echo
echo "Looking for the headset (up to 10 minutes)…"
for _ in $(seq 1 120); do
  read -r DEVICE STATE <<<"$(find_headset)" || true
  if [[ -n "${DEVICE:-}" ]]; then
    if [[ "$STATE" == "paired" ]]; then
      echo "Your Vision Pro is already paired with this Mac."
      exit 0
    fi
    echo "Found it. Pairing… type the code the headset shows when asked."
    xcrun devicectl manage pair --device "$DEVICE"
    echo
    echo "Paired. Next: npm run vision:install"
    exit 0
  fi
  sleep 5
done
echo "The headset didn't show up. Check it is on the same Wi-Fi as this Mac and that"
echo "the Remote Devices screen is open, then run npm run vision:pair again."
exit 1

#!/usr/bin/env bash
# Builds the Vision Pro app and puts it on your headset, then opens it.
#
#   npm run vision:install
#
# Needs, once: Xcode signed in to your Apple account (Xcode > Settings >
# Accounts), and the headset paired with this Mac (on the headset: Settings >
# General > Remote Devices; on the Mac: Xcode > Window > Devices and Simulators).
#
# Your team is passed to the build, never written into the project, and the
# app gets a bundle ID of its own per team, so anyone can install their own copy.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/visionos/PS5Vision.xcodeproj"
# Outside the project folder: iCloud-synced folders (like the Desktop) add
# file attributes that code signing refuses.
DERIVED="$HOME/Library/Developer/Xcode/DerivedData/PS5Vision"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- the headset ---------------------------------------------------------
xcrun devicectl list devices --json-output "$WORK/devices.json" >/dev/null 2>&1 || true
DEVICE="$(node -e '
  const fs = require("fs");
  let devices = [];
  try { devices = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).result.devices; } catch {}
  const headset = devices.find((d) => d.hardwareProperties?.platform === "visionOS"
    && d.hardwareProperties?.reality === "physical"
    && d.connectionProperties?.pairingState === "paired");
  if (headset) console.log(headset.identifier);
' "$WORK/devices.json")"
if [[ -z "$DEVICE" ]]; then
  cat <<'EOF'
No Vision Pro is paired with this Mac yet.

1. On the headset: Settings > General > Remote Devices. Stay on that screen.
2. On the Mac: open Xcode, then Window > Devices and Simulators > Devices.
3. Click your Vision Pro on the left, click Pair, and type the code the
   headset shows. Turn on Developer Mode on the headset if it asks.

Then run npm run vision:install again.
EOF
  exit 1
fi

# --- the team ------------------------------------------------------------
TEAM="${PS5VISION_TEAM:-}"
if [[ -z "$TEAM" ]]; then
  # Xcode remembers the teams of the accounts signed in to it.
  TEAM="$(defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier 2>/dev/null \
    | grep -oE 'teamID = "?[A-Z0-9]{10}' | head -1 | grep -oE '[A-Z0-9]{10}$' || true)"
fi
if [[ -z "$TEAM" ]]; then
  TEAM="$(grep -oE 'DEVELOPMENT_TEAM = [A-Z0-9]{10}' "$PROJECT/project.pbxproj" | head -1 | grep -oE '[A-Z0-9]{10}$' || true)"
fi
if [[ -z "$TEAM" ]]; then
  cat <<'EOF'
Xcode doesn't know your team yet.

In Xcode: click PS5Vision (blue icon, top of the left sidebar) > Signing &
Capabilities > choose your name under Team. (Add your Apple account first in
Xcode > Settings > Accounts if the list is empty.) Then run this again.

Or pass it directly: PS5VISION_TEAM=ABCDE12345 npm run vision:install
EOF
  exit 1
fi

# --- build, install, open ------------------------------------------------
BUNDLE_ID="io.github.ps5vision.app.$(tr 'A-Z' 'a-z' <<<"$TEAM")"
echo "Building the app for your headset (this takes a minute the first time)…"
xcodebuild -project "$PROJECT" -scheme PS5Vision -configuration Debug \
  -destination "id=$DEVICE" -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" CODE_SIGN_STYLE=Automatic \
  build >"$WORK/build.log" 2>&1 || {
    grep -E "error:|requires a development team|No profiles|not registered" "$WORK/build.log" | sort -u | head -15
    echo
    echo "The build failed. If it mentions signing, open the project once in Xcode"
    echo "(npm run vision), pick your Team under Signing & Capabilities, and try again."
    exit 1
  }

APP="$(find "$DERIVED/Build/Products/Debug-xros" -maxdepth 1 -name '*.app' | head -1)"
NAME="$(basename "$APP" .app)"
echo "Installing on the headset…"
xcrun devicectl device install app --device "$DEVICE" "$APP" >/dev/null
echo "Opening it…"
if ! xcrun devicectl device process launch --device "$DEVICE" "$BUNDLE_ID" >/dev/null 2>&1; then
  echo "Installed. The first time, the headset may ask you to trust your developer"
  echo "account: Settings > General > VPN & Device Management. Then open $NAME."
  exit 0
fi
echo "$NAME is open on your headset."

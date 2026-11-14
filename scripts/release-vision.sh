#!/usr/bin/env bash
# Builds the Vision Pro app for the App Store and uploads it to App Store
# Connect, where it can go to TestFlight and to review.
#
#   npm run vision:release              build, sign and upload
#   npm run vision:release -- --check   only prove it builds (no account needed)
#   npm run vision:release -- --keep    build and sign, keep the file, don't upload
#
# Needs, once:
#   - membership of the Apple Developer Program (developer.apple.com/programs)
#   - Xcode signed in to that account (Xcode > Settings > Accounts), or an App
#     Store Connect API key passed as ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH
#   - an app record in App Store Connect with this bundle ID (see
#     docs/app-store/SUBMITTING.md)
#
# Your team is passed to the build, never written into the project.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/visionos/PS5Vision.xcodeproj"
# Outside the project folder: iCloud-synced folders (like the Desktop) add
# file attributes that code signing refuses.
OUT="$HOME/Library/Developer/Xcode/DerivedData/PS5Vision-release"
ARCHIVE="$OUT/app.xcarchive"
MODE="upload"
case "${1:-}" in
  --check) MODE="check" ;;
  --keep) MODE="keep" ;;
  "") ;;
  *) echo "Unknown option: $1 (use --check or --keep)"; exit 2 ;;
esac

# The project file is made from project.yml; keep it in step when we can.
if command -v xcodegen >/dev/null 2>&1; then
  (cd "$ROOT/visionos" && xcodegen generate --quiet)
fi

BUNDLE_ID="${PS5VISION_BUNDLE_ID:-$(grep -oE 'PRODUCT_BUNDLE_IDENTIFIER: .+' "$ROOT/visionos/project.yml" | head -1 | sed 's/.*: //')}"
VERSION="$(grep -oE 'MARKETING_VERSION: "[^"]+"' "$ROOT/visionos/project.yml" | grep -oE '[0-9.]+')"
# Every upload needs a higher build number than the last: the time does that.
BUILD="${PS5VISION_BUILD:-$(date +%Y%m%d%H%M)}"
rm -rf "$ARCHIVE" "$OUT/export"
mkdir -p "$OUT"

failed() {
  grep -E "error:|requires a development team|No profiles|No Accounts|not registered|No signing certificate" "$OUT/$1.log" | sort -u | head -15
  echo
  echo "$2 The full log is at $OUT/$1.log"
  exit 1
}

if [[ "$MODE" == "check" ]]; then
  echo "Building version $VERSION for the headset, unsigned, to prove it builds…"
  xcodebuild archive -project "$PROJECT" -scheme PS5Vision -configuration Release \
    -destination "generic/platform=visionOS" -archivePath "$ARCHIVE" -derivedDataPath "$OUT/derived" \
    CURRENT_PROJECT_VERSION="$BUILD" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
    >"$OUT/archive.log" 2>&1 || failed archive "The build failed."
  APP="$(find "$ARCHIVE/Products/Applications" -maxdepth 1 -name '*.app' | head -1)"
  echo "It builds: $(basename "$APP"), version $VERSION."
  echo "Icon in the app: $(find "$APP" -name 'Assets.car' | wc -l | tr -d ' ') asset catalog; privacy file: $(find "$APP" -name 'PrivacyInfo.xcprivacy' | wc -l | tr -d ' ')."
  exit 0
fi

# --- the team ------------------------------------------------------------
TEAM="${PS5VISION_TEAM:-}"
if [[ -z "$TEAM" ]]; then
  TEAM="$(defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier 2>/dev/null \
    | grep -oE 'teamID = "?[A-Z0-9]{10}' | head -1 | grep -oE '[A-Z0-9]{10}$' || true)"
fi
if [[ -z "$TEAM" ]]; then
  cat <<'EOT'
Xcode doesn't know your Apple developer team yet.

1. Join the Apple Developer Program: https://developer.apple.com/programs/enroll/
2. In Xcode: Settings > Accounts > + > Apple Account, and sign in.

Then run this again. Or pass the team directly:
  PS5VISION_TEAM=ABCDE12345 npm run vision:release
EOT
  exit 1
fi

# An App Store Connect API key, when given, signs in without Xcode's account.
AUTH=()
if [[ -n "${ASC_KEY_ID:-}" && -n "${ASC_ISSUER_ID:-}" && -n "${ASC_KEY_PATH:-}" ]]; then
  AUTH=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
fi

echo "Building version $VERSION (build $BUILD) as $BUNDLE_ID…"
xcodebuild archive -project "$PROJECT" -scheme PS5Vision -configuration Release \
  -destination "generic/platform=visionOS" -archivePath "$ARCHIVE" -derivedDataPath "$OUT/derived" \
  -allowProvisioningUpdates ${AUTH[@]+"${AUTH[@]}"} \
  DEVELOPMENT_TEAM="$TEAM" PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" CODE_SIGN_STYLE=Automatic \
  CURRENT_PROJECT_VERSION="$BUILD" \
  >"$OUT/archive.log" 2>&1 || failed archive "The build failed. If it mentions signing, check that your Apple Developer Program membership is active."

DESTINATION="upload"
[[ "$MODE" == "keep" ]] && DESTINATION="export"
cat >"$OUT/export.plist" <<EOT
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key><string>app-store-connect</string>
	<key>destination</key><string>$DESTINATION</string>
	<key>teamID</key><string>$TEAM</string>
	<key>signingStyle</key><string>automatic</string>
	<key>manageAppVersionAndBuildNumber</key><false/>
	<key>uploadSymbols</key><true/>
</dict>
</plist>
EOT

if [[ "$MODE" == "keep" ]]; then echo "Signing for the App Store…"; else echo "Uploading to App Store Connect…"; fi
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist "$OUT/export.plist" -exportPath "$OUT/export" \
  -allowProvisioningUpdates ${AUTH[@]+"${AUTH[@]}"} \
  >"$OUT/export.log" 2>&1 || failed export "That didn't go through. If it says no app was found, create the app record first (docs/app-store/SUBMITTING.md, step 2)."

if [[ "$MODE" == "keep" ]]; then
  echo "Signed and kept: $(find "$OUT/export" -name '*.ipa' | head -1)"
else
  echo "Uploaded build $BUILD. It appears in App Store Connect (TestFlight tab) after"
  echo "Apple finishes processing it, usually 10 to 30 minutes."
fi

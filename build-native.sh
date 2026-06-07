#!/usr/bin/env bash
# Compiles the Swift audio recorder helper binary.
# Run once before `npm start` or `npm run dist`.
# Requires Xcode Command Line Tools (swiftc must be on PATH).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/native/AudioRecorder.swift"
OUT="$SCRIPT_DIR/resources/audio-recorder"
ENTITLEMENTS="$SCRIPT_DIR/native/AudioRecorder.entitlements"

echo "==> Compiling AudioRecorder.swift …"
swiftc \
  -O \
  -swift-version 5 \
  -target arm64-apple-macosx13.0 \
  -framework ScreenCaptureKit \
  -framework AVFoundation \
  -framework CoreMedia \
  -framework Foundation \
  -o "$OUT" \
  "$SRC"

chmod +x "$OUT"
echo "==> Built: $OUT"

# Sign with Developer ID so macOS grants TCC permissions and the binary is
# notarization-ready.  --timestamp contacts Apple's timestamp server (requires
# internet).  Falls back to ad-hoc (-) if the certificate is not installed,
# which is useful for CI runners that don't have the keychain.
DEVELOPER_ID="Developer ID Application: ETHAN ALLISON (GMVTGR644V)"

if security find-identity -v -p codesigning 2>/dev/null | grep -qF "GMVTGR644V"; then
  IDENTITY="$DEVELOPER_ID"
  TIMESTAMP_FLAG="--timestamp"
  echo "==> Code-signing with Developer ID (GMVTGR644V) …"
else
  IDENTITY="-"
  TIMESTAMP_FLAG=""
  echo "==> WARNING: Developer ID cert not found — using ad-hoc signature."
  echo "   Install the 'Developer ID Application: ETHAN ALLISON (GMVTGR644V)'"
  echo "   certificate from the Apple Developer portal to produce a signed build."
fi

codesign \
  --sign "$IDENTITY" \
  --force \
  $TIMESTAMP_FLAG \
  --options runtime \
  --entitlements "$ENTITLEMENTS" \
  "$OUT"

echo "==> Done."
echo ""
echo "NOTE: On first run macOS will ask for Screen Recording permission."
echo "      Grant it in System Settings → Privacy & Security → Screen Recording."

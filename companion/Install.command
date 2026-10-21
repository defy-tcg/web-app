#!/bin/bash
# User-local installation only. Never disables Gatekeeper or requests administrator access.
set -euo pipefail
umask 077
cd "$(dirname "$0")"
if [ "$(uname -s)" != Darwin ]; then echo 'Run this installer on macOS.'; exit 1; fi
major="$(sw_vers -productVersion | cut -d. -f1)"
if [ "$major" -lt 13 ]; then echo 'macOS 13 or newer is required.'; exit 1; fi
python=""
for candidate in python3.13 python3.12 python3.11 python3 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
  exe="$(command -v "$candidate" 2>/dev/null || true)"
  if [ -n "$exe" ] && "$exe" -c 'import sys; assert (3,11)<=sys.version_info[:2]<=(3,13)' 2>/dev/null; then python="$exe"; break; fi
done
if [ -z "$python" ]; then
  echo 'Install Python 3.11, 3.12 or 3.13 for macOS from python.org, then run this installer again.'
  echo 'The scanner installs into your user Library. No administrator access is requested by this installer.'
  exit 1
fi
# Refuse an Intel-only interpreter on Apple Silicon rather than silently using Rosetta.
if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then
  if [ "$("$python" -c 'import platform; print(platform.machine())')" != arm64 ]; then
    echo 'Apple Silicon detected, but this Python is Intel-only. Install native arm64 or universal2 Python 3.11–3.13, then retry.'
    exit 1
  fi
fi
base="$HOME/Library/Application Support/Rift Warehouse Scanner"
release="$base/releases/0.1.0"
mkdir -p "$release" "$HOME/Applications"
cp -R rift_scanner "$release/"
cp requirements.txt "$release/"
"$python" -m venv "$release/.venv"
"$release/.venv/bin/python" -m pip install --only-binary=:all: -r "$release/requirements.txt"
"$release/.venv/bin/python" -c 'import cv2,numpy,PIL,keyring; assert cv2.__version__.startswith("4.12."); print("Native OpenCV ready:",cv2.__version__)'
app="$HOME/Applications/Rift Warehouse Scanner.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cat > "$app/Contents/MacOS/RiftScanner" <<'LAUNCH'
#!/bin/bash
set -euo pipefail
umask 077
base="$HOME/Library/Application Support/Rift Warehouse Scanner"
release="$base/releases/0.1.0"
mkdir -p "$base/logs"
cd "$release"
# Python uses a private singleton lock; repeated launches open the running instance.
exec "$release/.venv/bin/python" -m rift_scanner.server >>"$base/logs/scanner.log" 2>&1
LAUNCH
chmod 700 "$app/Contents/MacOS/RiftScanner"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Rift Warehouse Scanner</string>
<key>CFBundleDisplayName</key><string>Rift Warehouse Scanner</string>
<key>CFBundleIdentifier</key><string>com.defytcg.riftwarehousescanner</string>
<key>CFBundleExecutable</key><string>RiftScanner</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
printf '\nInstalled: %s\n' "$app"
echo 'This is a source-installed, unsigned pilot. Review README.md before handling live stock.'
echo 'Your interface opens in your browser; recognition and draft storage run on this Mac.'
open "$app"

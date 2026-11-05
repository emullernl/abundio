#!/bin/sh
# Builds SpaceRestore.app next to this script. Not part of the Abundio build.
set -e
cd "$(dirname "$0")"
APP=SpaceRestore.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.abundio.space-restore-prototype</string>
<key>CFBundleName</key><string>SpaceRestore</string>
<key>CFBundleExecutable</key><string>SpaceRestore</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PLIST
clang -fobjc-arc -framework Cocoa -o "$APP/Contents/MacOS/SpaceRestore" main.m
codesign -s - --force "$APP" >/dev/null 2>&1 || true
echo "built $(pwd)/$APP"

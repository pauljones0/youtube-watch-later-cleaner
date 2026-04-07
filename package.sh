#!/bin/bash
# Package the extension into an .xpi for Firefox Add-on submission
# Usage: ./package.sh
#
# An .xpi is just a .zip with a different extension.
# Mozilla Add-ons accepts both .zip and .xpi.

set -e

NAME="youtube-watch-later-cleaner"
VERSION=$(grep '"version"' manifest.json | head -1 | sed 's/.*: *"\([^"]*\)".*/\1/')
FILES="manifest.json content.js popup.html popup.js icon.svg removeWatchLater.js"

echo "Packaging $NAME v$VERSION..."

for f in $FILES; do
  if [ ! -f "$f" ]; then
    echo "Missing: $f"
    exit 1
  fi
done

rm -f "$NAME.xpi" "$NAME.zip"

if command -v zip &>/dev/null; then
  zip "$NAME.xpi" $FILES
else
  # Fallback for Windows (no zip command — create .zip then rename)
  powershell -Command "
    Compress-Archive -Path 'manifest.json','content.js','popup.html','popup.js','icon.svg','removeWatchLater.js' -DestinationPath '${NAME}.zip' -Force
    Move-Item -Force '${NAME}.zip' '${NAME}.xpi'
  "
fi

echo "Created $NAME.xpi (v$VERSION)"

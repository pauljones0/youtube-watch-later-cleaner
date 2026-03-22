#!/bin/bash
# Package the extension into a .zip for Firefox Add-on submission
# Usage: ./package.sh

set -e

NAME="youtube-watch-later-cleaner"
FILES="manifest.json content.js popup.html popup.js icon.svg"

for f in $FILES; do
  if [ ! -f "$f" ]; then
    echo "Missing: $f"
    exit 1
  fi
done

rm -f "$NAME.zip"

if command -v zip &>/dev/null; then
  zip "$NAME.zip" $FILES
else
  # Fallback for Windows (no zip command)
  powershell -Command "Compress-Archive -Path '$( echo $FILES | sed 's/ /,/g' )' -DestinationPath '$NAME.zip' -Force"
fi

echo "Created $NAME.zip"

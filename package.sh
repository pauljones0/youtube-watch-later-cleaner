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
zip "$NAME.zip" $FILES
echo "Created $NAME.zip ($(du -h "$NAME.zip" | cut -f1))"

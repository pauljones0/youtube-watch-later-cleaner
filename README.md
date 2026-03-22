# YouTube Watch Later Cleaner

A Firefox extension that removes all videos from your YouTube Watch Later playlist in seconds.

## Why?

YouTube doesn't provide a "clear all" button for Watch Later. If you've accumulated hundreds or thousands of videos, removing them one-by-one is painful. This extension uses YouTube's internal batch API to remove ~100 videos per request, clearing even massive playlists in under a minute.

## Features

- **Fast** — batch API removes ~100 videos per request (~100ms each)
- **Handles hidden videos** — fetches all videos including unavailable/private ones via API
- **On-page progress** — floating overlay shows removal count even with popup closed
- **Popup syncs on reopen** — close and reopen the popup mid-run without losing state
- **Automatic fallback** — falls back to UI-click removal if the API is unavailable

## Install

1. Download or clone this repo
2. Open Firefox, go to `about:debugging` → "This Firefox"
3. Click "Load Temporary Add-on" → select `manifest.json`

Or install from [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/youtube-watch-later-cleaner/).

## Usage

1. Navigate to your [Watch Later playlist](https://www.youtube.com/playlist?list=WL)
2. Click the extension icon
3. Click "Start Cleaning"

## Packaging

```bash
./package.sh
```

Creates `youtube-watch-later-cleaner.zip` ready for Firefox Add-on submission.

## Files

| File | Purpose |
|------|---------|
| `content.js` | Core logic — batch API removal, overlay, state management |
| `popup.html` | Extension popup UI |
| `popup.js` | Popup state machine and message handling |
| `removeWatchLater.js` | Standalone console script (paste in browser devtools) |
| `manifest.json` | Firefox extension manifest (v2) |
| `icon.svg` | Extension icon |

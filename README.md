# YouTube Watch Later Cleaner

A Firefox extension that batch-removes videos from your YouTube Watch Later playlist.

## Why?

YouTube doesn't provide a "clear all" button for Watch Later. If you've accumulated hundreds or thousands of videos, removing them one-by-one is painful. This extension uses YouTube's internal batch API to remove up to ~100 videos per request, with a slower UI fallback when YouTube rejects the batch path.

## Features

- **Fast batch removal** — removes up to ~100 videos per request when YouTube accepts the batch API
- **Handles hidden videos** — fetches all videos including unavailable/private ones via API
- **Watched-progress filter** — optionally remove only videos watched at or above a chosen percentage
- **On-page progress** — floating overlay shows removal count even with popup closed
- **Popup syncs on reopen** — close and reopen the popup mid-run without losing state
- **Automatic fallback** — falls back to UI-click removal if the API is unavailable
- **Native empty state at the end** — when everything is removed, the page refreshes so YouTube shows its own empty playlist state

## Install

1. Download or clone this repo
2. Open Firefox, go to `about:debugging` → "This Firefox"
3. Click "Load Temporary Add-on" → select `manifest.json`

Or install from [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/youtube-watch-later-cleaner/).

## Usage

1. Navigate to your [Watch Later playlist](https://www.youtube.com/playlist?list=WL)
2. Click the extension icon
3. Optionally expand Advanced settings and choose a minimum watched percentage
4. Click "Start Cleaning"

## Packaging

```bash
./package.sh
```

Creates `youtube-watch-later-cleaner.xpi` ready for Firefox Add-on submission.

## Files

| File | Purpose |
|------|---------|
| `content.js` | Core logic — batch API removal, filtering, overlay, fallback, state management |
| `popup.html` | Extension popup UI |
| `popup.js` | Popup state machine and message handling |
| `removeWatchLater.js` | Standalone console script (paste in browser devtools) |
| `manifest.json` | Firefox extension manifest (v2) |
| `icon.svg` | Extension icon |

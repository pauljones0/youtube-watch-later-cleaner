# YouTube Watch Later Cleaner

A Firefox extension that removes videos from your YouTube Watch Later playlist, in batches of up to 100. It can clear the list or remove only videos watched at or above a selected percentage.

## Using it

1. Open [Watch Later](https://www.youtube.com/playlist?list=WL) in the account you want to clean.
2. Open the extension. Choose a minimum watched percentage in Advanced, or leave it at 0% to remove everything. **Closing Advanced does not disable the filter.**
3. Select Start Cleaning. The extension scans the complete playlist, including unavailable entries returned by YouTube, then removes matching videos.
4. Stop waits for the current task to settle before allowing another run. A request already accepted by YouTube may finish despite cancellation; the extension tells you when its outcome is uncertain.
5. Use Refresh playlist after the run to display YouTube's current list. The extension does not edit YouTube's private list model or automatically reload the page.

The popup and on-page panel show progress and a Stop control. Closing the popup does not stop cleaning. Navigating away or changing account stops the run.

If YouTube rejects batch deletion, the extension can use identified Watch Later removal actions in the page. It reports completion only after verifying that no matching videos remain. If verification fails, it reports partial progress and asks you to refresh and retry. UI rows disappearing are counted separately from successful API removals.

Preview counts are fetched for the current page and rechecked when cleaning starts. No account-independent histogram is cached. Recent run diagnostics remain available after refresh through the bug-report button; it copies diagnostics and opens an email draft for you to review and send.

## Install

Requires Firefox 128 or later. For local development:

1. Download or clone this repository.
2. Open `about:debugging` → This Firefox → Load Temporary Add-on.
3. Select `manifest.json`.

The [Firefox Add-ons listing](https://addons.mozilla.org/firefox/addon/youtube-watch-later-cleaner/) contains the published version; local changes here are not automatically published.

## Development and packaging

Use Node.js 22 or later. There are no npm dependencies to install.

```sh
npm test
./package.sh
```

The package script works from any directory, regenerates the standalone console script, and creates `youtube-watch-later-cleaner.xpi`. Signing/publishing is a separate step. GitHub tag releases run regression tests and the same packaging script.

```sh
# Optional real Firefox integration tests; Python requests and geckodriver required.
geckodriver --port 4445 --host 127.0.0.1
# In a second terminal:
python3 tests/firefox_test.py
```

The Firefox tests install a temporary extension in an isolated profile against a local fixture. They do not access or modify a real YouTube account.

## Standalone console script

`node build.mjs` generates `removeWatchLater.js` from the same engine and page adapter as the extension. Paste it in the browser console on Watch Later to clear the list. Stop with `WatchLaterCleaner.stop()` or the on-page button. After stopping, a filtered run can be started with `WatchLaterCleaner.start(80)`.

## Code layout

| File | Responsibility |
| --- | --- |
| `cleaner-core.js` | Account identity, API parsing, complete scans, deletion verification, run lifecycle |
| `content.js` | Firefox/page transport, conservative UI fallback, overlay, messaging and durable diagnostics |
| `popup.js`, `popup.html` | Filter settings, live preview, acknowledged commands and tab-scoped state |
| `build.mjs` | Generate the standalone script without maintaining a second removal implementation |
| `tests/` | Regression tests and real Firefox fixture tests |
| `review/REVIEW.md` | Historical v2.4 findings |
| `review/ITERATIVE-FIXES.md` | Latest review, fixes, validation and remaining live-test gap |
| `review/README.md` | Index of current and historical review evidence |

YouTube's internal API and menu structure are not public contracts. Unknown or incomplete responses stop verification rather than being treated as an empty playlist. A run may need a refresh/retry when YouTube changes its behavior.

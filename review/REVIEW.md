# YouTube Watch Later Cleaner v2.4 code review

Reviewed September 5, 2026. Repository: https://github.com/pauljones0/youtube-watch-later-cleaner. Commit: `be4a77f893e6d7531e9fa356cce1bc61f163f4c6`.

This is the historical v2.4 review. The reproduction scripts load that commit with `git show`; current-code regression tests live in `tests/`. See `FIXES.md` for the refactor and resolution status.

The most urgent problems concern account selection, false deletion verification, cancellation, and destructive actions changing scope. This review identifies **24 actionable findings**: 7 P1, 14 P2, and 3 P3. P1 means fix before the next release; P2 means a functional defect; P3 means a lower-impact defect. Severity reflects the described trigger, not an estimate of how many users encounter it.

All tracked source, the release workflow, manifest, packaging, README, and standalone console script were inspected. The downloaded Firefox-store v2.4 has byte-identical `content.js`, `popup.js`, `popup.html`, `removeWatchLater.js`, and icon. Its manifest adds the store-assigned extension ID. GitHub has no issues, open or closed, at review time. Runtime files were not modified; review artifacts are in this directory.

## Connection to the store reports

The [Firefox reviews](https://addons.mozilla.org/en-US/firefox/addon/youtube-watch-later-cleaner/reviews/) include a July 24, 2026 v2.4 report about partial cleaning and Stop, and a June 28, 2026 v2.4 report of API errors followed by successful UI fallback. The review API provides those version/date associations.

Findings 1–4 and 8 are plausible explanations for API failures or apparent lost progress; findings 7 and 9 directly affect partial-run behavior. These are **code-based explanations, not a proven diagnosis of either reviewer's session**. In particular, no evidence here shows YouTube rolling back confirmed deletions when Stop is pressed. False optimistic counts and missing visible rows can make progress appear to vanish on refresh.

## Findings

### 1. [P1] API requests ignore the active Google/brand account

Locations: `content.js:566–580,670–677`; `removeWatchLater.js:31–39`.

`getApiHeaders()` always sends `X-Goog-AuthUser: 0` and never sends `X-Goog-PageId`. `getYtConfig()` discards `SESSION_INDEX` and `DELEGATED_SESSION_ID`. A non-default or brand-account Watch Later page therefore does not reliably determine which account the browse/edit requests address. This can cause playlist-not-found/auth failures; if the API accepts the default account, it can target that account's Watch Later instead.

Evidence: the harness supplies session index 2 and a brand ID; generated headers still select 0 and omit the brand. Current [yt-dlp authentication code](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_base.py) derives both headers from session configuration. Wrong-account server-side deletion was **not** attempted. Preserve account identity, pass the active session/delegation headers, and bind verification and deletion to the same identity. Also regenerate authentication on a retry: the extension currently reuses the initial hash throughout the run.

### 2. [P1] Failed/incomplete verification is treated as proof of deletion

Locations: `content.js:1065–1084,1097–1109`; scan result contract at `content.js:792–832`.

After an unsuccessful edit, the code labels every requested ID absent from `verification.foundIds` as deleted, even when `verification.error` is set or `verification.completed` is false. An interrupted scan or its 50-page cap proves nothing about unseen IDs. Nevertheless, `applyDeletedChunk()` increments the count and removes local rows. The retry path repeats the same mistake.

Evidence: an unsuccessful one-video edit followed by a verification timeout results in `count=1, done=true` without any successful deletion. Only infer absence after a successful exhaustive scan. Preserve unknown outcomes and reconcile them before retrying or reporting success.

### 3. [P1] Browse errors and unknown response layouts become successful completion

Locations: `content.js:710–763,934–956,1170–1176`; `removeWatchLater.js:55–66,105–110`.

`pageFetch()` records HTTP status, but the browse parsers do not check it or the JSON `error` field. A 403 JSON error, for example, becomes `{videos:[], error:null}`. Unknown renderer layouts also become empty. Separately, genuine `page.error` values are ignored by the cleaning loop except for its first-page DOM-based fallback. A failed later page can therefore end a filtered run as successful while matching videos remain unscanned. The standalone script also reports an HTTP error as an empty playlist.

Evidence: 403 JSON, an unrecognized continuation wrapper, and a filtered scan whose second page times out all reproduce these failure modes. Distinguish confirmed empty, unsupported schema, incomplete scan, and transport/API errors; handle errors before the empty-page branch. An unrecognized schema fixture is a robustness test, not a claim that every current YouTube response uses that schema.

### 4. [P1] Stop does not terminate a run; restarting can revive the old task

Locations: `content.js:1000–1139,1878–1906,2023–2026,2055–2060`.

Stop only clears a shared boolean. The chunk loop, verification/retry sequence, and UI awaits do not consistently check cancellation before another mutation. More seriously, a new Start sets that same boolean back to true while the previous async task may still be awaiting a request. The old task then resumes with its old filter and overwrites the new run's state.

Evidence: a 101-video fixture sends deletion chunks of 100 **and 1** even after Stop during the first chunk. A separate paused old run resumes after new-run state is installed with a 100% filter and deletes an unwatched target selected under its old 0% filter. Give each run its own cancellation token/generation and serialize run lifetimes. An already-accepted server mutation cannot be undone by cancellation; distinguish that from sending additional requests after Stop.

### 5. [P1] SPA navigation can redirect UI fallback onto another playlist

Locations: `content.js:1753–1787,1809–1949,2012`.

The URL is checked only when Start arrives. YouTube's in-page navigation preserves the content script and its running loop. If the user moves from Watch Later to another playlist during fallback, the next iteration queries that new page's rows. The global trash/menu selectors can remove from the new playlist. API requests also continue targeting Watch Later after navigation, while reconciliation touches whichever page is now visible.

Evidence: the actual menu-removal function still clicks a deletion candidate with the location set to `playlist?list=OTHER`; no navigation guard exists in the loop. The fixture does not perform a real cross-playlist deletion. Stop the run on navigation or account change, and revalidate the bound playlist immediately before each UI mutation and after asynchronous waits.

### 6. [P1] Collapsing Advanced silently disables the watched-progress filter

Locations: `popup.js:67–69,443–454,638–651`.

`effectiveSettings()` makes the threshold zero whenever the Advanced panel is collapsed. A user can choose 80%, close the panel to tidy the popup, and then start a full clear. The slider's saved value remains 80%, disguising the changed behavior when reopened.

Evidence: the popup reproduction selects a persisted 80% threshold, collapses Advanced, and captures Start sending `minProgressPercent:0`. Panel visibility should be independent of the deletion setting. Use a distinct, explicit control if filtering needs an enabled/disabled state.

### 7. [P2] Firefox isolation makes the list-refill/reconciliation code unavailable

Locations: `content.js:1364–1386,1409–1485,1549–1647`.

These functions read page-owned `data`, `polymerController`, `__data`, `splice`, and `notifyPath` directly from content-script DOM wrappers. Firefox Xray wrappers hide these page-defined properties. The functions consequently cannot access or update YouTube's list model. The fallback removes raw DOM rows but leaves the page model intact and cannot retrieve its continuation token. Partial runs can leave a depleted or inconsistent visible list until a refresh, even when backend deletion succeeded.

Evidence: a real temporary extension in headless Firefox 155.0.1 sees `list.data === undefined`, while `list.wrappedJSObject.data` exists; the actual `getPlaylistContentsArray()` returns null and hydrated removal returns `mode:'unavailable'`. The same test successfully exercises `getYtConfig()` and `pageFetch()` as controls. This matches [Mozilla's explanation of Xray wrappers](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Sharing_objects_with_page_scripts). Use a narrow page-context bridge, with correct compartment cloning for arguments, or avoid mutating YouTube's private model.

### 8. [P2] Request timeouts leave the actual deletion request running

Locations: `content.js:608–651`.

`Promise.race()` rejects after 15 seconds, but the fetch receives no abort signal. A timed-out edit can still finish after verification or UI fallback has started, creating overlapping mutations and inconsistent counts. The timeout timer is also never cleared on ordinary success.

Evidence: the fixture fires the actual timeout callback, observes rejection, confirms no signal was passed, and then successfully completes the still-pending underlying fetch. Use a page-compatible AbortController, clear timers, and treat timed-out edits as uncertain until reconciled. Aborting transport still cannot guarantee that the server did not apply an edit.

### 9. [P2] Stop permanently disables the popup button until it is reopened

Locations: `popup.js:679–701`; `content.js:2055–2060`.

The stop click disables the button. Content sends only a `log` message saying Stopped; the popup's log handler changes status text but never restores a Start/Resume state or clears its stale running snapshot. The user cannot run again from that popup.

Evidence: Start followed by Stop leaves the actual popup handler's button disabled and labeled Stop after the stop log is delivered. Return an explicit stopped state/acknowledgment and render it, including final counts and settings.

### 10. [P2] UI fallback decrements a count that YouTube has already decremented

Locations: `content.js:1670–1675,1686–1700,1906–1923`.

`confirmFallbackRemoval()` accepts a drop in the page count as proof of success. The caller then invokes `reconcileAfterSingleVisibleRemoval()`, which decrements that same DOM count again. Counts can reach zero early, misleading completion, loading, and the popup's empty-state logic.

Evidence: a native update from 100 to 99 is accepted, then the extension changes the displayed count to 98 after one removal. Reconcile to an authoritative count or adjust only when the native UI has not already applied the removal.

### 11. [P2] UI verification accepts an incomplete scan as proof of absence

Locations: `content.js:1702–1741`.

The fallback checks `verification.error` but ignores `verification.completed`. Its 20-page scan cap can be reached before a target still present farther down the playlist. That target is then reported removed. This is distinct from the batch verification caller and needs its own correction.

Evidence: 20 successful pages with further continuation and no target produce `ok:true` despite `completed:false`. Require a completed scan to prove absence; a capped scan is an unknown outcome. Also avoid presenting `dom-only-unverified` as verified deletion when no API context exists.

### 12. [P1] The last UI strategy clicks the third menu item without identifying it

Locations: `content.js:1205–1217,1770–1775`.

When the trash SVG or English text does not match—such as after a YouTube redesign or with localization—the code blindly chooses the third menu item. That item's function is not checked. It can trigger a different action rather than removal. Queries also search all matching popup renderers rather than proving that the result belongs to the currently open row menu.

Evidence: a fixture whose only candidate is an unidentified third item is clicked and can be counted as a successful removal if the row disappears. Match the actual endpoint/action and current menu, or fail safely; do not use position as authorization for a destructive action.

### 13. [P2] UI fallback reports Done even when it cannot finish

Locations: `content.js:1836–1849,1863–1877,1940–1943`.

After a few unsuccessful loads, no rows plus a positive known count produces `finishCleaning()`. Separately, rows that fail removal twice are put into the same `keptKeys` set as intentionally filtered-out videos; when scanning ends they are reported as successfully kept. This hides operational failures and makes an unfiltered run appear successful with remaining videos.

Evidence: an unfiltered fixture with 100 known remaining videos and no loadable rows finishes with `done:true`. Track intentional keeps, failed removals, and unknown/unloaded items separately; report partial failure and preserve a retry route.

### 14. [P2] A loading playlist is mistaken for an empty playlist

Locations: `popup.js:493–514,570–585`.

If a playlist header exists before rows/counts have rendered, the injected probe returns zero. `updateInterface()` then hides Start and says Nothing to clean, without scheduling the polling that it uses for a null/unknown count. This occurs during asynchronous page hydration even when the document load has completed.

Evidence: a header-only DOM produces Nothing to clean and no retry timer. Keep the state unknown until there is affirmative empty-state evidence or a valid count; observe asynchronous DOM changes or poll until ready.

### 15. [P2] Popup messages from other YouTube tabs overwrite the current tab's UI

Locations: `popup.js:686–733`.

The runtime listener ignores `sender.tab.id`. Every tab running this extension can update the popup's count, status, or completion state. A completion in tab B can hide controls for tab A's nonempty playlist, including its Stop button.

Evidence: delivering a complete message from tab 999 to a popup tracking tab 1 sets its count/status to 999 and hides the button. Filter messages by sender tab, and preferably by run identity as well.

### 16. [P2] Playlist counts break outside English/comma formatting

Locations: `content.js:94–99,1280–1305`; `popup.js:493–500`.

Count parsers strip commas only, then take the first digit run: `1.234` or `1 234` becomes 1. DOM count updates additionally require the English word video/videos, so a French `100 vidéos` is never decremented. Remaining totals, loading decisions, previews, and completion/reload behavior become inaccurate.

Evidence: both localized thousand formats parse as 1 and `100 vidéos` remains unchanged after reconciling 100 removals. Prefer structured numeric data; otherwise support locale-aware digits/separators and avoid English text matching for numeric updates.

### 17. [P2] URL checks reject valid Watch Later URLs and accept wrong IDs

Locations: `manifest.json:23–25`; `popup.js:29,54`; `content.js:2012`; `removeWatchLater.js:9`.

The literal substring/regex requires `list=WL` to be the first query parameter, so `playlist?foo=1&list=WL` is rejected. Conversely, a value beginning with WL, such as `list=WLother`, passes. The content-script match pattern has the same query-order restriction. This can misclassify which playlist the user is on while the API always uses the fixed WL ID.

Evidence: both cases are reproduced with the popup's actual URL predicate. Parse the URL, validate the host/path, and require `searchParams.get('list') === 'WL'`. Align injection eligibility with that semantic check.

### 18. [P2] A global preview cache is reused across different accounts/playlists

Locations: `popup.js:71–99,316–326`; `content.js:189–191`.

The saved histogram is scoped only by total and age, not tab/account identity or playlist revision. Two accounts with 100 videos can have very different watched-progress distributions, but the second account reuses the first account's preview for ten minutes without fetching a new estimate. Same-size changes within one account also go undetected. Stop does not invalidate the popup cache.

Evidence: a stored histogram with 5 matches for a 100-video list is rendered directly and no estimate request is sent for the current same-size list. This affects the displayed deletion estimate, not the API loop's per-video filter. Scope caches to account/playlist identity, invalidate on mutation and lifecycle changes, and distinguish cached estimates from current results.

### 19. [P2] Start has no acceptance response; an error can be overwritten as Running

Locations: `content.js:2011–2026`; `popup.js:647–675,710–715`.

The content handler does not return an explicit accepted/rejected response for Start. The popup treats message delivery as success and unconditionally renders Running. If the content script rejects immediately (for example, a sign-in check) and its error message arrives before the awaiting click handler resumes, that handler overwrites the error with Cleaning in progress and Stop.

Evidence: the popup harness delivers a sign-in error before Start's delivery promise resolves; the final display is still Running. Return an acceptance result with the current run/state, and only enter Running after acceptance. The deterministic fixture proves the ordering bug; its frequency depends on browser message scheduling.

### 20. [P2] Store compatibility allows Firefox versions that cannot parse the code

Location: `manifest.json`; examples include `content.js:68,119` and `popup.js:64`.

No `strict_min_version` is declared, and the store API advertises Firefox 58+. The shipped files contain optional chaining throughout; [MDN compatibility data](https://github.com/mdn/browser-compat-data/blob/main/javascript/operators/optional_chaining.json) places Firefox support at 74. Firefox 58–73 therefore cannot even parse the popup/content scripts.

Evidence: source syntax plus the downloaded store metadata; an old Firefox binary was not run. Declare and test an appropriate minimum supported version, or transpile to the advertised minimum. This mismatch is not evidence about failures in current Firefox.

### 21. [P3] Automatic reload destroys the logs needed to investigate a bad completion

Locations: `content.js:22–32,531–546,1980–1987`; `popup.js:357–376`.

Logs and completed state exist only in the document's content-script globals. After an empty completion the extension reloads the page in about 3.5 seconds. A user who notices videos reappearing and then clicks Report a bug gets the fresh page's logs/state instead of the failed run, precisely when the false-success bugs are most relevant.

Evidence: storage/lifecycle inspection; there is no durable run-log save before reload, and the report handler queries only the current content script. Save a bounded recent-run snapshot in extension storage before reload and offer the last completed/failed run when generating a report.

### 22. [P2] Standalone-script fetch timeout excludes response-body reading

Locations: `removeWatchLater.js:41–44,52–55,87–90`.

`timedFetch()` clears its AbortController timer as soon as response headers arrive. The subsequent `resp.json()` is outside the timeout. If the connection stalls while sending the body, the console script waits indefinitely instead of timing out or retrying.

Evidence: the standalone reproduction resolves fetch to a response with a pending JSON body; the request has zero remaining timers while `fetchPage()` remains unsettled. Keep the timeout active through body consumption. The standalone script also shares findings 1, 3, and 17.

### 23. [P3] The documented packaging command is not executable

Locations: `package.sh` git mode `100644`; README Packaging section.

On a fresh Unix checkout, the documented `./package.sh` exits with permission denied because the executable bit is absent. This is not a ZIP/build failure: `bash package.sh` succeeds and produces the expected six-file XPI. Set git mode `100755` or document the interpreter invocation.

### 24. [P3] Completion's nested timer can destroy a new run's overlay

Location: `content.js:532–549`.

The outer 3-second timer is tracked, but its nested 500 ms timer is not. Starting another run during that interval destroys the new overlay when the old timer fires; an old empty completion could also reload the new run's page. Evidence: the content reproduction fires the outer timer, replaces the overlay as a new run would, then fires the nested timer and observes the new overlay being removed. Track/cancel both timers or guard them with the owning run ID.

## Verification and limits

Reproduction commands, from the repository root:

```sh
node review/reproduce.cjs
node review/popup-reproduce.cjs
node review/standalone-reproduce.cjs
geckodriver --port 4445 --host 127.0.0.1
# In another terminal, with Python requests available:
python3 review/firefox-probe.py
```

The three Node harnesses execute functions from the actual source with controlled API/DOM fixtures. They assert the **observed buggy behavior**, so their passing is evidence of the defects, not a claim that the extension is fixed. Results: 15 content, 7 popup, and 2 standalone reproductions passed. The Firefox probe separately reproduced the Xray issue with successful config/fetch controls on Firefox 155.0.1 and geckodriver 0.37.1.

`node --check` passed for all three shipped JavaScript files; `bash -n package.sh` passed. `bash package.sh` built the expected archive. Mozilla web-ext lint on the source reported zero errors and three warnings: missing data-collection declaration, missing add-on ID, and an unnecessary file in the source directory. Linting the actual six-file archive eliminated the unnecessary-file warning, leaving zero errors and two manifest warnings. The store artifact already supplies the ID. Those warnings are not explanations for the reproduced runtime failures; no speculative policy blocker is counted as a bug.

No live signed-in YouTube playlist was altered. The backend's current account-routing behavior, response variations by account/experiment/locale, and exact causes of the reviewers' reports need captured live request/response evidence. In particular, newer multi-cookie authorization schemes and additional client headers in other clients are diagnostic leads, not separately proven bugs here.

Several suspected problems were checked rather than assumed: page-context fetch works in Firefox; the store JavaScript is not an older build; v2.4 already injects the content script on demand when the popup opens after SPA navigation; and the extension's outer rescan compensates for ordinary skipped pages after mutation, provided browsing succeeds. None is reported as a blanket failure.

Suggested fix sequence: first bind account/playlist/run identity and preserve the filter; then make request results and deletion verification explicit; then fix cancellation, Firefox reconciliation, and popup acknowledgments; finally correct counts, previews, diagnostics, and packaging. After fixes, convert these reproductions to assertions of the intended behavior and add controlled signed-in tests for multi-account, brand-account, localized, partial-stop/restart, and API-rejection scenarios.

# v3.0 reliability refactor

This local refactor addresses the 24 findings in the historical [v2.4 review](REVIEW.md). Work is on `fix/reliability-refactor`; no store submission, tag, push, or release has been made.

The former 2,079-line content script is replaced by a shared cleaning engine and a small browser adapter. The console script is generated from those same sources, eliminating a second independent authentication, pagination, and removal implementation. The popup now renders explicit state and acknowledged command results.

## Resolution mapping

| Finding | Resolution |
| --- | --- |
| 1. Account routing | Derive session index, brand/delegated account and user session from page config, including DATASYNC_ID. Generate current cookie signatures for each request, including retries. Bind each run to its initial account identity. |
| 2. Failed batch verification | Infer removal only from a successful edit or an exhaustive verification scan. Unknown outcomes stay uncertain; only IDs proven still present are retried. |
| 3. Errors treated as empty | HTTP, JSON, API, schema, pagination, and scan errors are explicit. An entire target snapshot is collected before deletion; final verification must also succeed. |
| 4. Stop/restart | Each run owns an AbortController. Guard every mutation and async boundary; reject restart until the previous task settles. Report uncertain in-flight edits honestly. |
| 5. Navigation | Validate the URL/account at async boundaries and stop on YouTube navigation, popstate, pagehide, or detected account change. |
| 6. Hidden filter | Panel visibility and threshold are independent. The popup states that closing Advanced preserves the filter. |
| 7. Firefox list model | Remove all writes to Polymer/private list data and raw deletion of API-removed DOM rows. Offer explicit refresh. Read cloned, unwrapped row/menu metadata only for identifying native UI actions. |
| 8. Transport timeout | A page-realm AbortController cancels the actual fetch. Timeout covers response-body reading, and timers/listeners are cleaned up. |
| 9. Stop button | Stop returns settled state, including final counts; the popup re-enables Start. |
| 10. Double count decrement | No DOM count parsing or count mutation remains. Successful API removals and UI observations are separate. |
| 11. Incomplete UI verification | UI completion uses the same exhaustive scanner as API completion. A scan error cannot prove absence. |
| 12. Positional menu click | Remove all SVG, English text, and positional deletion heuristics. Require a visible menu action whose endpoint identifies Watch Later and the intended entry. |
| 13. False fallback completion | DOM exhaustion cannot prove success. Verify no matching IDs remain or report partial progress. An authoritative final scan can also resolve earlier transient UI failures. |
| 14. Loading mistaken for empty | The popup does not infer emptiness from a header without rows. Unknown totals keep Start available; the engine waits for config and scans. |
| 15. Foreign-tab messages | Filter state messages by sender tab and reject stale run IDs. |
| 16. Localized counts | All authoritative totals come from structured playlist entries. No English video-label or comma-only count parser remains. |
| 17. URL checks | Parse hostname/path/query and require list exactly WL; query order is irrelevant. Passive content-script injection covers YouTube SPA entry points. |
| 18. Preview cache | Remove both global and per-document histogram caches. Debounce a current, read-only preview; abort on replacement/start/navigation/close. Starting always scans again. |
| 19. Start rejection race | Start explicitly returns accepted/rejected state. The popup never equates delivery with acceptance and fetches current state after acknowledgment. |
| 20. Unsupported Firefox | Declare Firefox 128 minimum and retain the existing store extension ID. Modern syntax is no longer advertised as Firefox 58 compatible. |
| 21. Lost diagnostics | Save bounded completed/stopped/error snapshots in extension storage. Bug reports use the saved run after a refresh. No automatic reload discards evidence. |
| 22. Console body timeout | The generated console bundle shares the corrected full-response transport and run cancellation. |
| 23. Packaging execution | Set executable mode, resolve paths relative to the script, generate the bundle, and use the same script in CI/releases. |
| 24. Old completion timer | Remove automatic hide/reload timers entirely. Refresh and dismissal are explicit controls; old runs cannot destroy a new overlay. |

## Intentional behavior changes

- Cleaning scans a full target snapshot before the first batch. Large lists therefore have a visible scanning phase; stopping during that phase removes nothing.
- API success leaves YouTube's rendered list unchanged until the user refreshes. The on-page panel and popup provide progress and a Refresh playlist button. This avoids maintaining an inconsistent private page model.
- UI fallback clicks only positively identified removal endpoints. Unsupported menus or unverifiable server outcomes produce partial/error state instead of guessed clicks or false success.
- API removals and UI rows observed disappearing are counted separately. Only a successful final playlist scan produces a verified completion.
- The extension is passive on other YouTube pages so it can handle SPA navigation into Watch Later. Cleaning still requires a valid Watch Later URL and explicit Start.
- The Google Fonts network import was removed; popup typography uses installed/system fallbacks.

## Validation

`npm test` passes 27 regression tests covering account/delegation/signatures, cookie rotation, response parsing, failed/incomplete scans, ambiguous edits, retry selection, cancellation/restart, navigation, filtered deletion, fallback verification, popup state and transport/body timeouts. Fractional watched progress is also preserved, so 99.9% cannot be rounded up into a 100% deletion threshold. These assert intended behavior. Historical reproductions remain runnable against the v2.4 commit with `git show` and are not mixed into the current test suite.

`tests/firefox_test.py` installs a temporary extension against a local synthetic page. Its Firefox scenarios exercise actual Xray boundaries, page-realm fetch cancellation, account headers, pagination, native menu removal, storage persistence, and partial outcomes. It also runs the generated console bundle without extension APIs. The only production-source alteration in the fixture is extending the hostname allowlist to localhost; all API requests are intercepted by the fixture.

All six extension scenarios and the generated-console scenario passed on **Firefox 155.0.1 and Firefox 128.0**, using geckodriver 0.37.1. The minimum-version test initially exposed automation issues: Firefox 128 needs path-based addon installation, and its temporary XPI must remain on disk until the test finishes. After correcting those fixture issues, the unmodified production manifest settings and runtime logic installed and operated successfully on 128.0.

`./package.sh` produces a six-file extension archive. JavaScript syntax checks, shell syntax checks, and `git diff --check` pass. CI runs regression tests, checks generated-console freshness, and builds the archive on pushes/PRs; release tags run tests and the same packaging script.

Mozilla web-ext reports zero package errors and two compatibility warnings about the no-data-collection manifest declaration on pre-140 desktop / pre-142 Android Firefox; the complete result is in `lint-result.json`. The key is newer than the declared Firefox 128 minimum; this is separate from the JavaScript compatibility defect. The extension does not declare Android availability. Actual installation and runtime tests above verify that this declaration does not prevent operation on the desktop minimum. See [Mozilla's browser-specific manifest documentation](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings).

Account-signature handling follows the current behavior documented in [yt-dlp's YouTube implementation](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_base.py), including DATASYNC_ID-derived delegation and user-session hash input. This is interoperability guidance, not a public YouTube API guarantee.

## Remaining validation boundary

No real signed-in playlist was modified. Current production YouTube account/experiment-specific responses, brand-account behavior, and localized live menus still require controlled real-account verification before a store release. Unknown response layouts and menu actions fail conservatively. This refactor corrects the reproduced code defects; it cannot guarantee every future YouTube internal-API variant will work.


## Subsequent review and repair

The second review found four additional defects. All were fixed, followed by another review and regression expansion; see [ITERATIVE-FIXES.md](ITERATIVE-FIXES.md) for the current assessment and validation.

# Second review of the v3.0 draft

**Historical findings, now fixed.** The text below records the pre-fix review. See [ITERATIVE-FIXES.md](ITERATIVE-FIXES.md) for the subsequent fixes and validation. `../tests/second-pass.test.cjs` now asserts the corrected behavior and runs in the regression suite.

September 5, 2026. Reviewed the current local `fix/reliability-refactor` working tree, including the engine, page adapter, popup, generated console entry point, packaging/CI, and test assumptions. This is a review, not an additional implementation pass.

The refactor is substantially easier to reason about, and the 27 existing regression tests still pass. However, **two P1 and two P2 findings remain**. The earlier fix-completion report was too strong: the fixture coverage did not establish all of the intended safety properties.

## 1. [P1] UI fallback discards the API's selected IDs

Locations: `cleaner-core.js:180–191,201–206`; `content.js:128–139`.

After a complete API scan, the engine has selected the videos matching the requested threshold. If an edit fails, it invokes fallback with only the threshold and cancellation callbacks. The fallback independently selects rows using their DOM progress. The DOM is deliberately left unchanged by API operation and can have older progress information than the API—for example, after watch history changes in another tab. It can therefore remove a video the API snapshot explicitly excluded.

Reproduction: the API reports `selected=100%` and `keep=0%`, while the stale DOM reports both at 100%. At an 80% threshold, unsuccessful batch edits lead the actual fallback loop to request removal of **both** IDs. The fixture substitutes row inspection/click execution to avoid a real deletion; the engine's selection, retry, handoff, and fallback iteration are the production functions.

Fix: when a complete API selection exists, pass the remaining eligible setVideoIds into fallback and require membership before clicking. Keep the explicitly degraded DOM-only selection mode separate for cases where the initial API scan never succeeded. Test conflicting API/DOM progress, not only fixtures where they agree.

## 2. [P1] A supported response wrapper can hide another continuation

Locations: `cleaner-core.js:51–54,61–77`.

The parser accepts `continuationContents.playlistVideoListContinuation.contents`, but does not read that container's `continuations[].nextContinuationData.continuation`. It returns null unless the token appears as a separate item in the contents array. This changes “another page exists” into “complete scan,” which affects target selection, uncertain-edit verification, and final completion verification.

Reproduction: page 2 has a kept video and a container-level token for page 3, which has a matching video. The actual engine never requests page 3, repeats the same truncated scan for final verification, and finishes with `phase: done`. This is the false-success failure class the refactor was intended to eliminate.

The response wrapper is explicitly handled in [yt-dlp's playlist extraction code](https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/yt_dlp/extractor/youtube/_tab.py), while container-level continuation metadata is also supported by [YouTube.js continuation parsers](https://raw.githubusercontent.com/LuanRT/YouTube.js/main/src/parser/continuations.ts). The reproduction establishes the code defect for that shape; it does not establish how often current Watch Later accounts receive it.

Fix: parse continuation metadata together with its owning list container. Reject unrecognized nonempty continuation metadata rather than interpreting it as end-of-list. Add an end-to-end truncated-verification regression case.

## 3. [P2] Stale status replies can overwrite newer popup events

Locations: `popup.js:59–61,95–103,122–125`.

The runtime-event handler checks tab/run identity, but awaited status replies go straight to `render()`. An older status query can finish after a newer state event. Its result replaces the live state and can change Stop back to Start while cleaning continues. The refresh sequence counter only compares refresh invocations; it does not detect an intervening state event. The post-command status query has the same omission.

Reproduction: hold the initial idle status reply, deliver a running state event (the button correctly becomes Stop), then release the earlier reply. The final button is Start Cleaning even though the newer event says the engine is running.

Fix: introduce a document/run/state revision and use one acceptance check for both response snapshots and pushed events. Also recheck tab/document identity after every status await, not only before it. Tests currently deliver status snapshots immediately and cannot expose this race.

## 4. [P2] Stop during a UI deletion omits the uncertain-outcome warning

Locations: `content.js:123–126`; `cleaner-core.js:205–206,229–230`.

The uncertain-mutation flag is set only for API edits. Native menu deletion can already be in flight when Stop aborts the wait for the row to disappear. That cancellation skips `onRemoved()`, leaving observed/count at zero, while the terminal state says only Stopped with `uncertain: false`. YouTube's own request is not canceled by the extension's API transport controller and can still complete.

Reproduction: stop while the UI fallback is waiting on an outstanding native action. The actual core produces `observed: 0`, `uncertain: false`, and `message: Stopped.`. The menu code confirms there is no start/settle callback surrounding the actual click.

Fix: track native UI mutation start and settlement as well as API requests. Cancellation before settlement must retain the unknown outcome and report that the click may still complete. Do not imply that aborting the wait canceled YouTube's request.

## Evidence and assessment

At review time, four isolated scripts reproduced these defects while all 27 existing tests passed. The reproductions have since been converted into intended-behavior tests in `tests/second-pass.test.cjs`.

The existing Firefox 128/155 tests are valuable evidence for compartment crossing and basic API/UI flows. Their synthetic backend uses one continuation style, agrees with DOM watch progress, does not model delayed popup status replies, and tests cancellation during an extension-issued fetch rather than an outstanding native menu request. Passing them does not resolve the findings above.

Assessment: a substantial improvement over v2.4, but not ready for store release. Address findings 1 and 2 first, then state ordering and UI cancellation. No live signed-in account was altered during this review; production source was left unchanged.

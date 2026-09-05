# Iterative fixes and follow-up review

September 5, 2026. Local branch `fix/reliability-refactor`. This report records the local validation before repository cleanup and branch publication. No signed release or store publication was performed.

## First repair pass

All four findings in SECOND-PASS.md are addressed:

- API-to-UI fallback carries the selected playlist-entry IDs. Stale DOM progress cannot expand that selection. DOM-only filtering remains available when no complete API snapshot exists; unknown row identities cannot match an API selection.
- Pagination retains each list's owning container and reads `nextContinuationData`. Missing, unknown, conflicting, or ambiguous continuation structures fail closed. A malformed later continuation cannot borrow a token from an earlier item.
- Engine states carry a document UUID and monotonic revision. Popup events and status snapshots share an acceptance gate. Pending replies also check refresh/event epochs, including the status query after Start/Stop. New documents can reset run numbering; foreign-document events cause a fresh status lookup.
- Native menu clicks mark the run as potentially unresolved before dispatch. Stop or timeout preserves uncertainty; a DOM disappearance alone does not clear it. A complete API verification can resolve it. A timed-out click stops further native actions.

## Follow-up findings and fixes

Reviewing the repairs exposed additional edge cases, also fixed:

- Partially applied API batches could leave already-removed IDs eligible for fallback. Reconciliation now records confirmed absent IDs and excludes them from subsequent clicks.
- Falling watch progress could conceal an undeleted original target in final verification. Verification checks original selected IDs as well as currently matching videos.
- UI/logging observer exceptions could interrupt lifecycle cleanup and strand a run. Observer failures are isolated from engine state transitions and task settlement.
- A menu endpoint could contain a matching removal plus additional edits. Native fallback now accepts exactly one matching removal action.
- An older command's completion could unlock controls during a newer refresh/command. Command epochs protect cleanup, and refresh disables actions while resolving the active tab.
- A storage read failure's filter warning was immediately overwritten by Ready. The warning now remains visible before starting.

## Validation

- `npm test`: 38 passing tests, including the four former defect reproductions, malformed/ambiguous pagination, partial-edit handoff, observer failures, changing watch progress, multi-action menus, and delayed popup replies/document replacement.
- Real Firefox 128.0 and 155.0.1: seven extension scenarios plus the generated console entry point pass on each. The expanded fixture traverses three pages using container-level continuation metadata, deliberately disagrees with DOM watch progress, and dispatches a native removal that finishes after Stop.
- Original append-action/continuation-item response fixtures remain covered by Node tests. The Firefox suite also passed with that response shape before the final container-metadata expansion.
- Generated console bundle rebuilt. Packaged XPI has exactly the six intended files, each byte-identical to working source.
- JavaScript/shell syntax checks and `git diff --check` pass.
- `web-ext lint`: no errors or notices; two known minimum-version warnings for the data-collection declaration (desktop introduction 140, Android 142). The declaration is retained; actual desktop Firefox 128 execution passed. Android compatibility is not claimed.

## Final assessment

No remaining confirmed blocker was found in the final review of engine selection/reconciliation, fallback dispatch, pagination, cancellation, popup ordering, and packaging. This is evidence for the tested behavior, not a guarantee against changes to YouTube's private API or page UI.

All browser requests and mutations were confined to a local synthetic YouTube fixture. Live authentication and current signed-in YouTube response variants have not been validated through destructive account operations. A controlled live smoke test remains the release-validation gap.

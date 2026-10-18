# Journal day semantics

A journal day requires writing under the ECMAScript whitespace rule. Scores do not create a day.
Substantive bodies keep their exact bytes, including surrounding spaces and line breaks.

The page's content stamp also protects against delayed offline writes. Clearing an account page
therefore retains an invisible ordering marker in the sync store. Ordinary reads, exports, day
counts and nudge checks use written-body visibility; sync and HLC delta feeds retain the marker.
New blank drafts create no page command. Erased anonymous claims are superseded without a
replacement claim, while invitation retirements remain durable.

The engine counts retained work to protect account transitions. Those pinned tokens are not a
displayed page count. Journal's sign-in projection counts unique written days, includes editor and
recovered drafts, and automatically adds state-only work without a personal-data question. Blank
legacy claims preserve the account's body, scores and source. Meaningful writing still requires the
existing Add/Discard decision when the account already has pages.

The Swift prediction builder shares the ordinary text-delta builder. Both omit unchanged text and
retain actual erasure deltas, matching the reference and Kotlin engines. Whitespace predicates live
in SyncCore on native surfaces so visibility, claims and journal documents share one rule.

Regression coverage spans new blank drafts, ratings-only legacy rows, Unicode whitespace,
oversized whitespace with invalid scale metadata, write/erase/rewrite across sync and restart,
REST visibility, raw erasure feeds, nudge counts and state-only adoption. The focused native sync
run includes all 1,601 corpus vectors. The domain and web journal suites pass. Real browser/server
verification passes all ten scenarios, including erasure across clients and reload, ordinary REST
visibility, state-only adoption, sign-out and account isolation. Native UI checks confirm blank
ratings-only days and erased writing remain absent after relaunch.

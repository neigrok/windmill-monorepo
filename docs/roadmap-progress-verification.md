# Roadmap progress verification

Roadmap progress is `complete` or `none`. Prerequisites derive `locked`, `available`, or
`complete`. Legacy `active` and `inProgress` values normalize to `none` at storage, import,
and sync boundaries. Completed marks remain intact.

The desktop detail has a static status and one Complete / Reset action. Phone and list
controls use Mark done / Mark not done. The status selector, Start action, authored reset,
keyboard-help button, Activity pin, and empty detail sections are absent. The current
bubble layout, Focus, All steps, pointer zoom, editing, and sharing remain available.

## Verification — 10 September 2026

- Backend: 949 domain, 267 MCP, and 941 PostgreSQL adapter cases pass, with no skips.
- Web: 1,772 tests pass, with no skips, on the integrated bubble-layout branch.
- Migration: an isolated PostgreSQL database holds legacy fixtures in `node_progress`,
  `tree_nodes`, and `trees.document`. Full before/after comparisons match only the expected
  status changes and clearing obsolete `out_of_order`; completed rows, timestamps, HLC
  stamps, and every other field are unchanged. Reapplying the schema is idempotent.
- Desktop browser: Complete, Reset, bulk MCP completion, both legacy alias writes, reload
  persistence, and removed control checks pass against the local C++ backend.
- Phone browser at 390 × 844: remote completion, prerequisite unlock, reset, offline
  completion followed by reconnect, persisted reload, and tree/list navigation pass.
  The shared view offers no completion or editing controls. No runtime exceptions occur
  in the final runs.
- The account's four saved roadmaps contain no in-progress marks. Twenty marks were reset;
  all pre-existing completion sets compare unchanged.
- Figma has 18 node variants across six kinds and three derived states. Day/night detail
  and toolbar drawings and desktop/mobile marketing fixtures reflect completion-only progress.

## Structure observations

Private progress adoption checks ownership independently of the viewport layout. Phone and
tablet owners therefore receive restored and remote progress. A remote batch computes its
completion and unlock events once from the final overlay, including steps with several
newly completed prerequisites; it never re-enters the local write path.

The removed controls have no residual handlers, menu state, or dedicated styles. Generic
prompt motion uses the shared `wm-soft-pulse` name with one reduced-motion definition.
The existing available-fill difference between DOM and WebGL remains recorded in
`design/consistency.md`, entry 1e.

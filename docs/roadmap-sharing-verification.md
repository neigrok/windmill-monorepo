# Roadmap sharing verification

Sharing publishes an owner's roadmap as public before copying its canonical link. The dialog
discloses public viewing, forking and gallery eligibility. Publication errors remain retryable;
clipboard errors leave the link available for manual copying. Owners can make the roadmap private.

## Verification

- Adversarial review and the simplification pass are complete. Legacy image-sharing history and
  preferences are purged by tree deletion and account cleanup.
- All 134 targeted tests passed. An isolated copy of the committed base plus the sharing changes
  passed `npm run build`: 1,620 tests, zero failures or skips, production bundles and landing shells.
- The shared working-tree build passed 1,664 of 1,665 tests. Its failure is the unrelated edited
  landing page's Start free destination in `web/index.html`; those landing changes are excluded.
- The backend server target rebuilt successfully. Live Postgres, backend and Vite browser checks
  covered MCP edits appearing without reload, explicit publication, persisted public visibility,
  signed-out viewing, failed publication without copying, retry, native clipboard copying,
  selectable clipboard fallback and private revocation.
- Sharing invoked no canvas image capture or image upload and exposed no download controls.
  The 390px unlisted-owner dialog wrapped its actions without horizontal overflow.

Clipboard denial immediately after publication leaves a selectable link; selecting it manually
works. Automatic selection was observed on a subsequent Copy link attempt, not the first one.

## Structure observations

The share dialog owns one visibility-and-copy pipeline. Image/video encoders, periodic sharing
offers, their storage model and the media encoder dependency are absent. Gallery SVG portraits
remain because the gallery and showcase use them; their export-only period rendering is removed.
Existing server link-preview routes can serve stored assets or a generic fallback, independently
of the share action.

The design mapping and current copy are in `design/roadmap/guidelines/sharing.md`.
The local MCP returned `no such tree` for dogfood tree `t_9362d9bc883e0a1e`; no connected Windmill
MCP tool is available, so the dogfood progress update remains pending.

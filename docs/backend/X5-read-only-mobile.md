# Backend tasks — X5 Read-only & mobile

The frontend ships the **read-only mode + responsive phone/tablet layout** (bottom sheet,
tablet side panel, mobile chrome, touch grammar). Read-only is triggered by a `?view` URL
param and auto-on for phone/tablet widths. The pieces below need the backend; the Fork CTA
and the fork "door" UI exist on the frontend but the actual fork is **stubbed** until this lands.

Spec: `explorations/read-only-mobile.html` (X5) in the Claude Design project.

## Tasks

1. **Public read-only tree route.** A public, no-auth endpoint that serves a tree for viewing
   at `windmill.app/t/:treeId` (the frontend renders it read-only): structure, names, kinds
   (+ the F6 legend), descriptions, and progress. `GET /v1/trees/:id` may already serve most
   of this — ensure it's public-safe and returns the legend + descriptions. The hosted route
   itself (`/t/:id`) is client-rendered; the backend just needs the data to be publicly fetchable.

2. **Fork — the page's one verb.** Fork plants a copy of the tree in the actor's gallery:
   - **Copies**: structure, names, kinds, descriptions (all steps). **Resets**: progress (root
     wakes as the first available step; crown re-earned). **Records lineage**: forked-from
     author + source tree id (shown on the plaque and the gallery card, permanently).
   - **Signed in** → instant fork, returns the new tree id.
   - **Signed out** → X4's "one door": POST an email; the server holds the fork **pending
     server-side behind a magic link**; the link completes the fork AND creates/authenticates
     the account. Killing the tab costs nothing. (Frontend has the door UI + "check your email"
     state; wire `POST /v1/forks` { sourceTreeId, email? } → magic link, and the link-completion
     endpoint.)

3. **Gallery listing.** An endpoint returning public trees for browse, with the fields the
   cards need: title, dominant kind, progress (done/total), author, lineage, recency, finished
   flag. Order chips: **Popular · New · Finished**. **Open product question**: what ranks
   "Popular" — forks, finishes, or recency-decay? No fork/view/like counts appear on cards until
   this is decided. (Frontend gallery is deferred — this unblocks it.)

4. **Deploy / PWA.** The frontend sets `theme-color` (`#F9F5EB` light / `#0D0B07` dark) and the
   viewport. If a PWA/installable experience is wanted, host a web manifest. (The env-configurable
   backend URL + static deploy workflow already added covers the hosting side.)

## Notes

- These depend on the **multi-tree registry** the F2 decision put in the backend (per-user trees,
  create/list/delete) — the gallery and fork both need it. See `docs/backend/F6-color-legend.md`
  for the related legend/progress/workspace stores that also want backend homes.
- Read-only served data must not expose editing-only internals; a shared tree shows the author's
  progress snapshot, a forked tree shows the viewer's own.
- **Deferred to a later frontend pass** (not backend): mark-steps-done from the phone sheet, the
  gallery browse UI, and a full dark-theme token set + dark WebGL canvas ("constellation by night").

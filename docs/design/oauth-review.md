# OAuth consent review

## Structure

The authorization screen owns its presentation in `web/src/shell/auth/OAuthConsent.jsx`.
Scope parsing and capability wording belong to `scopes.js`; client verification and decision
requests belong to `OAuthClient.js`. Visual changes must preserve those boundaries.

Product groups provide the permission hierarchy. Individual permission rows need no separate
surface or heavy type. Permanent deletion needs explicit copy and readable contrast.

## Verification

Source review confirms semantic product headings and permission lists, the three scope-reach
branches, explicit deletion copy, theme-token colors, and a reduced-motion success animation.

The coordinating agent ran `npm run build`: 1,665 tests passed with zero failures or skips,
and rebuilt the backend server target. A disposable-account browser check on the local
Postgres/backend/Vite stack covered desktop dark and light themes, a 375×667 dark viewport
with the footer reachable by scrolling, visible Cancel focus through keyboard Tab, and
"Not you?" signing out to the "Connect your tool" gate.

Reduced motion and other screen states received source review only. The scope suite covers
empty account-wide and unreadable grants. Production Allow was not clicked.

The dogfood progress tree could not be updated because no Windmill MCP tracker tool is
connected in this session.

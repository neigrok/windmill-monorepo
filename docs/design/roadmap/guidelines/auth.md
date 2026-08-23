# Windmill Authentication — claiming, not gating (X6)

The canonical spec for the whole auth layer: the method set, the one door, the
magic-link lifecycle, the claim moment, the settings home, and sessions.
Signing in **claims** your roadmaps; staying signed out never blocks building
one. X4's old §2 sketch (dialog, entry, transition) graduated here — X4 keeps
only the sync pill and the account seat. F7 sync rides this session; the F17
grant borrows it (`mcp-connect.md` §3). Live specimens:
`explorations/auth-claiming.html`.

> **Principle: the worst case of auth is the product's normal signed-out
> state.** No walls, no nudges, no performed security — safety is stated as
> specifics, and every failure ends in a next step.

---

## 1. The method set — decided

- **Magic link leads.** Works for every human with an email address, nothing
  to remember, nothing to steal. The button is the honest verb: "Email me a
  link" — and on the native apps, "Email me a code": same door, same mint, the
  credential shaped for the surface (§3, revised 2026-08-09).
- **Google is a quiet secondary** — a ghost button below the primary, an
  accelerator, never an identity strategy. Renders Google's official button
  per their brand rules (never a hand-drawn G). Same account either way,
  **keyed by email**.
- **Passwords never exist.** No reset flows, no strength meters, no stuffing
  risk — the magic link *is* the reset flow.
- **GitHub waits** until the dev wedge demands it; the ghost-slot pattern
  takes a second provider without redesign.
- **One door:** no sign-in / sign-up fork, no tabs — the email decides.
  "New here? Same door — your account is created the first time."

## 2. The door & entry — strict

- **The seat menu is the only unprompted mention of sign-in in the entire
  product.** Account verbs (Share, Invite, Connect) open the same dialog as a
  user-pull and **resume after** sign-in — the user never re-finds their place.
- **Never:** on launch, on a timer, after N edits, on exit intent, as a
  banner, or as a "save your work" nudge. Nothing counts how many times the
  user declined. Viewing a shared tree never requires an account.
- **Dialog anatomy:** wordmark · "Sign in" · the one-door line · email field ·
  "Email me a link" · ghost "Continue with Google" · the reassurance line
  ("No password. Signed out, Windmill still works — your trees live on this
  device."). Standard Dialog physics: `wm-fade-in-up`, esc/scrim dismiss
  always free, product alive behind it.

## 3. The link lifecycle

- **Send:** "Sending…" with a breathing gold dot, shown only past **800ms**.
- **The wait state:** "Check your email" · the address shown (typos are the
  #1 failure) · the contract stated ("It works once and lasts 15 minutes.") ·
  "Use a different email" · **Resend appears after 30s** — absent while it
  would only invite double-sends.
- **The landing (revised 2026-08-09 — link on the web, code in the apps):**
  the original "link only, no codes" decision died against a real first run: a
  tapped link opens the *web* and is spent there, leaving a native app with a
  dead paste flow. So the credential now matches the surface. **Web:** the link
  opens the app in a new tab, signed in; local state makes the new tab the old
  place (same tree, zoom, selection). **The original tab detects the session
  and wakes its seat too** — no orphaned tab nagging. Opened on a different
  device: that device signs in and trees flow to it — a feature, not an edge
  case. **Native apps:** the mint carries `door:"app"` and the mail carries a
  **6-digit code** to type — nothing a browser or mail scanner can burn. The
  code field still accepts a pasted link (old emails, cross-surface requests).
  Same lifecycle either way: works once, 15 minutes, resend at 30s.
- **Unhappy states — gold, never a wall:**
  - Expired / already used (one screen — the remedy is identical):
    "That link has expired · Links work once and last 15 minutes ·
    Email me a fresh one."
  - Typo, inline before sending: "That address looks unfinished — check the
    ending." (gold field ring, no red)
  - Rate-limited: "That's a few links in a row · Check your spam folder
    first — or try again in 10 minutes."
  - Server unreachable — **the only brick**: "Can't reach windmill.works ·
    Your trees are safe on this device · Retry."
- Every failure ends in a next step: a fresh link, a fixed address, a wait
  with a reason, a retry.

## 4. Claiming — local trees become yours

The signed-out → signed-in transition is an **adoption**: additive, narrated,
uncelebrated.

- **The beat** (X4's transition, now owned here): ghost seat cross-fades out,
  initial avatar **wakes** (the bloom's wake shape, 480ms soft) · chip
  narrates "Syncing your trees…" (gold, breathing) → "Synced" (olive, 1.5s) →
  silence · each registry card's tag flips "on this device" → "synced" in
  150ms as it lands. No ceremony, no confetti, no counting toast — the tree
  itself never reacts. Reduced motion: 150ms cross-fades, no scale, static dot.
- **Adoption rules:**
  | Situation | What happens |
  |---|---|
  | Fresh account | Local trees become the account's — nothing to review |
  | Account already has trees | **Union.** Nothing merges by content; same-name trees coexist |
  | Same tree known on both | F7 sync rules — per-field merge; only a true collision shows X4's two-versions card |
  | Second device signs in | Account trees flow down; its local trees union up |
  | Sign out | Local copies stay, editable — no confirmation dialog |
  | Sign back in | Offline edits sync up as a plain sync, not a ceremony |
- **Adoption is always additive** — no screen ever asks "keep local or
  cloud?"; that question exists only per-field, later, in sync's conflict card.

## 5. The settings home — windmill.works/settings

A full page (decided), plain account chrome shared with `/connect`, reached
from the account menu's "Account settings" row. **Four sections, nothing else:**

1. **Profile** — name (editable), email, how you sign in. Initial avatar, no
   photo upload in v1.
2. **Connected tools** — F17's connections list, verbatim. LLM grants and
   browser sessions are **separate lists with separate revokes** — pulling
   Claude's key never signs your phone out.
3. **Sessions & devices** — device · place · recency, "THIS DEVICE" tag,
   quiet × to revoke, plus **"Sign out everywhere"** (other devices keep
   local copies, per the standing promise).
4. **Your data** — export and delete together, no "danger zone" theater:
   - **Export:** `windmill-export.zip`, one `.md` per tree in **F3's grammar
     exactly** (headings, indents, `[x]` progress, notes; kinds ride as `##`
     branch names + the legend line). The export format is the paste format —
     paste any file back and it replants. Trust as a round trip.
   - **Delete:** the row expands in place. Copy states the deal: closes in
     **30 days**, synced copies and share links go, device trees stay, the
     Markdown archive is emailed first. Confirmation = **typing your own
     email** (catches the wrong-account case that "type DELETE" theater never
     does). Button is brick — the only brick in all of X6. After: quiet chip
     "Account closing · {date}", every session and grant signed out.
     **The undo is just signing in** within 30 days.

## 6. Sessions & trust

- **90-day rolling session**, silently refreshed by use, per device.
- **Lapse is a non-event:** the seat quietly returns to the ghost icon — no
  modal, no toast, no redirect. Editing continues; saves go local, exactly
  like signed-out. The menu explains: "Your sign-in expired. Everything's
  still here — sign in to keep syncing."
- **Mid-flow expiry** (server rejects a sync): chip shows "Signed out — saved
  on this device" (neutral, persists); never interrupts the edit. The visible
  moment — seat/chip choreography, and the visitor's downgrade + fork offer —
  is specced in `honesty.md`.
- **Re-auth** = the same one door, then the claim beat replays as a plain sync.
- **F17 grant while signed out:** sign-in first, then the grant (sealed in
  `mcp-connect.md` §3).
- **Trust copy:** state specifics (lifetimes, locations, last-active, revoke
  buttons that work); never perform security (no badges, locks, "bank-level",
  exclamation points). X4's copy canon inherited whole: never scare, never
  sell, never gate.

## 7. Copy — every string

| Where | String |
|---|---|
| Dialog | "Sign in" · "New here? Same door — your account is created the first time." |
| Primary / secondary | "Email me a link" · "Continue with Google" |
| Reassurance | "No password. Signed out, Windmill still works — your trees live on this device." |
| Sending | "Sending…" (breathing dot, only past 800ms) |
| Wait state | "Check your email" · "We sent a link to {email}. It works once and lasts 15 minutes." · "Use a different email" · "Resend" (after 30s) |
| Expired / used | "That link has expired" · "Links work once and last 15 minutes." · "Email me a fresh one" |
| App door — primary | "Email me a code" |
| App door — wait state | "Check your email" · "We sent a code to {email}. It works once and lasts 15 minutes." · numeric field "6-digit code" (accepts a pasted link) |
| App door — expired / used | "That code has expired. Codes work once and last 15 minutes — send a fresh one." |
| App door — reassurance | "No password. What you make on this device is claimed by your account when you sign in." (per-surface truth; the web keeps its own line — divergence question open in consistency.md 0s) |
| Typo | "That address looks unfinished — check the ending." |
| Rate-limited | "That's a few links in a row" · "Check your spam folder first — or try again in 10 minutes." |
| Unreachable | "Can't reach windmill.works" · "Your trees are safe on this device." · "Retry" |
| Claim chip | "Syncing your trees…" → "Synced" |
| Expired session | "Your sign-in expired. Everything's still here — sign in to keep syncing." |
| Delete | "Delete in 30 days" · "Account closing · {date}" · "Sign in any time before then to undo." |

## 8. Constants — copy into the build

```
METHOD     magic link leads · Google ghost secondary (official button) · no passwords
           one door, account keyed by email · GitHub deferred
ENTRY      seat menu = the only unprompted mention · verbs pull the same dialog + resume
LINK       works once · 15 min · resend at 30s · "Sending…" past 800ms
LANDING    web: link · apps: 6-digit code, typed (paste-a-link fallback) · new tab restores state · old tab wakes itself
CLAIM      seat wake 480ms soft · chip gold→olive→silence · tags flip 150ms · additive union
SETTINGS   windmill.works/settings · 4 sections · sessions ≠ grants · sign out everywhere
EXPORT     .zip of .md · F3 grammar · round-trips through paste
DELETE     typed email · 30-day grace · undo = sign in · the only brick in X6
SESSION    90d rolling, refreshed by use · lapse = ghost seat, no modal · re-auth = plain sync
```

## 9. Ownership map

| Concern | Owner |
|---|---|
| Beat physics, reduced motion | `motion-language.md` |
| The pill, the seat, conflict resolution | X4 (`explorations/account-sync-chrome.html`) |
| Per-field merge rules, sync engine | F7 / X4 §4 |
| MCP grant flow (borrows this session) | `mcp-connect.md` |
| Export/paste grammar | `paste-import.md` |
| Method, dialog, link lifecycle, claiming, settings, sessions | **this doc** |

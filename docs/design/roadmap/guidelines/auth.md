# Authentication — claiming, not gating

The spec for the auth layer: the method set, the one door, the magic-link lifecycle, the
claim moment, the settings home, and sessions. Signing in **claims** your roadmaps;
staying signed out never blocks building one.

> **Principle: the worst case of auth is the product's normal signed-out state.** No
> walls, no nudges, no performed security — safety is stated as specifics, and every
> failure ends in a next step.

## 1. The method set

- **Magic link leads.** "Email me a link" on the web, "Email me a code" on the native
  apps — same door, same mint, the credential shaped for the surface (§3).
- **Google is a quiet secondary** — a ghost button below the primary, rendered as Google's
  official button. Same account either way, keyed by email.
- **Passwords never exist.** No reset flows, no strength meters.
- **One door:** no sign-in / sign-up fork, no tabs — the email decides.

## 2. The door & entry

- **The seat menu is the only unprompted mention of sign-in in the product.** Account
  verbs (Share, Invite, Connect) open the same dialog and **resume after** sign-in.
- **Never:** on launch, on a timer, after N edits, on exit intent, as a banner, or as a
  "save your work" nudge. Viewing a shared tree never requires an account.
- **Dialog anatomy:** wordmark · "Sign in" · the one-door line · email field · "Email me a
  link" · ghost "Continue with Google" · the reassurance line. Standard Dialog physics:
  `wm-fade-in-up`, esc/scrim dismiss always free, product alive behind it.

## 3. The link lifecycle

- **Send:** "Sending…" with a breathing gold dot, shown only past **800ms**.
- **The wait state:** "Check your email" · the address shown · "It works once and lasts
  15 minutes." · "Use a different email" · **Resend appears after 30s**.
- **The landing — link on the web, code in the apps.**
  - **Web:** the link opens the app in a new tab, signed in; local state makes the new tab
    the old place (same tree, zoom, selection). The original tab detects the session and
    wakes its seat. Opened on a different device: that device signs in and trees flow to it.
  - **Native apps:** the mint carries `door:"app"` and the mail carries a **6-digit code**
    to type. The code field also accepts a pasted link.
  - Same lifecycle either way: works once, 15 minutes, resend at 30s.
- **Unhappy states — gold, never a wall:**
  - Expired / already used, one screen: "That link has expired · Links work once and last
    15 minutes · Email me a fresh one."
  - Typo, inline before sending: "That address looks unfinished — check the ending."
    (gold field ring, no red)
  - Rate-limited: "That's a few links in a row · Check your spam folder first — or try
    again in 10 minutes."
  - Server unreachable — **the only brick**: "Can't reach windmill.works · Your trees are
    safe on this device · Retry."
- Every failure ends in a next step.

## 4. Claiming — local trees become yours

The signed-out → signed-in transition is an adoption: additive, narrated, uncelebrated.

- **The beat:** ghost seat cross-fades out, initial avatar wakes (480ms soft) · chip
  narrates "Syncing your trees…" (gold, breathing) → "Synced" (olive, 1.5s) → silence ·
  each registry card's tag flips "on this device" → "synced" in 150ms as it lands. No
  confetti, no counting toast; the tree never reacts. Reduced motion: 150ms cross-fades,
  no scale, static dot.
- **Adoption rules:**

  | Situation | What happens |
  |---|---|
  | Fresh account | Local trees become the account's — nothing to review |
  | Account already has trees | **Union.** Nothing merges by content; same-name trees coexist |
  | Same tree known on both | Per-field merge; only a true collision shows the two-versions card |
  | Second device signs in | Account trees flow down; its local trees union up |
  | Sign out | Local copies stay, editable — no confirmation dialog |
  | Sign back in | Offline edits sync up as a plain sync, not a ceremony |

- **Adoption is always additive** — no screen ever asks "keep local or cloud?"; that
  question exists only per-field, later, in sync's conflict card.

## 5. The settings home

`windmill.works/app/settings` — a full page in the plain account chrome shared with
`/connect`, reached from the account menu's "Account settings" row. The sections this doc
owns:

1. **Profile** — name (editable), email, how you sign in. Initial avatar, no photo upload.
2. **Connected tools** — the connections list. LLM grants and browser sessions are
   **separate lists with separate revokes** — pulling Claude's key never signs your phone
   out.
3. **Sessions & devices** — device · place · recency, "THIS DEVICE" tag, quiet × to
   revoke, plus **"Sign out everywhere"** (other devices keep local copies).
4. **Your data** — export and delete together, no "danger zone" theater:
   - **Export:** `windmill-export.zip`, one `.md` per tree in the paste grammar exactly
     (headings, indents, `[x]` progress, notes; kinds ride as `##` branch names + the
     legend line). The export format is the paste format — paste any file back and it
     replants.
   - **Delete:** the row expands in place. Copy states the deal: closes in **30 days**,
     synced copies and share links go, device trees stay, the Markdown archive is emailed
     first. Confirmation = **typing your own email**. The button is brick — the only brick
     in the auth layer. After: quiet chip "Account closing · {date}", every session and
     grant signed out. **The undo is signing in** within 30 days.

## 6. Sessions & trust

- **90-day rolling session**, silently refreshed by use, per device.
- **Lapse is a non-event:** the seat returns to the ghost icon — no modal, no toast, no
  redirect. Editing continues; saves go local, exactly like signed-out.
- **Mid-flow expiry** (server rejects a sync): chip shows "Signed out — saved on this
  device" (neutral, persists); never interrupts the edit. The visible moment is specced in
  `honesty.md`.
- **Re-auth** = the same one door, then the claim beat replays as a plain sync.
- **An MCP grant while signed out:** sign-in first, then the grant (`mcp-connect.md` §3).
- **Trust copy:** state specifics (lifetimes, locations, last-active, revoke buttons that
  work); never perform security — no badges, locks, "bank-level". Never scare, never sell,
  never gate.

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
| App door — reassurance | "No password. What you make on this device is claimed by your account when you sign in." |
| Typo | "That address looks unfinished — check the ending." |
| Rate-limited | "That's a few links in a row" · "Check your spam folder first — or try again in 10 minutes." |
| Unreachable | "Can't reach windmill.works" · "Your trees are safe on this device." · "Retry" |
| Claim chip | "Syncing your trees…" → "Synced" |
| Expired session | "Your sign-in expired. Everything's still here — sign in to keep syncing." |
| Delete | "Delete in 30 days" · "Account closing · {date}" · "Sign in any time before then to undo." |

## 8. Ownership map

| Concern | Owner |
|---|---|
| Beat physics, reduced motion | `motion-language.md` |
| MCP grant flow (borrows this session) | `mcp-connect.md` |
| Export/paste grammar | `paste-import.md` |
| Capability-loss moments | `honesty.md` |
| Method, dialog, link lifecycle, claiming, settings, sessions | **this doc** |

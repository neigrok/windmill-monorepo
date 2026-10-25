# Account deletion reconciliation

The backend prerequisite for [Android task 48](../../androidgym_tasks/48-delete-account.md) is the
recoverable deletion contract in [AUTH](../../backend/AUTH.md#recoverable-deletion).
`DELETE /v1/me` accepts the confirmed account, operation UUID, private proof and original request
instant. `POST /v1/account-deletion/result` reads that operation after session revocation. Legacy
account-only deletion retains its response shape and 30-day grace.

## Structure and concurrency

Account closure and its immutable receipt commit in one Postgres transaction. `AuthService` hashes
the proof and session; the repository pins the account, rechecks its session, writes the receipt,
revokes sessions and OAuth grants, and stamps the existing grace deadline. OAuth table mutations
stay in `PgOAuthRepository` through its transaction overload. Session notifications run after the
commit; their failure leaves a recoverable receipt.

Both close paths preserve the first active deadline. Receipt replay after restoration returns the
historical result without closing the account again or touching the restored session. A new close
after explicit restoration uses a new operation. A five-minute request admission window and
35-day receipt expiry prevent an expired original tuple from becoming another close.

Closure and code issuance lock the user before the session. Token insertion locks the user before
its token and initial grant. Code consumption and refresh rotation commit before token insertion;
they hold no token/code locks while acquiring the user lock. Session refresh updates only its
session row. This avoids a reversed session/token-to-user lock order in these paths.

The account's OAuth generation advances on its first active close and survives restoration.
Authorization code insertion rechecks the exact original session under that user lock; codes and
refresh grants carry their admitted generation into token insertion. A late token or initial grant
cannot commit after closure or restoration. Access and refresh reads also require a live account
with the same generation. The schema initializes already-closed generation-zero accounts to one,
preserving live and nonzero generations on reapplication.

## Privacy and observation

The receipt contains only the account/operation UUIDs, a domain-separated proof digest, the request
instant and two deadlines. It has no user foreign key so it survives 30-day account erasure for at
most its remaining five-day recovery window. The retention sweep deletes expired receipts in
bounded batches; reads enforce expiry independently. A missing, expired or mismatched capability
returns the same unavailable result and proves neither success nor failure.

Receipt responses are private and non-cacheable. The proof remains in the request body and never
enters a URL, event or log. Each request has one write completion under `platform.DELETE.v1.me` or
`auth.account.closure.read`; unexpected failures produce one static Sentry issue. Generation,
account/operation IDs, proof/digest and deadline are absent from these properties. OAuth admission
races use the existing login-required/invalid-grant refusal paths. The backend introduces no
product event; Android task 48 owns client flow events and sealed pending state.

The simplification pass keeps the recoverable request branch inline in `deleteMe`, shares the
OAuth revoke transaction between both callers, and commits initial OAuth grant metadata with its
token rather than retaining a separate production write door.

## Verification — 2026-10-25

`cmake --build backend/build -j4` completes with the optimized project defaults. Both full serial
CTest recipes from `.claude/skills/verify/SKILL.md` pass all 10 entries. Every suite reports zero
stopped cases and zero failed assertions.

| Suite | Without Postgres: passed / total (skipped) | Isolated Postgres: passed / total (skipped) |
|---|---:|---:|
| Domain | 2203 / 2231 (28) | 2203 / 2231 (28) |
| MCP | 216 / 281 (65) | 281 / 281 (0) |
| Sync | 6 / 738 (732) | 738 / 738 (0) |
| Adapters | 787 / 1324 (537) | 1324 / 1324 (0) |

The 28 domain skips are 27 client-only corpus cases: commit 7, HLC 2, hold 2, journal 3, lineage 3,
machine 2, pull 1, refusal 4, view 2 and write 1. The remaining skip is the optional JavaScript
reference-pattern comparison because `WM_PATTERN_CASES` names no generated fixture. They are
reported as skips, not passes. Every Postgres-gated case runs in the isolated database recipe.

The 17 added cases cover HTTP recovery/refusal/privacy, atomic database rollback, concurrent close
and token insertion, both legacy/recoverable close orderings, restoration, erasure, retention,
OAuth generation/session admission, and applying the actual schema twice to historical closed
accounts. The migration keeps their old access token, refresh token and consumed code unusable
after restoration while preserving live/nonzero account generations.

The production binary on port 8108 passes 11 actual HTTP scenarios against a fresh isolated database:
lost close response followed by process restart; session revocation; same-operation recovery;
mismatched capability fields; magic-link restoration; historical receipt replay; injected SQL
rollback; same-operation retry; OAuth consent/exchange; old OAuth code/refresh rejection across
restoration; and new OAuth consent after restoration. Responses confirm route registration, CORS,
private/no-store caching, and no session-cookie clearing on historical replay.

A local TLS Sentry collector receives exactly one injected unexpected-failure Issue under
`platform.DELETE.v1.me`. Its captured envelopes exclude the proof, session/OAuth tokens, verifier,
magic-link token and raw fault message. The 12 closure/recovery request completions are six `ok`,
four `unavailable`, one `unauthenticated` and one `failed`; their only keys are operation, product,
door, outcome, duration_ms and request_id. The test server, collector and all three scratch databases
are removed. Android client verification belongs to task 48 and is outside this prerequisite.

Local evidence is in `/private/tmp/windmill-deletion-check`: `build-final.log`,
`no-postgres-final.log`, `postgres.log`, `http-final.log`, `report.json`, `server.log`, and
`owned-paths.txt`. `git diff --check` passes.

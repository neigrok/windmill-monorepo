// The words on the one screen that closes an account — kept pure, and kept apart from the section
// that draws them, because `node --test` has no JSX transform: a claim this consequential has to be
// assertable by a test, and a component is not. test/shell/settings/accountClosure.test.js is the
// only reason this is a module of its own, and it is reason enough.
//
// WHY IT TAKES THE PRODUCT NAMES AS AN ARGUMENT. Closing is the ACCOUNT's act, not a product's, and
// until 2026-08-07 this screen lived inside the roadmap and said "Synced copies and share links go.
// Trees on your devices stay." — a consent screen naming one product's data while the account behind
// it also holds journal pages and gym sessions. The shell may not name a product (the boundary test
// enforces it), so the list arrives from the registry through shell/products.js. A fourth product
// joins this sentence by existing.
//
// WHAT THESE LINES DELIBERATELY DO NOT SAY, and it is not an oversight. Every line below is one this
// was verified to actually do, by reading backend/platform/application/AuthService.cpp:230-242:
// closeAccount revokes every session, disconnects every OAuth grant, and stamps `users.deleted_at`.
// That is all it does — `markUserDeleted`'s own comment says "the trees are left untouched", nothing
// in the server ever hard-deletes a closed account's rows (`deleteUser` has exactly one caller, the
// empty-account fold at AuthService.cpp:142), and `revived()` at AuthService.cpp:154 puts no window
// on the undo at all. So the old "Your account closes in 30 days" and "Synced copies … go" were both
// claims the server does not keep, and the honest screen is the one that promises only the three
// things that really happen. When the server grows a reaper that enforces the grace, THAT is the
// wave that adds the erasure line back here — and it will have a test to hang it on.

import { joinLabels } from '../products.js';

// The deal, in the order it matters to the person about to type their own email: what happens the
// instant they press it, how wide it reaches, what it cannot touch, what to take with them, and the
// way back.
export function closingDeal(productLabels) {
  return [
    'Every device signs out and every connected tool loses its access, immediately.',
    `It closes the whole account, not one room — ${joinLabels(productLabels)} alike.`,
    'Anything held only on this device stays on this device.',
    'Export what you want to keep first — every export Windmill has is on this page.',
    'Signing in again is the undo, and it brings the account back whole.',
  ];
}

// THE CONNECTED LOG — the words, and the two rules that read what can reach this log. §D screens 12
// and 13, minus the price, which is the whole of W8's ruling and is worth stating here rather than
// in a wave note:
//
//   §D's headline was "The log is free. The connected log is Windmill One." Three separate things
//   make that sentence false. Gym's MCP tools read NO entitlement and never did — the gate was
//   drawn and never built. W7 settled the open question that left by opening Ask to everyone behind
//   a stated daily cap, so no feature in gym stands behind the plan. It is read in exactly one
//   place — AskService, where `aiAllowanceFor` picks which monthly dollar CEILING Ask spends
//   against — and that is the same room and the same tools at two heights rather than a door that
//   opens for one plan and not the other. (Saying gym reads `hasWindmillOne` nowhere would be
//   shorter and false, which is the mistake this whole file is about.) And nobody can buy Windmill
//   One in any case: `paidPlansOpen()` in shell/billing/checkout.js is a hardcoded false and
//   BillingApi 503s a checkout regardless.
//
// So this surface is an INVITATION and not a gate. It carries no lock, no tier chip, no price and no
// countdown, and nothing on it leads to a checkout — a card advertising a plan that gates nothing,
// cannot be bought, and whose button answers 503 would be three false claims in one frame, in a
// brand whose first rule is no copy that promises what the product does not do.
//
// EVERY SENTENCE BELOW IS A CLAIM ABOUT THE BACKEND, so each was checked against
// products/gym/adapters/mcp/GymToolCatalog.cpp rather than against the design. Three sentences did
// not survive that check and are NOT here:
//
//   · "it never writes to your program" — FALSE. `create_routine` is `gym:write` and lands
//     immediately, by decision: a day that did not exist takes nothing away. A safety promise that
//     is nearly true is worth less than none, because it is the one that gets believed. Neither is
//     the shortened version of it, "it proposes; the tap is yours", which describes ONE tool.
//   · "it cannot delete anything" — FALSE at `gym:delete`. `discard_session` deletes a workout and
//     every set in it, permanently, with no undo.
//   · "you can edit or delete it yourself" — the catalog's own justification for landing a new day
//     unasked, and the delete half is true on no surface we ship: nothing in the app deletes a
//     routine, and `gymApi.deleteRoutine` has no caller in web, iOS or Android. So what is promised
//     about a day an agent adds is the half a lifter can actually do.
//
// What IS true at every level is below, and it is a shorter list than the design's — which is the
// point of checking.

import { readScope } from '../../../shell/auth/scopes.js';
import { shortDayLabel } from '../log.js';

// ── Screen 12 · the pitch, which is one concrete exchange ────────────────────────────────────────

export const PITCH_TITLE = 'Your training log, inside your own Claude.';
export const PITCH_LINE =
  'Not a chat in another tab. The twelve weeks of squats you already logged, readable by the '
  + 'assistant you already use.';

// The whole card: a sentence you type on Sunday, and the object that lands on Monday. It is drawn as
// two sides of one trade rather than as a protocol diagram, because what a lifter is deciding is
// whether that trade is worth making.
export const EXCHANGE = {
  askedLabel: 'Sunday, in your own tool',
  asked:
    '“Look at my last twelve weeks of bench. Write me a four-week block — heavier triples, and '
    + 'swap the flies for incline work.”',
  landedLabel: 'Monday, in gym',
  landed: 'A proposal on Push A. You read the diff, you tap Apply, you train.',
};

// Three lines, and each is a fact about the build rather than a benefit.
//   1 · the workbench hands you one URL and your browser approves it (shell/connect/ConnectPage.jsx,
//       public/connect.html) — a static key exists as the fallback for a client that cannot do
//       OAuth, and it is not the way in.
//   2 · the W6 split, said whole. Half of it would be the sentence this file refuses above.
//   3 · one account across the three products, and NOT "one subscription": nothing in Windmill can
//       be bought.
export const PITCH_POINTS = [
  'Nothing to install and no API key to paste — one URL into the tool you already use, approved in your browser.',
  'It reads, and it proposes: a change to a day you already have arrives as a diff and waits for your tap. A brand-new day it adds lands right away — that takes nothing away, and the day is yours to edit in Routines.',
  'One account across Roadmap, Journal and Gym.',
];

// THE MOST HONEST LINE ON THE BOARD, and the design wrote it: this needs a tool a lifter already
// has, and a product that pretends otherwise sells a promise it cannot keep. The clients named are
// the ones both connect surfaces actually carry instructions for.
export const PRECONDITION =
  'Needs an AI tool of your own that speaks MCP — Claude Desktop, Claude Code, Cursor, Codex, or any '
  + 'other MCP client. If you haven’t got one, this one is not for you yet, and the log stays free '
  + 'regardless.';

// WHERE THE PRICE WAS. Not "free for now", no countdown and no founder's rate — those are the
// manufactured urgency this brand refuses. If a paid line ever arrives here it arrives with a
// checkout that works, and that wave rewrites this line.
export const FREE_LINE =
  'Connecting your log costs nothing, and neither does the log: the logger, your history, routines, '
  + 'records and the CSV are free. There is nothing in gym to buy.';

// THE INVITATION IS THE SURFACE MOST LIFTERS ACTUALLY MEET — Routines and every proposal card — and
// the room behind it is the one they have to navigate to. So it says the split whole, in one line,
// rather than the flattering half: "it proposes; the tap is yours" describes `propose_routine_change`
// and describes nothing else `gym:write` reaches, and a next block written as a NEW day is
// `create_routine`, which lands with no tap at all. The nearly-true version is the one that gets
// believed, which is exactly why it is not shorter here.
export const INVITATION_KICKER = 'The connected log';
export const INVITATION_LINE =
  'The tool you already use can read these weeks and write you the next block: a new day lands, and '
  + 'a change to a day you already have waits for your tap.';
export const INVITATION_VERB = 'Connect your log';
export const INVITATION_FREE = 'It costs nothing.';

// ── Screen 13 · the grant, in the lifter's words ─────────────────────────────────────────────────

// Said beside the DOOR rather than at the top of the room, because it describes what the door leads
// to: gym has words about a training log, and the account has the approval screen and the revoke.
export const GRANT_LINE =
  'Windmill speaks MCP, and one URL is the whole of it. The approval screen belongs to your account '
  + '— these are the words gym puts around it.';

// WHAT EACH LEVEL BUYS, IN GYM'S WORDS, and this is the one vocabulary: the landing draws the same
// three lines from here, so the sentence describing `gym:write` cannot say one thing on a marketing
// page and another in the room. Every clause is a tool in the catalog —
//
//   read    list_exercises · list_sessions · get_session · last_time · list_routines · get_stats ·
//           get_preferences
//   write   start_session · log_set · finish_session · create_routine · propose_routine_change ·
//           create_exercise · share_session
//   delete  discard_session · propose_routine_removal · revoke_share
//
// — so `write` names the new day it adds, the movement it can add to the catalog and the link it can
// mint, rather than only the half that waits for a tap, and `delete` names the workout it can
// destroy. `create_exercise` is named because it is the one `gym:write` tool with no clause of its
// own: a second row for a movement that already exists forks that lift's history across two ids
// permanently, and nothing merges them back.
export const LEVEL_LINES = {
  read: 'Read your log — sets, workouts, routines, records and how your gym is set up',
  write: 'Record what happened · add a new day or a new movement · propose changes to the days you have · share one workout by link',
  delete: 'Discard a workout · end a share link · propose a removal',
};

const LEVEL_ORDER = ['read', 'write', 'delete'];

// WHAT NO LEVEL BUYS. Three claims, each checked against the catalog, and the list stops there
// because a fourth would have to be invented.
export const NEVER = [
  'Change a day of your program that already stands. That arrives as a typed diff and waits for your tap — and the connection cannot tap it either: there is no apply tool at any grant level. Whichever way you decide, every workout already trained under that routine keeps the copy it was trained against.',
  'Edit or delete one set you logged. No tool at any level touches an individual set, so correcting what you lifted stays yours, in the app.',
  'See a level you did not approve. Delete is never implied by write, and a level you withheld is a tool the connection cannot so much as list.',
];

// AND WHAT A LEVEL DOES BUY, SAID BEFORE IT IS APPROVED RATHER THAN AFTER. The design's card said a
// connection "cannot delete anything"; `gym:delete` reaches `discard_session`, which is permanent
// and has no undo. Withholding that sentence would be the dark pattern, not the honesty.
export const APPROVE_WITH_CARE =
  'A level you approve is real reach: write records into your log without asking, and delete can '
  + 'discard a whole workout and every set in it — permanently, with no undo. Approve each one for a '
  + 'tool you would hand that to.';

// TWO DOORS IN, SO TWO DOORS OUT. A tool that approved a grant is disconnected in Connected tools; a
// personal key is a different credential in a different table and is revoked in API keys, and a
// sentence naming only the first would send half the people reading it to a section their key is not
// in. Both are the account's screens, and gym rebuilds neither.
export const DISCONNECT_LINE =
  'Disconnect a tool any time in Settings → Connected tools, and revoke a personal key in Settings → '
  + 'API keys. Either one stops every read at once and takes nothing away: every proposal already in '
  + 'your history stays, and so does everything the tool wrote into your log.';

// The workbench that holds the URL and the per-client steps. Gym contributes words and a link; it
// does not rebuild the account's consent flow, and a revoke drawn here would be a second door onto
// one decision.
export const WORKBENCH_HREF = '#/connect';
export const WORKBENCH_VERB = 'Connect a tool';

export const NOTHING_CONNECTED = 'No tool reads your log yet.';

// Drawn only under a personal-key row, because it is the one row on the list whose reach is wider
// than this product. The account's own API keys section says the same thing; this says it where the
// row is, so a lifter reading their gym's connections is not told a key is a gym connection.
export const PERSONAL_KEY_NOTE =
  'A key you minted yourself. It carries the whole account — every product, every level — because a '
  + 'personal key has no levels to pick.';

// ── The two rules that read a grant ──────────────────────────────────────────────────────────────

// EVERYTHING THAT CAN REACH THE TRAINING LOG, WHICH IS TWO CREDENTIALS AND NOT ONE. This list is
// what a card saying "no tool reads your log yet" is drawn from, so a door it cannot see is a screen
// telling somebody nothing is connected while something is reading — and discarding — their
// workouts.
//
//   · An OAUTH GRANT, per client and per level. The legacy account-wide grant — every token minted
//     before scopes existed carries an empty scope — reaches every product at every level, so it is
//     the widest grant this list can hold and it says so rather than being filtered out for naming
//     no product.
//   · A PERSONAL KEY, which is a static bearer minted in Connect → Advanced for a client that cannot
//     run OAuth (shell/auth/McpKeyClient.js). It lives in its own table and no grant row mentions
//     it, and platform/ports/McpKeyRepository.h mints every one of them account-wide (scope ''), so
//     every key on the account reads, writes and deletes in gym. There is no such thing as a key
//     that reaches this log less than completely, which is why no scope is read for one.
//
// A name is never blank: an OAuth client that never registered a display name comes back as an empty
// string (the join is a coalesce), and a row drawn from that is a state line under nothing at all.
export function connectionsToTheLog(grants, keys) {
  const rows = [];
  for (const grant of grants ?? []) {
    const scope = readScope(grant.scope);
    const gym = scope.products.find((each) => each.product === 'gym');
    if (!scope.accountWide && !gym) continue;
    rows.push({
      id: `grant:${grant.clientId}`,
      name: grant.name || grant.clientId,
      since: grant.grantedMs,
      levels: scope.accountWide ? LEVEL_ORDER : gym.levels,
      personal: false,
    });
  }
  for (const key of keys ?? []) {
    rows.push({
      id: `key:${key.id}`,
      name: key.name || 'Unnamed key',
      since: key.createdMs,
      levels: LEVEL_ORDER,
      personal: true,
    });
  }
  return rows;
}

// THE STATE LINE, AND THE FRESHNESS IT DELIBERATELY DOES NOT CLAIM. §D draws `connected · read 2h
// ago`, which needs a per-connection last-read of THIS log. Nothing records one. What exists is
// `lastUsedMs` on the account's grant row, and it is a different fact three times over: it is
// touched by any token use rather than by a read, it counts writes, and it is account-wide — a
// connection that reaches roadmap too advances it by planting a node in a skill tree. So the row
// says the one thing that is observable: this tool is connected, and when it was granted
// (recordGrant keeps granted_ms as the earliest and never moves it).
//
// A card that invented a freshness it cannot observe is the same defect as a receipt that counts
// rows it never served, which this programme has already had once.
//
// A personal key was never "connected" to anything — nobody approved it on a consent screen, it was
// minted in one tap and then pasted somewhere this account cannot see — so the verb is the one that
// is true of it.
export function connectedLabel(row) {
  const verb = row.personal ? 'minted' : 'connected';
  return `${verb} ${shortDayLabel(row.since)}   ·   ${row.levels.join(' · ')}`;
}

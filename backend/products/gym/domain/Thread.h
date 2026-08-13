#pragma once

#include "products/gym/domain/Proposal.h"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// ── ASK HAS A PAST (§O, W11) ──────────────────────────────────────────────────────────────────
//
// W7 built Ask stateless on purpose and said so: the client resent the whole conversation on every
// ask, so there was no thread, no id and nothing to delete. The owner reversed it, and the reason is
// a product reason rather than a technical one — a conversation about your bench plateau is worth
// more in six weeks than it was that evening.
//
// THE LIST IS NOT A CHAT INBOX. Each row is the question in the LIFTER'S OWN WORDS plus what came of
// it, because that is what somebody comes back looking for. So the title is the first message
// verbatim, stored as sent and never touched again; nothing in this file, or anywhere behind it,
// summarises what a lifter typed.

// One turn, stored as sent — byte for byte, punctuation and emoji included. `fromLifter` is gym's
// own vocabulary rather than the vendor's (a lifter and Ask, not a user and an assistant), the same
// choice AskTurn makes at the wire.
struct ThreadTurn {
  bool fromLifter = true;
  std::string text;
  std::uint64_t atMs = 0;

  bool operator==(const ThreadTurn&) const = default;
};

// One proposal this conversation minted, projected to what an outcome is made of and to what the
// thread screen prints beside it. It is a PROJECTION rather than a ProposalHead because the outcome
// needs the one thing a head does not carry — the routine's NAME, which is what the row says out
// loud (`4 changes → Push A`) — and does not need a diff, a base revision or a summary to say it.
struct ThreadProposal {
  ProposalId id;
  ProposalState state;
  int changes = 0;
  RoutineId routine;
  std::string routineName;
  std::uint64_t createdAtMs = 0;

  bool operator==(const ThreadProposal&) const = default;
};

// A conversation. `turns` is EMPTY on the list read and whole on the thread's own — the same shape
// the log page takes, where a list carries the fewest rows its answer can honestly be computed from
// and the detail read carries the rest.
struct AskThread {
  ThreadId id;
  UserId user;
  std::string title;              // the first message, verbatim, written once
  std::uint64_t createdAtMs = 0;
  std::uint64_t askedAtMs = 0;    // the newest turn — what the list sorts and dates by
  std::vector<ThreadTurn> turns;
  std::vector<ThreadProposal> minted;

  bool operator==(const AskThread&) const = default;
};

// WHAT CAME OF IT — AND EVERY ONE OF THESE IS SOMETHING THE SERVER OBSERVED. That is the rule this
// enum exists to keep, and it is the reason there are five words here where the board drew three.
//
// The board draws a dismissed row reading `built it myself instead`. Nothing observes WHY a lifter
// dismissed a proposal and this product does not ask, so that line cannot ship: it would be us
// narrating a motive onto somebody's evening, one line under the rule that the title is your words
// and never a summary a model wrote about you. A dismissed row carries WHAT WAS DISMISSED — the
// count — and nothing about why.
//
// The two the board does not draw are the same rule pointing the other way. A thread whose proposal
// is still waiting has NOT been read only — the server watched it mint something — and drawing it as
// `no changes proposed` would be the false half of the same sin. `superseded` is the routine having
// moved underneath the proposal, which is likewise a fact and is not a lifter's dismissal.
enum class ThreadOutcomeKind { readOnly, proposed, applied, dismissed, superseded };

// The outcome, whole: the word, the count of changes it is about, and the routine they landed on
// where there is exactly ONE routine to name. Across two routines the name is empty and the count is
// the total, because `6 changes → Push A` under a thread that also moved Legs is a true number over
// a false noun, and this file does not ship those.
struct ThreadOutcome {
  ThreadOutcomeKind kind = ThreadOutcomeKind::readOnly;
  int changes = 0;
  std::optional<RoutineId> routine;
  std::string routineName;

  bool operator==(const ThreadOutcome&) const = default;
};

std::string toString(ThreadOutcomeKind kind);

// Derived, never stored — which is the point. The proposals ARE the outcome: an outcome column
// would be a second copy of a fact the ledger already holds, kept in step by whoever remembered to,
// and it would go stale the moment a lifter applied a proposal from the routine screen instead of
// from the thread. Nothing here can drift, because there is nothing here to keep in step.
//
// The ladder reads in the order a lifter cares about: something LANDED beats something waiting,
// waiting beats something they turned down, and a proposal the routine outran is the last thing left
// to say. A thread that minted nothing is `read only`, and that absence is the whole of it.
ThreadOutcome outcomeOf(const AskThread& thread);

// What a thread may weigh, in turns. A conversation about training that needs more than this is a
// different product, and the cap now bounds the PROMPT the server assembles rather than the request
// body a client sent — the same number, moved to the side that pays for it.
constexpr std::size_t kMaxThreadTurns = 8;

// How many threads the LIST read hands over, newest first. It bounds a screen and NOTHING ELSE —
// the export reads every thread there is (`allThreads`), because a ceiling that is honest on a
// screen is a lie in an archive.
//
// AND IT IS A CEILING THE CLIENTS MUST NOT NARRATE. `9 conversations · yours to delete` is the
// screen's own count of the rows it was handed, so past this number that sentence states a wrong
// fact about somebody's own data. The reply carries no total and will not grow one — a count the
// server sends is a number to compare against, which is halfway to the badge §O forbids — so a
// client can honestly print that sentence only while it holds FEWER rows than this, and must say
// nothing about how many once it holds exactly this many.
constexpr int kThreadList = 200;

}

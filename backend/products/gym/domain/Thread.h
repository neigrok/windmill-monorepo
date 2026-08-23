#pragma once

#include "products/gym/domain/Proposal.h"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// A thread's title is the lifter's first message verbatim, stored as sent and never touched again;
// nothing here or behind it summarises what a lifter typed.

// One turn, stored as sent, byte for byte.
struct ThreadTurn {
  bool fromLifter = true;
  std::string text;
  std::uint64_t atMs = 0;

  bool operator==(const ThreadTurn&) const = default;
};

// One proposal this conversation minted, projected to what an outcome is made of: it needs the
// routine's NAME, which a ProposalHead does not carry, and needs no diff, base revision or summary.
struct ThreadProposal {
  ProposalId id;
  ProposalState state;
  int changes = 0;
  RoutineId routine;
  std::string routineName;
  std::uint64_t createdAtMs = 0;

  bool operator==(const ThreadProposal&) const = default;
};

// A conversation. `turns` is EMPTY on the list read and whole on the thread's own.
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

// What came of a thread, and every word here is something the server OBSERVED — never why a lifter
// dismissed a proposal, which nothing observes and this product does not ask.
enum class ThreadOutcomeKind { readOnly, proposed, applied, dismissed, superseded };

// The word, the count of changes it is about, and the routine they landed on where there is exactly
// ONE routine to name. Across two routines the name is empty and the count is the total.
struct ThreadOutcome {
  ThreadOutcomeKind kind = ThreadOutcomeKind::readOnly;
  int changes = 0;
  std::optional<RoutineId> routine;
  std::string routineName;

  bool operator==(const ThreadOutcome&) const = default;
};

std::string toString(ThreadOutcomeKind kind);

// Derived from the proposals on every read, never stored. The ladder: applied beats proposed, which
// beats dismissed, which beats superseded; a thread that minted nothing is `read only`.
ThreadOutcome outcomeOf(const AskThread& thread);

// What a thread may weigh, in turns; it bounds the prompt the server assembles.
constexpr std::size_t kMaxThreadTurns = 8;

// How many threads the LIST read hands over, newest first; the export reads every thread there is
// (`allThreads`). The reply carries no total, so a client may state a count only while it holds
// FEWER rows than this, and must say nothing about how many once it holds exactly this many.
constexpr int kThreadList = 200;

}

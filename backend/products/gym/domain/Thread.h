#pragma once

#include "products/gym/domain/Proposal.h"
#include "products/gym/domain/ReadReceipt.h"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// A thread's title is the lifter's first message verbatim, stored as sent and never touched again.

// One turn, stored as sent, byte for byte.
struct ThreadTurn {
  bool fromLifter = true;
  std::string text;
  std::uint64_t atMs = 0;
  std::optional<AnswerReceipt> receipt;

  bool operator==(const ThreadTurn&) const = default;
};

// One proposal this conversation minted, carrying the routine's NAME, which a ProposalHead does not.
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
  std::vector<ProposalId> referencedProposals;  // assistant receipts, including ids whose ledger is gone

  bool operator==(const AskThread&) const = default;
};

// Every word here is something the server OBSERVED.
enum class ThreadOutcomeKind { readOnly, proposed, applied, dismissed, superseded, unknown };

// Known outcomes count changes and name a routine only when there is one. Unknown carries zero
// and no routine because the missing proposal's decision and count cannot be recovered.
struct ThreadOutcome {
  ThreadOutcomeKind kind = ThreadOutcomeKind::readOnly;
  int changes = 0;
  std::optional<RoutineId> routine;
  std::string routineName;

  bool operator==(const ThreadOutcome&) const = default;
};

std::string toString(ThreadOutcomeKind kind);

// A missing receipt reference makes the outcome unknown. Otherwise applied beats proposed, then
// dismissed, then superseded; no known proposals or references means read only.
ThreadOutcome outcomeOf(const AskThread& thread);

// What a thread may weigh, in turns; it bounds the prompt the server assembles.
constexpr std::size_t kMaxThreadTurns = 8;

// How many threads the list read hands over, newest first. The reply carries no total, so a client
// may state a count only while it holds FEWER rows than this.
constexpr int kThreadList = 200;

}

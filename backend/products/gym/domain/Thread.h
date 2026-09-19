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

struct CoachAttachment {
  std::string id;
  std::string mediaType;
  int width = 0;
  int height = 0;
  std::uint64_t bytes = 0;
  bool operator==(const CoachAttachment&) const = default;
};

struct CoachResult {
  std::string operationId;
  std::string routineId;
  std::string routineName;
  bool operator==(const CoachResult&) const = default;
};

// One turn, stored as sent, byte for byte.
struct ThreadTurn {
  bool fromLifter = true;
  std::string text;
  std::uint64_t atMs = 0;
  std::optional<AnswerReceipt> receipt;

  std::uint64_t position = 0;
  std::string generationId;
  std::vector<CoachResult> results;
  std::string requestId;
  std::string status = "completed";
  std::vector<CoachAttachment> attachments;

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

struct AskGeneration {
  std::string id;
  std::string requestId;
  std::string question;
  std::string status = "running";
  std::string answer;
  std::optional<AnswerReceipt> receipt;
  std::vector<AskStep> steps;
  std::vector<CoachResult> results;
  std::uint64_t atMs = 0;
  std::uint64_t revision = 0;
  bool stopRequested = false;
  std::vector<CoachAttachment> attachments;
  bool operator==(const AskGeneration&) const = default;
};

struct ThreadBusy {};

struct ThreadCursor {
  std::uint64_t beforeMs = 0;
  std::string beforeId;
  int limit = 50;
};

// A conversation and its durable generation snapshot.
struct AskThread {
  ThreadId id;
  UserId user;
  std::string title;              // the first message, verbatim, written once
  std::uint64_t createdAtMs = 0;
  std::uint64_t askedAtMs = 0;    // the newest turn — what the list sorts and dates by
  std::vector<ThreadTurn> turns;
  std::vector<ThreadProposal> minted;
  std::vector<ProposalId> referencedProposals;  // assistant receipts, including ids whose ledger is gone

  std::optional<AskGeneration> generation;
  std::vector<CoachResult> results;
  std::string nextCursor;

  bool operator==(const AskThread&) const = default;
};

// Every word here is something the server OBSERVED.
enum class ThreadOutcomeKind { readOnly, created, proposed, applied, dismissed, superseded, unknown };

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

// Only the model context is bounded; stored history has no lifetime turn ceiling.
constexpr std::size_t kMaxContextTurns = 24;
constexpr std::size_t kMaxContextBytes = 24000;
std::vector<ThreadTurn> contextOf(const std::vector<ThreadTurn>& turns);

// How many threads the list read hands over, newest first. The reply carries no total, so a client
// may state a count only while it holds FEWER rows than this.
constexpr int kThreadList = 200;

}

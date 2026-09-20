#include "products/gym/domain/Thread.h"

#include <algorithm>

namespace wm::gym {

namespace {

// The count is what those proposals moved; the routine is named only where they all landed on the
// same one, so the noun is decided at the end rather than mid-walk.
ThreadOutcome foldedInto(ThreadOutcomeKind kind, const AskThread& thread, ProposalState state) {
  ThreadOutcome outcome{kind};
  std::optional<RoutineId> landedOn;
  std::string landedOnName;
  bool oneRoutine = true;
  for (const ThreadProposal& minted : thread.minted) {
    if (minted.state != state) continue;
    outcome.changes += minted.changes;
    if (!landedOn) {
      landedOn = minted.routine;
      landedOnName = minted.routineName;
      continue;
    }
    if (*landedOn != minted.routine) oneRoutine = false;
  }
  if (!oneRoutine) return outcome;   // two routines: the count stands, the noun does not
  outcome.routine = landedOn;
  outcome.routineName = landedOnName;
  return outcome;
}

bool anyIn(const AskThread& thread, ProposalState state) {
  for (const ThreadProposal& minted : thread.minted)
    if (minted.state == state) return true;
  return false;
}

}  // namespace

std::vector<ThreadTurn> contextOf(const std::vector<ThreadTurn>& history) {
  std::vector<ThreadTurn> turns;
  for (const auto& turn : history) if (turn.status == "completed") turns.push_back(turn);
  std::size_t start = turns.size();
  std::size_t bytes = 0;
  while (start > 0 && turns.size() - start < kMaxContextTurns) {
    if (bytes + turns[start - 1].text.size() > kMaxContextBytes) break;
    bytes += turns[--start].text.size();
  }
  while (start < turns.size() && !turns[start].fromLifter) ++start;
  return {turns.begin() + start, turns.end()};
}

std::string toString(ThreadOutcomeKind kind) {
  if (kind == ThreadOutcomeKind::created) return "created";
  if (kind == ThreadOutcomeKind::unknown) return "unknown";
  if (kind == ThreadOutcomeKind::proposed) return "proposed";
  if (kind == ThreadOutcomeKind::applied) return "applied";
  if (kind == ThreadOutcomeKind::dismissed) return "dismissed";
  if (kind == ThreadOutcomeKind::superseded) return "superseded";
  return "read-only";
}

ThreadOutcome outcomeOf(const AskThread& thread) {
  for (const ProposalId& id : thread.referencedProposals)
    if (std::none_of(thread.minted.begin(), thread.minted.end(),
                     [&](const ThreadProposal& proposal) { return proposal.id == id; }))
      return ThreadOutcome{ThreadOutcomeKind::unknown};
  if (anyIn(thread, ProposalState::applied))
    return foldedInto(ThreadOutcomeKind::applied, thread, ProposalState::applied);
  if (!thread.results.empty()) {
    ThreadOutcome outcome{ThreadOutcomeKind::created, static_cast<int>(thread.results.size())};
    if (thread.results.size() == 1) {
      outcome.routine = RoutineId{thread.results.front().routineId};
      outcome.routineName = thread.results.front().routineName;
    }
    return outcome;
  }
  if (anyIn(thread, ProposalState::pending))
    return foldedInto(ThreadOutcomeKind::proposed, thread, ProposalState::pending);
  if (anyIn(thread, ProposalState::dismissed))
    return foldedInto(ThreadOutcomeKind::dismissed, thread, ProposalState::dismissed);
  if (anyIn(thread, ProposalState::superseded))
    return foldedInto(ThreadOutcomeKind::superseded, thread, ProposalState::superseded);
  return ThreadOutcome{ThreadOutcomeKind::readOnly};
}

}

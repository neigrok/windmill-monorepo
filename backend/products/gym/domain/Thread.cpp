#include "products/gym/domain/Thread.h"

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

std::string toString(ThreadOutcomeKind kind) {
  if (kind == ThreadOutcomeKind::proposed) return "proposed";
  if (kind == ThreadOutcomeKind::applied) return "applied";
  if (kind == ThreadOutcomeKind::dismissed) return "dismissed";
  if (kind == ThreadOutcomeKind::superseded) return "superseded";
  return "read-only";
}

ThreadOutcome outcomeOf(const AskThread& thread) {
  if (anyIn(thread, ProposalState::applied))
    return foldedInto(ThreadOutcomeKind::applied, thread, ProposalState::applied);
  if (anyIn(thread, ProposalState::pending))
    return foldedInto(ThreadOutcomeKind::proposed, thread, ProposalState::pending);
  if (anyIn(thread, ProposalState::dismissed))
    return foldedInto(ThreadOutcomeKind::dismissed, thread, ProposalState::dismissed);
  if (anyIn(thread, ProposalState::superseded))
    return foldedInto(ThreadOutcomeKind::superseded, thread, ProposalState::superseded);
  return ThreadOutcome{ThreadOutcomeKind::readOnly};
}

}

#include "products/gym/domain/Thread.h"

namespace wm::gym {

namespace {

// Every proposal in one state, folded into the outcome that names it: the count is what those
// proposals moved, and the routine is named only where they all landed on the same one.
//
// THE LOOP RUNS TO THE END WHATEVER IT MEETS, and that is the fix for a real defect: it used to
// return the moment a second routine appeared, so a thread that moved Push A, then Legs, then Push A
// again printed the first two counts and silently dropped the third. `6 changes dismissed` under a
// thread that dismissed eleven is exactly the kind of sentence this file exists to refuse — a number
// the server states about somebody's evening that the server did not observe. Meeting a second
// routine costs the NOUN and nothing else, so the noun is decided at the end rather than mid-walk.
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

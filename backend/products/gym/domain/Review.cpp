#include "products/gym/domain/Review.h"

#include <algorithm>
#include <cmath>
#include <tuple>
#include <utility>

namespace wm::gym {

namespace {
// A record plus the two numbers that rank it against the others a session earned; neither reaches
// the wire. e1rmOfSet is zero for a set with no honest estimate, and a defined e1RM is always above
// zero, so an unloaded record sorts below a loaded one.
struct Candidate {
  PersonalRecord record;
  double e1rmOfSet;
  std::uint64_t atMs;
};

// The ranking, in one place: kinds in their declared order, then the larger e1RM, then the heavier
// load, then the earlier set.
bool outranks(const Candidate& earned, const Candidate& best) {
  if (earned.record.kind != best.record.kind) return earned.record.kind < best.record.kind;
  if (earned.e1rmOfSet != best.e1rmOfSet) return earned.e1rmOfSet > best.e1rmOfSet;
  if (earned.record.weightKg != best.record.weightKg)
    return earned.record.weightKg > best.record.weightKg;
  return earned.atMs < best.atMs;
}

// The movements this session trained, in the order they were first performed — the order the
// comparison prints and the record walk breaks its last tie in. Read off the MARKS, which `marksOf`
// appends in first-seen order.
std::vector<ExerciseId> movementsOf(const std::vector<PriorMark>& marks) {
  std::vector<ExerciseId> out;
  for (const PriorMark& mark : marks) {
    bool seen = false;
    for (const ExerciseId& held : out)
      if (held == mark.exercise) seen = true;
    if (!seen) out.push_back(mark.exercise);
  }
  return out;
}

std::vector<PriorMark> marksOfMovement(const std::vector<PriorMark>& marks,
                                       const ExerciseId& exercise) {
  std::vector<PriorMark> out;
  for (const PriorMark& mark : marks)
    if (mark.exercise == exercise) out.push_back(mark);
  return out;
}

// The heaviest mark, ties broken by more reps and then by the earlier one — TopSet's rule over the
// projection instead of over the sets.
std::optional<PriorMark> heaviestMark(const std::vector<PriorMark>& marks) {
  std::optional<PriorMark> top;
  for (const PriorMark& mark : marks) {
    if (top && std::tuple(mark.weightKg, mark.reps, top->atMs) <=
                   std::tuple(top->weightKg, top->reps, mark.atMs))
      continue;
    top = mark;
  }
  return top;
}

// One mark folded into a running projection: more reps at a load it already holds replaces it, the
// same reps hit earlier only re-dates it, and an unseen load is appended.
void fold(std::vector<PriorMark>& marks, const PriorMark& earned) {
  for (PriorMark& held : marks) {
    if (!(held.exercise == earned.exercise) || held.weightKg != earned.weightKg) continue;
    if (earned.reps > held.reps) {
      held = earned;
      return;
    }
    if (earned.reps == held.reps && earned.atMs < held.atMs) held.atMs = earned.atMs;
    return;
  }
  marks.push_back(earned);
}

std::vector<Set> setsOfMovement(const std::vector<Set>& working, const ExerciseId& exercise) {
  std::vector<Set> out;
  for (const Set& set : working)
    if (set.exercise == exercise) out.push_back(set);
  return out;
}

// The heaviest set, ties broken by more reps and then by the earlier one — never the largest volume
// and never the best e1RM.
std::optional<Set> topWorkingSet(const std::vector<Set>& sets) {
  std::optional<Set> top;
  for (const Set& set : sets) {
    if (top && std::pair(set.weightKg, set.reps) <= std::pair(top->weightKg, top->reps)) continue;
    top = set;
  }
  return top;
}

std::optional<TopSet> topSetOf(const std::vector<Set>& sets) {
  std::optional<Set> top = topWorkingSet(sets);
  if (!top) return std::nullopt;
  int atLoad = 0;
  for (const Set& set : sets)
    if (set.weightKg == top->weightKg) ++atLoad;
  return TopSet{top->weightKg, top->reps, atLoad};
}

// Start to finish, or — while it is still open — to the last set logged into it, and nothing for one
// that holds none. The floor is load-bearing: a set carrying a skewed device stamp can put the last
// activity before the session began.
std::uint64_t spanOf(const Session& session, const std::vector<Set>& sets) {
  if (session.finishedAtMs) {
    if (*session.finishedAtMs <= session.startedAtMs) return 0;
    return *session.finishedAtMs - session.startedAtMs;
  }
  std::uint64_t last = session.startedAtMs;
  for (const Set& set : sets) last = std::max(last, set.completedAtMs);
  return last - session.startedAtMs;
}

// The three record rules for one movement, answered from the marks alone, best of them returned.
// Each needs a mark to have been PASSED, so a first session claims nothing.
std::optional<Candidate> recordFor(const ExerciseId& exercise, const std::vector<PriorMark>& today,
                                   const std::vector<PriorMark>& priors) {
  std::vector<Candidate> earned;

  double priorTopE1rm = 0;
  std::uint64_t priorTopE1rmAtMs = 0;
  for (const PriorMark& mark : priors) {
    std::optional<double> value = e1rm(mark.weightKg, mark.reps);
    if (!value || *value <= priorTopE1rm) continue;
    priorTopE1rm = *value;
    priorTopE1rmAtMs = mark.atMs;
  }
  double topE1rm = 0;
  std::optional<PriorMark> byE1rm;
  for (const PriorMark& mark : today) {
    std::optional<double> value = e1rm(mark.weightKg, mark.reps);
    if (!value || *value <= topE1rm) continue;
    topE1rm = *value;
    byE1rm = mark;
  }
  if (byE1rm && priorTopE1rm > 0 && topE1rm > priorTopE1rm)
    earned.push_back(Candidate{PersonalRecord{RecordKind::e1rm, exercise, topE1rm, byE1rm->weightKg,
                                              byE1rm->reps, priorTopE1rm, priorTopE1rmAtMs},
                               topE1rm, byE1rm->atMs});

  // The prior stays optional because a load may legally be zero or negative, so no number can stand
  // in for "no mark".
  std::optional<PriorMark> priorTopLoad = heaviestMark(priors);
  std::optional<PriorMark> byLoad = heaviestMark(today);
  if (byLoad && priorTopLoad && byLoad->weightKg > priorTopLoad->weightKg)
    earned.push_back(Candidate{
        PersonalRecord{RecordKind::heaviest, exercise, byLoad->weightKg, byLoad->weightKg,
                       byLoad->reps, priorTopLoad->weightKg, priorTopLoad->atMs},
        e1rm(byLoad->weightKg, byLoad->reps).value_or(0), byLoad->atMs});

  // More reps at a load this lifter has used before. One mark exists per (movement, load) on both
  // sides, so a load is compared exactly once.
  for (const PriorMark& mark : today)
    for (const PriorMark& prior : priors) {
      if (prior.weightKg != mark.weightKg || mark.reps <= prior.reps) continue;
      earned.push_back(
          Candidate{PersonalRecord{RecordKind::repsAtWeight, exercise,
                                   static_cast<double>(mark.reps), mark.weightKg, mark.reps,
                                   static_cast<double>(prior.reps), prior.atMs},
                    e1rm(mark.weightKg, mark.reps).value_or(0), mark.atMs});
    }

  if (earned.empty()) return std::nullopt;
  Candidate best = earned.front();
  for (const Candidate& candidate : earned)
    if (outranks(candidate, best)) best = candidate;
  return best;
}

// The comparison exists only for a session that named a routine, and only where there is an earlier
// one to stand against.
std::optional<Against> comparisonOf(const Session& session, const std::vector<Set>& working,
                                    const std::vector<PriorMark>& earned,
                                    const SessionHistory& history) {
  if (!session.routine) return std::nullopt;
  if (!history.previous) return std::nullopt;
  std::vector<Set> before;
  for (const Set& set : history.previousSets)
    if (set.kind == SetKind::working) before.push_back(set);

  std::vector<AgainstMovement> movements;
  for (const ExerciseId& movement : movementsOf(earned)) {
    // A plan may name one movement twice; the first line is its main work, and the comparison prints
    // one target rather than adding two together.
    std::optional<PlanEntry> planned;
    if (session.plan)
      for (const PlanEntry& entry : session.plan->entries) {
        if (!(entry.exercise == movement)) continue;
        planned = entry;
        break;
      }
    // The movement came out of this session's own working sets, so its top set is always there.
    movements.push_back(AgainstMovement{movement, *topSetOf(setsOfMovement(working, movement)),
                                        topSetOf(setsOfMovement(before, movement)), planned});
  }
  return Against{history.previous->id,
                 history.previous->plan ? history.previous->plan->routineName : "",
                 history.previous->startedAtMs, std::move(movements)};
}
}

std::string toString(RecordKind kind) {
  switch (kind) {
    case RecordKind::e1rm: return "e1rm";
    case RecordKind::heaviest: return "heaviest";
    case RecordKind::repsAtWeight: return "reps-at-weight";
  }
  return "e1rm";
}

std::optional<double> e1rm(double weightKg, int reps) {
  if (weightKg <= 0) return std::nullopt;
  return std::round(weightKg * (1.0 + reps / 30.0) * 10.0) / 10.0;
}

std::vector<PriorMark> marksOf(const std::vector<Set>& sets) {
  std::vector<PriorMark> marks;
  for (const Set& set : sets) {
    if (set.kind != SetKind::working) continue;
    fold(marks, PriorMark{set.exercise, set.weightKg, set.reps, set.completedAtMs});
  }
  return marks;
}

std::optional<double> topE1rmOf(const std::vector<PriorMark>& marks) {
  std::optional<double> top;
  for (const PriorMark& mark : marks) {
    std::optional<double> value = e1rm(mark.weightKg, mark.reps);
    if (!value || (top && *value <= *top)) continue;
    top = value;
  }
  return top;
}

// At most one record for the whole session: the best of each movement's best, under the same
// ranking.
std::optional<PersonalRecord> recordAgainst(const std::vector<PriorMark>& earned,
                                            const std::vector<PriorMark>& standing) {
  std::optional<Candidate> best;
  for (const ExerciseId& movement : movementsOf(earned)) {
    std::optional<Candidate> won = recordFor(movement, marksOfMovement(earned, movement),
                                             marksOfMovement(standing, movement));
    if (!won) continue;
    if (!best || outranks(*won, *best)) best = *won;
  }
  if (!best) return std::nullopt;
  return best->record;
}

std::vector<SessionId> recordedIn(const std::vector<SessionMarks>& page,
                                  const std::vector<PriorMark>& standing) {
  std::vector<PriorMark> history = standing;
  std::vector<SessionId> earned;
  for (const SessionMarks& session : page) {
    if (session.workingSets >= kSlightWorkingSets && recordAgainst(session.marks, history))
      earned.push_back(session.session);
    if (!session.finished) continue;   // the workout is not over; nothing after it stands on it yet
    for (const PriorMark& mark : session.marks) fold(history, mark);
  }
  return earned;
}

Review review(const Session& session, const std::vector<Set>& sets, const SessionHistory& history) {
  std::vector<Set> working;
  for (const Set& set : sets)
    if (set.kind == SetKind::working) working.push_back(set);

  // The span counts every set, warmups included; everything below counts only working sets.
  const std::vector<PriorMark> earned = marksOf(working);
  ReviewStats stats{spanOf(session, sets), static_cast<int>(working.size()), topE1rmOf(earned)};
  if (stats.workingSets < kSlightWorkingSets)
    return Review{stats, true, std::nullopt, std::nullopt};
  return Review{stats, false, recordAgainst(earned, history.marks),
                comparisonOf(session, working, earned, history)};
}

}

#include "products/gym/domain/Review.h"

#include <algorithm>
#include <cmath>
#include <utility>

namespace wm::gym {

namespace {
// A record plus the two numbers that rank it against the others a session earned. Neither reaches
// the wire: they are how the domain picks the ONE line a session gets. e1rmOfSet is zero for a set
// with no honest estimate, and a defined e1RM is always above zero (its load is), so an unloaded
// record sorts below a loaded one instead of tying with it.
struct Candidate {
  PersonalRecord record;
  double e1rmOfSet;
  std::uint64_t atMs;
};

// The ranking §2.4 fixes, in one place so two surfaces can never disagree about which line is loud:
// the kinds in their declared order, then the larger e1RM, then the heavier load, then the earlier
// set.
bool outranks(const Candidate& earned, const Candidate& best) {
  if (earned.record.kind != best.record.kind) return earned.record.kind < best.record.kind;
  if (earned.e1rmOfSet != best.e1rmOfSet) return earned.e1rmOfSet > best.e1rmOfSet;
  if (earned.record.weightKg != best.record.weightKg)
    return earned.record.weightKg > best.record.weightKg;
  return earned.atMs < best.atMs;
}

// The movements this session trained, in the order they were first performed — the order the
// comparison prints, and the order the record walk breaks its last tie in.
std::vector<ExerciseId> movementsOf(const std::vector<Set>& working) {
  std::vector<ExerciseId> out;
  for (const Set& set : working) {
    bool seen = false;
    for (const ExerciseId& held : out)
      if (held == set.exercise) seen = true;
    if (!seen) out.push_back(set.exercise);
  }
  return out;
}

std::vector<Set> setsOfMovement(const std::vector<Set>& working, const ExerciseId& exercise) {
  std::vector<Set> out;
  for (const Set& set : working)
    if (set.exercise == exercise) out.push_back(set);
  return out;
}

// The heaviest set, ties broken by more reps and then by the earlier one. Never the largest volume
// and never the best e1RM — the reasons are TopSet's, and this is the one place that decides it.
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

std::optional<double> topE1rmOf(const std::vector<Set>& working) {
  std::optional<double> top;
  for (const Set& set : working) {
    std::optional<double> value = e1rm(set.weightKg, set.reps);
    if (!value || (top && *value <= *top)) continue;
    top = value;
  }
  return top;
}

// How long the session covers: start to finish, or — while it is still open — to the last set
// logged into it, and nothing at all for one that holds none. Clock-free like every rule here,
// because a duration the server timed would disagree with the device that actually lived it. The
// floor is not paranoia: the lazy auto-close ends a session at its last activity, and a set
// carrying a skewed device stamp can put that instant before the session began.
std::uint64_t spanOf(const Session& session, const std::vector<Set>& sets) {
  if (session.finishedAtMs) {
    if (*session.finishedAtMs <= session.startedAtMs) return 0;
    return *session.finishedAtMs - session.startedAtMs;
  }
  std::uint64_t last = session.startedAtMs;
  for (const Set& set : sets) last = std::max(last, set.completedAtMs);
  return last - session.startedAtMs;
}

// The three record rules of §2.4 for one movement, each answered from the marks alone, and the best
// of them returned. Every one of them needs a mark to have been PASSED — with no prior history
// there is nothing to beat, so a first session claims nothing.
std::optional<Candidate> recordFor(const ExerciseId& exercise, const std::vector<Set>& today,
                                   const std::vector<PriorMark>& marks) {
  std::vector<PriorMark> priors;
  for (const PriorMark& mark : marks)
    if (mark.exercise == exercise) priors.push_back(mark);

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
  std::optional<Set> byE1rm;
  for (const Set& set : today) {
    std::optional<double> value = e1rm(set.weightKg, set.reps);
    if (!value || *value <= topE1rm) continue;
    topE1rm = *value;
    byE1rm = set;
  }
  if (byE1rm && priorTopE1rm > 0 && topE1rm > priorTopE1rm)
    earned.push_back(Candidate{PersonalRecord{RecordKind::e1rm, exercise, topE1rm, byE1rm->weightKg,
                                              byE1rm->reps, priorTopE1rm, priorTopE1rmAtMs},
                               topE1rm, byE1rm->completedAtMs});

  // The heaviest load is a different question from the best e1RM — 110 × 2 is the heavier bar and
  // 105 × 5 the better set — and a lifter is owed both answers. The prior stays optional here
  // because a load may legally be zero or negative, so no number can stand in for "no mark".
  std::optional<double> priorTopLoad;
  std::uint64_t priorTopLoadAtMs = 0;
  for (const PriorMark& mark : priors) {
    if (priorTopLoad && mark.weightKg <= *priorTopLoad) continue;
    priorTopLoad = mark.weightKg;
    priorTopLoadAtMs = mark.atMs;
  }
  std::optional<Set> byLoad = topWorkingSet(today);
  if (byLoad && priorTopLoad && byLoad->weightKg > *priorTopLoad)
    earned.push_back(
        Candidate{PersonalRecord{RecordKind::heaviest, exercise, byLoad->weightKg, byLoad->weightKg,
                                 byLoad->reps, *priorTopLoad, priorTopLoadAtMs},
                  e1rm(byLoad->weightKg, byLoad->reps).value_or(0), byLoad->completedAtMs});

  // More reps at a load this lifter has used before — the record a plateau earns, and the reason a
  // mark carries reps at all. One mark exists per (movement, load), so the inner walk answers once.
  for (const Set& set : today)
    for (const PriorMark& mark : priors) {
      if (mark.weightKg != set.weightKg || set.reps <= mark.reps) continue;
      earned.push_back(
          Candidate{PersonalRecord{RecordKind::repsAtWeight, exercise,
                                   static_cast<double>(set.reps), set.weightKg, set.reps,
                                   static_cast<double>(mark.reps), mark.atMs},
                    e1rm(set.weightKg, set.reps).value_or(0), set.completedAtMs});
    }

  if (earned.empty()) return std::nullopt;
  Candidate best = earned.front();
  for (const Candidate& candidate : earned)
    if (outranks(candidate, best)) best = candidate;
  return best;
}

// At most one record for the whole session: the best of each movement's best, under the same
// ranking, because a maximum taken twice is the maximum taken once.
std::optional<PersonalRecord> recordIn(const std::vector<Set>& working,
                                       const std::vector<PriorMark>& marks) {
  std::optional<Candidate> best;
  for (const ExerciseId& movement : movementsOf(working)) {
    std::optional<Candidate> earned =
        recordFor(movement, setsOfMovement(working, movement), marks);
    if (!earned) continue;
    if (!best || outranks(*earned, *best)) best = *earned;
  }
  if (!best) return std::nullopt;
  return best->record;
}

// The comparison exists only for a session that named a routine, and only where there is an earlier
// one to stand against. Both absences are ordinary: an ad-hoc session is against nothing, and the
// first time a day is run there is no last time to print.
std::optional<Against> comparisonOf(const Session& session, const std::vector<Set>& working,
                                    const SessionHistory& history) {
  if (!session.routine) return std::nullopt;
  if (!history.previous) return std::nullopt;
  std::vector<Set> before;
  for (const Set& set : history.previousSets)
    if (set.kind == SetKind::working) before.push_back(set);

  std::vector<AgainstMovement> movements;
  for (const ExerciseId& movement : movementsOf(working)) {
    // A plan may name one movement twice (heavy, then a back-off), and the first line is its main
    // work — the comparison prints one target and never adds two of them together.
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

Review review(const Session& session, const std::vector<Set>& sets, const SessionHistory& history) {
  std::vector<Set> working;
  for (const Set& set : sets)
    if (set.kind == SetKind::working) working.push_back(set);

  // The span counts every set, warmups included — a ramp-up is time spent — while everything below
  // counts only working sets, which is the whole of what a warmup, a drop and a failure earn.
  ReviewStats stats{spanOf(session, sets), static_cast<int>(working.size()), topE1rmOf(working)};
  if (stats.workingSets < kSlightWorkingSets)
    return Review{stats, true, std::nullopt, std::nullopt};
  return Review{stats, false, recordIn(working, history.marks),
                comparisonOf(session, working, history)};
}

}

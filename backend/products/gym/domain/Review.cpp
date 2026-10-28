#include "products/gym/domain/Review.h"

#include <algorithm>
#include <tuple>
#include <utility>

namespace wm::gym {

namespace {
// A record plus the estimate score of the set that earned it, which ranks it against the others a session earned and
// never reaches the wire. A set with no estimate scores zero, below every set that has one.
struct Candidate {
  PersonalRecord record;
  std::int64_t score;
};

Candidate candidateOf(PersonalRecord record, const PerformedFact& set) {
  const std::optional<Estimate> estimate = set.estimate();
  return Candidate{std::move(record), estimate ? estimate->score : 0};
}

// The ranking, in one place: kinds in their declared order, then the higher score, then the heavier load, then the
// movement id.
bool outranks(const Candidate& earned, const Candidate& best) {
  if (earned.record.kind != best.record.kind) return earned.record.kind < best.record.kind;
  if (earned.score != best.score) return earned.score > best.score;
  if (earned.record.weightKg != best.record.weightKg) return earned.record.weightKg > best.record.weightKg;
  return earned.record.exercise.str() < best.record.exercise.str();
}

std::vector<ProgressSet> setsOfMovement(const std::vector<ProgressSet>& sets, const ExerciseId& exercise) {
  std::vector<ProgressSet> out;
  for (const ProgressSet& set : sets)
    if (set.exercise == exercise) out.push_back(set);
  return out;
}

// The movements in the order they were first performed — the order the comparison prints.
std::vector<ExerciseId> movementsOf(const std::vector<Set>& sets) {
  std::vector<ExerciseId> out;
  for (const Set& set : sets)
    if (std::ranges::find(out, set.exercise) == out.end()) out.push_back(set.exercise);
  return out;
}

// One session's top set among `sets`: the heaviest, then the most reps, then the lowest set id.
std::optional<ProgressSet> topOf(const std::vector<ProgressSet>& sets) {
  std::optional<ProgressSet> top;
  for (const ProgressSet& set : sets) {
    const PerformedFact& now = set.performed;
    if (top && std::tuple(now.weightKg, now.reps, top->performed.set.str()) <=
                   std::tuple(top->performed.weightKg, top->performed.reps, now.set.str()))
      continue;
    top = set;
  }
  return top;
}

// The mark a load must pass across the standing sessions: the most reps at the heaviest load, the earliest session
// and then the lowest set id holding it.
std::optional<ProgressSet> standingTopOf(const std::vector<ProgressSet>& sets) {
  std::optional<ProgressSet> top;
  for (const ProgressSet& set : sets) {
    const PerformedFact& now = set.performed;
    if (top && std::tuple(now.weightKg, now.reps, top->startedAtMs, top->performed.set.str()) <=
                   std::tuple(top->performed.weightKg, top->performed.reps, set.startedAtMs, now.set.str()))
      continue;
    top = set;
  }
  return top;
}

std::vector<ProgressSet> atLoad(const std::vector<ProgressSet>& sets, double weightKg) {
  std::vector<ProgressSet> out;
  for (const ProgressSet& set : sets)
    if (set.performed.weightKg == weightKg) out.push_back(set);
  return out;
}

// The three record rules for one movement. Each needs a mark to have been PASSED, so a first session claims nothing.
// An estimate beats the one before it as stated to a tenth, the way every phone compares them.
std::vector<Candidate> recordsFor(const ExerciseId& exercise, const std::vector<ProgressSet>& today,
                                  const std::vector<ProgressSet>& standing) {
  std::vector<Candidate> earned;

  const std::optional<MovementSeries::Point> now = MovementSeries{progressSessions(today), exercise}.best();
  const std::optional<MovementSeries::Point> before = MovementSeries{progressSessions(standing), exercise}.best();
  if (now && before && Estimate::stated(now->fact.estimate->estimate.e1rm) > Estimate::stated(before->fact.estimate->estimate.e1rm)) {
    const EstimatedFact& set = *now->fact.estimate;
    earned.push_back(candidateOf(PersonalRecord{RecordKind::e1rm, exercise, set.estimate.e1rm, set.performed.weightKg,
                                                set.performed.reps, before->fact.estimate->estimate.e1rm,
                                                before->startedAtMs},
                                 set.performed));
  }

  const std::optional<ProgressSet> top = topOf(today);
  const std::optional<ProgressSet> heaviest = standingTopOf(standing);
  if (top && heaviest && top->performed.weightKg > heaviest->performed.weightKg)
    earned.push_back(candidateOf(PersonalRecord{RecordKind::heaviest, exercise, top->performed.weightKg,
                                                top->performed.weightKg, top->performed.reps,
                                                heaviest->performed.weightKg, heaviest->startedAtMs},
                                 top->performed));

  // More reps at a load this lifter has used before, each load of today judged once.
  std::vector<double> loads;
  for (const ProgressSet& set : today)
    if (std::ranges::find(loads, set.performed.weightKg) == loads.end()) loads.push_back(set.performed.weightKg);
  for (const double load : loads) {
    const std::optional<ProgressSet> most = topOf(atLoad(today, load));
    const std::optional<ProgressSet> mark = standingTopOf(atLoad(standing, load));
    if (!mark || most->performed.reps <= mark->performed.reps) continue;
    earned.push_back(candidateOf(PersonalRecord{RecordKind::repsAtWeight, exercise,
                                                static_cast<double>(most->performed.reps), load, most->performed.reps,
                                                static_cast<double>(mark->performed.reps), mark->startedAtMs},
                                 most->performed));
  }
  return earned;
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

// The comparison exists only for a session that named a routine, and only where there is an earlier
// one to stand against.
std::optional<Against> comparisonOf(const Session& session, const std::vector<Set>& working,
                                    const SessionHistory& history) {
  if (!session.routine) return std::nullopt;
  if (!history.previous) return std::nullopt;
  std::vector<Set> before;
  for (const Set& set : history.previousSets)
    if (set.kind == SetKind::working) before.push_back(set);

  std::vector<AgainstMovement> movements;
  for (const ExerciseId& movement : movementsOf(working)) {
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

std::optional<double> topE1rmOf(const std::vector<ProgressSet>& sets) {
  std::optional<double> top;
  for (const ProgressSet& set : sets)
    if (const std::optional<Estimate> estimate = set.performed.estimate(); estimate && (!top || estimate->e1rm > *top))
      top = estimate->e1rm;
  return top;
}

// At most one record for the whole session: the best of each movement's best, under the same ranking.
std::optional<PersonalRecord> recordAgainst(const std::vector<ProgressSet>& today,
                                            const std::vector<ProgressSet>& standing) {
  std::vector<ExerciseId> movements;
  for (const ProgressSet& set : today)
    if (std::ranges::find(movements, set.exercise) == movements.end()) movements.push_back(set.exercise);
  std::optional<Candidate> best;
  for (const ExerciseId& movement : movements)
    for (const Candidate& candidate :
         recordsFor(movement, setsOfMovement(today, movement), setsOfMovement(standing, movement)))
      if (!best || outranks(candidate, *best)) best = candidate;
  if (!best) return std::nullopt;
  return best->record;
}

std::vector<SessionId> recordedIn(const std::vector<WorkedSession>& page,
                                  const std::vector<ProgressSet>& standing) {
  std::vector<ProgressSet> history = standing;
  std::vector<SessionId> earned;
  for (const WorkedSession& session : page) {
    if (!session.finished) continue;   // the workout is not over: it earns nothing, and nothing stands on it yet
    if (session.sets.size() >= static_cast<std::size_t>(kSlightWorkingSets) && recordAgainst(session.sets, history))
      earned.push_back(session.session);
    history.insert(history.end(), session.sets.begin(), session.sets.end());
  }
  return earned;
}

Review review(const Session& session, const std::vector<Set>& sets, const SessionHistory& history) {
  std::vector<Set> working;
  for (const Set& set : sets)
    if (set.kind == SetKind::working) working.push_back(set);
  std::vector<ProgressSet> today;
  for (const Set& set : working) today.push_back(ProgressSet::of(session, set));

  // The span counts every set, warmups included; everything below counts only working sets.
  ReviewStats stats{spanOf(session, sets), static_cast<int>(working.size()), topE1rmOf(today)};
  if (stats.workingSets < kSlightWorkingSets) return Review{stats, true, std::nullopt, std::nullopt};
  std::optional<PersonalRecord> record;
  if (session.finishedAtMs) record = recordAgainst(today, history.standing);
  return Review{stats, false, std::move(record), comparisonOf(session, working, history)};
}

}

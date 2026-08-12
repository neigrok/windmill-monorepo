#include "products/gym/domain/Routine.h"

#include <cstddef>
#include <utility>

namespace wm::gym {

RoutineEntry::RoutineEntry(int position, ExerciseId exercise, int targetSets,
                           std::optional<int> targetReps, std::optional<double> targetWeightKg,
                           std::optional<int> restSeconds)
    : position(position), exercise(std::move(exercise)), targetSets(targetSets),
      targetReps(targetReps), targetWeightKg(targetWeightKg), restSeconds(restSeconds) {
  if (position < 1) throw InvalidTraining("an entry sits at a position from 1");
  if (this->exercise.empty()) throw InvalidTraining("an entry names an exercise");
  // The same bounds the columns carry, refused here so a routine that cannot be stored is never
  // built: twenty sets is already a marathon, a hundred reps already a different sport, and a rest
  // under fifteen seconds or over fifteen minutes is a typo in a number the timer counts down. The
  // rep target keeps its band when it is named; naming none is `max`, which is not a number at all.
  if (targetSets < 1 || targetSets > 20) throw InvalidTraining("target sets out of range");
  if (targetReps && (*targetReps < 1 || *targetReps > 100))
    throw InvalidTraining("target reps out of range");
  if (targetWeightKg && (*targetWeightKg < -500 || *targetWeightKg > 500))
    throw InvalidTraining("target weight out of range");
  if (restSeconds && (*restSeconds < 15 || *restSeconds > 900))
    throw InvalidTraining("rest out of range");
}

Routine::Routine(RoutineId id, UserId user, std::string name, int position,
                 std::vector<RoutineEntry> entries, std::optional<std::uint64_t> lastTrainedAtMs)
    : id(std::move(id)), user(std::move(user)), name(trimmedName(std::move(name))),
      position(position), entries(std::move(entries)), lastTrainedAtMs(lastTrainedAtMs) {
  if (!wellFormedId(this->id.str())) throw InvalidTraining("bad routine id");
  if (this->user.empty()) throw InvalidTraining("a routine belongs to an account");
  // Trimmed like a movement's, by the one rule both display names go through — a routine called
  // "   " is a blank line in the program and a blank subtitle on every session it froze.
  if (this->name.empty()) throw InvalidTraining("a routine needs a name");
  if (this->name.size() > kMaxNameLength) throw InvalidTraining("routine name too long");
  // The rule the set note already lives under (domain/Training.h), applied to the other free text
  // this module accepts: a NUL stores the name as its own head, and bytes that are not UTF-8 are
  // refused by the column itself, mid-transaction, where the answer would be a retryable 500.
  if (!storableText(this->name)) throw InvalidTraining("a routine name must be storable text");
  if (position < 0) throw InvalidTraining("a routine sits at a position from 0");
  if (this->entries.empty()) throw InvalidTraining("a routine needs at least one movement");
  // The document's own size, bounded beside every field's value: a write surface that refuses each
  // number and not how many of them there are has one way left to reach the store with something it
  // cannot hold — here, one transaction holding as many INSERTs as a body cares to name.
  if (this->entries.size() > static_cast<std::size_t>(kMaxRoutineEntries))
    throw InvalidTraining("a routine holds too many movements");
  // Dense and 1-based, checked against the order the entries arrived in: one rule refusing a gap, a
  // duplicate and a shuffle at once. The vector's order is the routine's order — position is what
  // the store keys on, so the two may never disagree.
  for (std::size_t at = 0; at < this->entries.size(); ++at)
    if (this->entries[at].position != static_cast<int>(at) + 1)
      throw InvalidTraining("routine positions run 1..n in order");
  if (lastTrainedAtMs && (*lastTrainedAtMs == 0 || *lastTrainedAtMs > kMaxInstantMs))
    throw InvalidTraining("a routine was last trained at an instant");
}

PlanSnapshot snapshotOf(const Routine& routine) {
  std::vector<PlanEntry> entries;
  for (const RoutineEntry& entry : routine.entries)
    entries.push_back(PlanEntry{entry.exercise, entry.targetSets, entry.targetReps,
                                entry.targetWeightKg, entry.restSeconds});
  return PlanSnapshot{routine.name, std::move(entries)};
}

}

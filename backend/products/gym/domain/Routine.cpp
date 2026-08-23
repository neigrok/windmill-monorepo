#include "products/gym/domain/Routine.h"

#include <cstddef>
#include <utility>

namespace wm::gym {

RoutineEntry::RoutineEntry(int position, ExerciseId exercise, std::optional<int> targetSets,
                           std::optional<int> targetReps, std::optional<double> targetWeightKg,
                           std::optional<int> restSeconds)
    : position(position), exercise(std::move(exercise)), targetSets(targetSets),
      targetReps(targetReps), targetWeightKg(targetWeightKg), restSeconds(restSeconds) {
  if (position < 1) throw InvalidTraining("an entry sits at a position from 1");
  if (this->exercise.empty()) throw InvalidTraining("an entry names an exercise");
  // A line that names no sets names no reps and no load either. Rest is not a target and rides on an
  // open line unchallenged.
  if (!targetSets && (targetReps || targetWeightKg))
    throw InvalidTraining("an open entry names no sets, so it names no reps and no weight either");
  // The same bounds the columns carry, refused here so a routine that cannot be stored is never
  // built; the rest band is the pair the global dial reads too (Training.h). A named rep target keeps
  // its band; naming none is `max`, and naming no sets is `open`.
  if (targetSets && (*targetSets < 1 || *targetSets > 20))
    throw InvalidTraining("target sets out of range");
  if (targetReps && (*targetReps < 1 || *targetReps > 100))
    throw InvalidTraining("target reps out of range");
  if (targetWeightKg && (*targetWeightKg < -500 || *targetWeightKg > 500))
    throw InvalidTraining("target weight out of range");
  if (restSeconds && (*restSeconds < kMinRestSeconds || *restSeconds > kMaxRestSeconds))
    throw InvalidTraining("rest out of range");
}

Routine::Routine(RoutineId id, UserId user, std::string name, int position,
                 std::vector<RoutineEntry> entries, std::optional<std::uint64_t> lastTrainedAtMs,
                 int revision)
    : id(std::move(id)), user(std::move(user)), name(trimmedName(std::move(name))),
      position(position), entries(std::move(entries)), lastTrainedAtMs(lastTrainedAtMs),
      revision(revision) {
  if (!wellFormedId(this->id.str())) throw InvalidTraining("bad routine id");
  if (this->user.empty()) throw InvalidTraining("a routine belongs to an account");
  // Trimmed by the one rule both display names go through.
  if (this->name.empty()) throw InvalidTraining("a routine needs a name");
  if (this->name.size() > kMaxNameLength) throw InvalidTraining("routine name too long");
  // A NUL would store the name as its own head, and non-UTF-8 bytes would be refused by the column
  // mid-transaction as a retryable 500.
  if (!storableText(this->name)) throw InvalidTraining("a routine name must be storable text");
  if (position < 0) throw InvalidTraining("a routine sits at a position from 0");
  if (this->entries.empty()) throw InvalidTraining("a routine needs at least one movement");
  // The document's own size, bounded so one transaction cannot hold as many INSERTs as a body names.
  if (this->entries.size() > static_cast<std::size_t>(kMaxRoutineEntries))
    throw InvalidTraining("a routine holds too many movements");
  // Dense and 1-based, checked against arrival order: one rule refusing a gap, a duplicate and a
  // shuffle at once. The vector's order is the routine's order and position is what the store keys
  // on, so the two may never disagree.
  for (std::size_t at = 0; at < this->entries.size(); ++at)
    if (this->entries[at].position != static_cast<int>(at) + 1)
      throw InvalidTraining("routine positions run 1..n in order");
  if (lastTrainedAtMs && (*lastTrainedAtMs == 0 || *lastTrainedAtMs > kMaxInstantMs))
    throw InvalidTraining("a routine was last trained at an instant");
  // A revision counts writes and a routine that exists has had one, so it starts at 1.
  if (revision < 1) throw InvalidTraining("a routine stands at a revision from 1");
}

PlanSnapshot snapshotOf(const Routine& routine) {
  std::vector<PlanEntry> entries;
  for (const RoutineEntry& entry : routine.entries)
    entries.push_back(PlanEntry{entry.exercise, entry.targetSets, entry.targetReps,
                                entry.targetWeightKg, entry.restSeconds});
  return PlanSnapshot{routine.name, std::move(entries)};
}

}

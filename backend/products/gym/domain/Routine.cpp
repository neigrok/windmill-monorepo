#include "products/gym/domain/Routine.h"

#include <cstddef>
#include <utility>

namespace wm::gym {

RoutineEntry::RoutineEntry(int position, ExerciseId exercise, std::vector<SetTarget> sets,
                           std::optional<int> restSeconds)
    : position(position), exercise(std::move(exercise)), sets(std::move(sets)),
      restSeconds(restSeconds) {
  if (position < 1) throw InvalidTraining("an entry sits at a position from 1");
  if (this->exercise.empty()) throw InvalidTraining("an entry names an exercise");
  // Each set refused its own bounds at construction; the scheme's length is refused here, so a line
  // that cannot be stored is never built. None at all is `open`, never a fault.
  if (this->sets.size() > kMaxSetTargets) throw InvalidTraining("sets, 1 to 20");
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
  // Dense and 1-based, checked against arrival order. The vector's order is the routine's order and
  // position is what the store keys on, so the two may never disagree.
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
    entries.push_back(PlanEntry{entry.exercise, entry.sets, entry.restSeconds});
  return PlanSnapshot{routine.name, std::move(entries)};
}

}

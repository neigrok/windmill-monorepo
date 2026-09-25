#include "products/gym/domain/Correction.h"

#include <algorithm>
#include <set>

namespace wm::gym {

SessionCorrectionBatch::SessionCorrectionBatch(const Session& stored, const std::vector<Set>& current,
    const SessionCorrectionIn& incoming, std::uint64_t nowMs)
    : session(stored) {
  if (!wellFormedId(incoming.requestId)) throw InvalidTraining{"bad correction request id"};
  if (!stored.finishedAtMs) throw InvalidTraining{"finish the workout before correcting it"};
  if (incoming.finishedAtMs < incoming.startedAtMs || incoming.finishedAtMs > nowMs)
    throw InvalidTraining{"invalid workout interval"};
  const std::string name = trimmedName(incoming.routineName);
  if (name.size() > kMaxNameLength || !storableText(name))
    throw InvalidTraining{"invalid workout name"};
  session = Session{stored.id, stored.user, incoming.startedAtMs, incoming.finishedAtMs,
                    stored.routine, stored.plan, ClosedBy::finish, name};
  std::set<std::pair<ExerciseId,int>> numbers;
  for (const CorrectionSetIn& row : incoming.sets) {
    Set set = row.set;
    if (set.session != stored.id || set.setNumber < 1 ||
        !numbers.insert({set.exercise, set.setNumber}).second)
      throw InvalidTraining{"each movement needs unique positive set numbers"};
    const auto prior = std::find_if(current.begin(), current.end(), [&](const Set& item) { return item.id == set.id; });
    if (prior != current.end()) {
      if (set.exercise != prior->exercise) throw InvalidTraining{"a set cannot change movement"};
      set.kind = prior->kind;
      if (!row.noteNamed) set.note = prior->note;
      if (!row.rpeNamed) set.rpe = prior->rpe;
    } else set.kind = SetKind::working;
    sets.push_back(std::move(set));
  }
  const SetBatch validated{stored.id, std::move(sets), nowMs};
  validated.checkInterval(session, true);
  sets = validated.sets;
  for (const Set& before : current) {
    const auto after = std::find_if(sets.begin(), sets.end(), [&](const Set& item) { return item.id == before.id; });
    if (after == sets.end()) removed.push_back(before);
    else if (*after != before) replaced.push_back(before);
  }
}

}

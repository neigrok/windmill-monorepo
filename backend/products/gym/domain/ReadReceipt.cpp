#include "products/gym/domain/ReadReceipt.h"

#include <algorithm>
#include <cmath>
#include <utility>

namespace wm::gym {

WorkoutObservation::WorkoutObservation(const Session& session, int workingSetCount, double tonnageKg)
    : workingSetCount(workingSetCount), tonnageKg(tonnageKg) {
  if (session.finishedAtMs && *session.finishedAtMs >= session.startedAtMs)
    durationMs = *session.finishedAtMs - session.startedAtMs;
}

WorkoutObservation::WorkoutObservation(const Session& session, const std::vector<Set>& sets)
    : WorkoutObservation(session, 0, 0) {
  for (const Set& set : sets) {
    if (set.kind != SetKind::working) continue;
    ++workingSetCount;
    tonnageKg += std::max(0.0, set.weightKg) * set.reps;
  }
}

SessionObservation::SessionObservation(std::string tool, const Session& session, ReadCoverage coverage,
                                       int setsRead, std::optional<WorkoutObservation> workout,
                                       std::optional<ExerciseId> exerciseId)
    : tool(std::move(tool)), sessionId(session.id), startedAtMs(session.startedAtMs),
      finishedAtMs(session.finishedAtMs), coverage(coverage), exerciseId(std::move(exerciseId)),
      setsRead(setsRead), workout(std::move(workout)) {
  if (session.plan) routine = session.plan->routineName;
}

bool AnswerReceipt::valid() const {
  if (version != 1 || read.sets < 0 || read.sessions < 0 || read.weeks < 0) return false;
  for (const SessionObservation& fact : observations) {
    if (fact.setsRead < 0) return false;
    if (fact.coverage == ReadCoverage::movement) {
      if (!fact.exerciseId || fact.workout) return false;
      continue;
    }
    if (fact.coverage != ReadCoverage::summary && fact.coverage != ReadCoverage::session) return false;
    if (fact.exerciseId || !fact.workout || fact.workout->workingSetCount < 0 ||
        !std::isfinite(fact.workout->tonnageKg) || fact.workout->tonnageKg < 0) return false;
    if (fact.coverage == ReadCoverage::summary && fact.setsRead != 0) return false;
  }
  return true;
}

std::uint64_t weekStartMs(std::uint64_t atMs) {
  // The epoch was a Thursday, so the instant shifts three days forward before it is floored to a
  // week and shifts back — the same walk `date_trunc('week', ts AT TIME ZONE 'UTC')` makes. Signed
  // throughout and clamped, so the first week of 1970 cannot come back as a negative bucket.
  constexpr long long kWeekMs = 604'800'000;
  constexpr long long kEpochToMonday = 259'200'000;
  const long long shifted = static_cast<long long>(atMs) + kEpochToMonday;
  const long long start = (shifted / kWeekMs) * kWeekMs - kEpochToMonday;
  return start < 1 ? 1 : static_cast<std::uint64_t>(start);
}

void ReadReceipt::sawSet(const SetId& id, std::uint64_t completedAtMs) {
  sets_.insert(id.str());
  weeks_.insert(weekStartMs(completedAtMs));
}

void ReadReceipt::sawSession(const SessionId& id, std::uint64_t startedAtMs) {
  sessions_.insert(id.str());
  weeks_.insert(weekStartMs(startedAtMs));
}

void ReadReceipt::sawWeek(std::uint64_t weekStartedAtMs) { weeks_.insert(weekStartMs(weekStartedAtMs)); }

void ReadReceipt::observed(SessionObservation observation) {
  observations_.push_back(std::move(observation));
}

void ReadReceipt::merge(const ReadReceipt& other) {
  sets_.insert(other.sets_.begin(), other.sets_.end());
  sessions_.insert(other.sessions_.begin(), other.sessions_.end());
  weeks_.insert(other.weeks_.begin(), other.weeks_.end());
  observations_.insert(observations_.end(), other.observations_.begin(), other.observations_.end());
}

ReadTally ReadReceipt::tally() const {
  return ReadTally{static_cast<int>(sets_.size()), static_cast<int>(sessions_.size()),
                   static_cast<int>(weeks_.size())};
}

}

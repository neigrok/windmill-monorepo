#pragma once

#include <chrono>

#include "products/gym/ports/AskAgent.h"
#include "products/gym/ports/AskThreadRepository.h"
#include "products/gym/ports/BodyweightRepository.h"
#include "products/gym/ports/CatalogRepository.h"
#include "products/gym/ports/GymWriteDoor.h"
#include "products/gym/ports/LogRepository.h"
#include "products/gym/ports/NotesRepository.h"
#include "products/gym/ports/PreferencesRepository.h"
#include "products/gym/ports/ProgramRepository.h"

#include <algorithm>
#include <mutex>
#include <set>
#include <cmath>
#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

namespace wm::gym::fake {

inline UserId uid(std::string value = "u1") { return UserId{std::move(value)}; }
inline SessionId sid(std::string value = "ses_00000001") { return SessionId{std::move(value)}; }
inline SetId setId(std::string value = "set_00000001") { return SetId{std::move(value)}; }

inline Exercise benchPress() {
  return Exercise{ExerciseId{"bench-press"}, "Bench Press", Pattern::press, Equipment::barbell,
                  2.5, false};
}
inline Exercise backSquat() {
  return Exercise{ExerciseId{"back-squat"}, "Back Squat", Pattern::squat, Equipment::barbell,
                  2.5, false};
}
inline RoutineId rtId(std::string value = "rt_00000001") { return RoutineId{std::move(value)}; }

// Monday 00:00 UTC, as `date_trunc('week', ts AT TIME ZONE 'UTC')` answers, clamped like the adapter.
inline std::uint64_t weekStartMs(std::uint64_t instantMs) {
  const long long kWeek = 604'800'000;
  const long long kEpochToMonday = 259'200'000;
  const long long shifted = static_cast<long long>(instantMs) + kEpochToMonday;
  const long long start = (shifted / kWeek) * kWeek - kEpochToMonday;
  if (start < 1) return 1;
  return static_cast<std::uint64_t>(start);
}
// A straight scheme: `sets` identical items, the shape every `n × reps · load` line takes.
inline std::vector<SetTarget> straight(int sets, std::optional<int> reps,
                                       std::optional<double> weightKg) {
  return std::vector<SetTarget>(static_cast<std::size_t>(sets), SetTarget{reps, weightKg});
}

// The Lower A / Back Squat ramp every surface's tests share: 60×5 · 80×5 · 90×3 · 100×1 · 80×5.
inline std::vector<SetTarget> ramp() {
  return {SetTarget{5, 60.0}, SetTarget{5, 80.0}, SetTarget{3, 90.0}, SetTarget{1, 100.0},
          SetTarget{5, 80.0}};
}

inline RoutineEntry benchEntry(int position = 1) {
  return RoutineEntry{position, ExerciseId{"bench-press"}, straight(5, 5, 82.5), 180};
}
inline Routine pushA(std::vector<RoutineEntry> entries = {benchEntry()},
                     std::string id = "rt_00000001") {
  return Routine{rtId(std::move(id)), uid(), "Push A", 0, std::move(entries)};
}

// An in-memory gym store read the way the SQL reads it; the Fake…Repositories are its ports. Tests write
// its rows straight in: every gym write is the engine's, tested on the real door (GymDoorFixture.h).
struct FakeGymStore {
  std::vector<Exercise> seeds;
  std::vector<std::pair<std::string, Exercise>> customs;   // (owner, row)
  std::vector<Session> sessions;
  std::vector<Set> sets;              // one row per set that currently stands
  std::vector<Routine> routineRows;   // the stored rows; lastTrainedAtMs is derived on every read
  // gym_proposals + gym_proposal_changes as one value: the rows are one document (domain/Proposal.h).
  std::vector<RoutineProposal> proposalRows;
  std::vector<Routine> routineCreations;
  std::vector<AskThread> threadRows;   // Ask's conversations; `minted` is derived on every read
  bool loseThreadRace = false;         // stage the concurrent-mint race `openThread` explains
  std::vector<SessionShare> shares;   // one per session at most, exactly as the primary key says
  std::vector<GymPreferences> preferenceRows;   // one per account at most, likewise
  std::map<std::string, Note> noteSaves;
  std::vector<Note> noteRows;                   // gym_notes: dense on position per account
  std::vector<Bodyweight> bodyweightRows;       // gym_bodyweight: one per (account, local day)
  // gym_exercise_names: what one account calls one SEED, keyed (owner, movement) and coalesced over it.
  std::vector<std::pair<std::pair<std::string, std::string>, std::string>> displayNames;
  // gym_exercise_aliases: what one account USED to call a movement; `at` stands in for created_at.
  struct Alias {
    std::string user;
    std::string exercise;
    std::string name;
    std::uint64_t at;
  };
  std::vector<Alias> aliasRows;
  // gym_routines' three creation columns, which the entity does not carry: facts about the WRITE.
  struct Created {
    std::uint64_t atMs;
    std::optional<ProposalDoor> door;
    int movements;
  };
  std::map<std::string, Created> createdRoutines;   // by routine id

  void seed(const Exercise& exercise) { seeds.push_back(exercise); }
  void seedCustom(const UserId& owner, const Exercise& exercise) {
    customs.push_back({owner.str(), exercise});
  }
  // The rows as the store holds them once the engine admitted them, written straight in: a set takes
  // the next number of its movement within its session, as the set trigger numbers it.
  void seedSession(const Session& session) { sessions.push_back(session); }
  Set seedSet(Set set) {
    set.setNumber = 1;
    for (const Set& held : sets)
      if (held.session == set.session && held.exercise == set.exercise)
        set.setNumber = std::max(set.setNumber, held.setNumber + 1);
    sets.push_back(set);
    return set;
  }

  // Seeds under the name THIS account calls them, then its own movements, sorted on the resolved name.
  std::vector<Exercise> catalogOf(const UserId& user) const {
    std::vector<Exercise> out;
    for (const Exercise& row : seeds)
      out.push_back(Exercise{row.id, *nameOf(user, row.id), row.pattern, row.equipment, row.stepKg,
                             row.custom, aliasesOf(user, row.id)});
    for (const auto& [owner, exercise] : customs)
      if (owner == user.str())
        out.push_back(Exercise{exercise.id, exercise.name, exercise.pattern, exercise.equipment,
                               exercise.stepKg, exercise.custom, aliasesOf(user, exercise.id)});
    std::sort(out.begin(), out.end(), [](const Exercise& a, const Exercise& b) {
      return std::pair(toString(a.pattern), a.name) < std::pair(toString(b.pattern), b.name);
    });
    return out;
  }

  // The catalog read's predicate where a WRITE names a movement: a seed, or one this account created.
  bool visibleTo(const UserId& owner, const ExerciseId& exercise) const {
    for (const Exercise& known : catalogOf(owner))
      if (known.id == exercise) return true;
    return false;
  }

  // What THIS account calls a movement: its own line over the seed's name. A seed row is global.
  std::optional<std::string> nameOf(const UserId& user, const ExerciseId& id) const {
    for (const auto& [key, name] : displayNames)
      if (key.first == user.str() && key.second == id.str()) return name;
    for (const Exercise& exercise : seeds)
      if (exercise.id == id) return exercise.name;
    for (const auto& [owner, exercise] : customs)
      if (exercise.id == id) return exercise.name;
    return std::nullopt;
  }

  // A set is this caller's when the workout holding it is — the join the SQL scopes on.
  bool ownsSession(const UserId& user, const SessionId& id) const {
    for (const Session& ran : sessions)
      if (ran.id == id && ran.user == user) return true;
    return false;
  }

  // lastTrainedAtMs is derived on every read: the newest session this account started under the routine.
  Routine readRoutine(const Routine& stored) const {
    std::optional<std::uint64_t> lastTrained;
    for (const Session& session : sessions) {
      if (!(session.user == stored.user) || session.routine != stored.id) continue;
      if (!lastTrained || session.startedAtMs > *lastTrained) lastTrained = session.startedAtMs;
    }
    return Routine{stored.id,      stored.user, stored.name,     stored.position,
                   stored.entries, lastTrained, stored.revision};
  }

  // What this account used to call a movement, newest rename first.
  std::vector<std::string> aliasesOf(const UserId& user, const ExerciseId& id) const {
    std::vector<Alias> held;
    for (const Alias& row : aliasRows)
      if (row.user == user.str() && row.exercise == id.str()) held.push_back(row);
    std::sort(held.begin(), held.end(), [](const Alias& a, const Alias& b) {
      if (a.at != b.at) return a.at > b.at;
      return a.name < b.name;
    });
    std::vector<std::string> names;
    for (const Alias& row : held) names.push_back(row.name);
    return names;
  }
};

class FakeLogRepository : public LogRepository {
public:
  explicit FakeLogRepository(FakeGymStore& db) : db(db) {}

  FakeGymStore& db;

  std::optional<Session> open(const UserId& user) override {
    for (const Session& session : db.sessions)
      if (session.user == user && !session.finishedAtMs) return session;
    return std::nullopt;
  }

  std::optional<Session> session(const UserId& user, const SessionId& id) override {
    for (const Session& session : db.sessions)
      if (session.user == user && session.id == id) return session;
    return std::nullopt;
  }

  std::optional<Set> setOf(const UserId& user, const SetId& id) override {
    for (const Set& set : db.sets) {
      if (!(set.id == id)) continue;
      for (const Session& session : db.sessions)
        if (session.id == set.session && session.user == user) return set;
      return std::nullopt;   // another account's set is the same fact as no set at all
    }
    return std::nullopt;
  }

  std::vector<SessionRows> sessions(const UserId& user, const std::vector<SessionId>& ids) override {
    std::vector<SessionRows> rows;
    for (const SessionId& id : ids)
      if (const auto stored = session(user, id)) rows.push_back({*stored, setsOf(id)});
    return rows;
  }

  LogPage log(const UserId& user, const LogCursor& cursor) override {
    // The SQL's unique sort key: (startedAt, id) descending, the whole pair compared against the cursor.
    const std::string beforeId = cursor.beforeId ? cursor.beforeId->str() : "";
    std::vector<Session> page;
    for (const Session& session : db.sessions) {
      if (!(session.user == user)) continue;
      if (std::pair(session.startedAtMs, session.id.str()) >= std::pair(cursor.beforeMs, beforeId))
        continue;
      page.push_back(session);
    }
    std::sort(page.begin(), page.end(), [](const Session& a, const Session& b) {
      return std::pair(a.startedAtMs, a.id.str()) > std::pair(b.startedAtMs, b.id.str());
    });
    if (static_cast<int>(page.size()) > cursor.limit)
      page.erase(page.begin() + cursor.limit, page.end());

    LogPage out;
    for (const Session& session : page) {
      int count = 0;
      int working = 0;
      double tonnage = 0;
      std::set<std::string> names;   // iterates sorted, exactly like the SQL's ORDER BY the name
      std::optional<TopWorkingSet> top;
      std::vector<Set> held;
      std::optional<std::uint64_t> lastSetAtMs;
      for (const Set& set : db.sets) {
        if (!(set.session == session.id)) continue;
        ++count;
        if (std::optional<std::string> name = db.nameOf(user, set.exercise)) names.insert(*name);
        if (!lastSetAtMs || set.completedAtMs > *lastSetAtMs) lastSetAtMs = set.completedAtMs;
        held.push_back(set);
        if (set.kind != SetKind::working) continue;
        ++working;
        // `greatest(weight_kg, 0) * reps`: an assisted set moved no external weight, so it adds nothing.
        tonnage += std::max(set.weightKg, 0.0) * set.reps;
        // Heaviest working set, ties to more reps, never volume (TopWorkingSet).
        if (top && std::pair(set.weightKg, set.reps) <= std::pair(top->weightKg, top->reps))
          continue;
        top = TopWorkingSet{set.weightKg, set.reps};
      }
      // The marks statement, through marksOf and then dated by the SESSION (domain/Review.h).
      std::vector<PriorMark> marks = ordered(marksOf(held));
      for (PriorMark& one : marks) one.atMs = session.startedAtMs;
      // closed_by when the row carries it, else the four-hour rule's own signature for a legacy row.
      const bool closedItself =
          session.closedBy ? session.closedBy == ClosedBy::stale
                           : session.finishedAtMs &&
                                 *session.finishedAtMs == lastSetAtMs.value_or(session.startedAtMs);
      out.sessions.push_back(SessionSummary{session, count, working, tonnage,
                                            std::vector<std::string>(names.begin(), names.end()),
                                            top, std::move(marks), closedItself});
    }
    if (out.sessions.empty()) return out;

    // The standing statement: FINISHED sessions strictly older than the page's last row, on (startedAt, id).
    const Session& oldest = out.sessions.back().session;
    std::vector<Set> before;
    for (const Set& prior : db.sets) {
      if (prior.kind != SetKind::working) continue;
      bool onPage = false;
      for (const SessionSummary& row : out.sessions)
        for (const PriorMark& mark : row.workingMarks)
          if (mark.exercise == prior.exercise) onPage = true;
      if (!onPage) continue;
      for (const Session& ran : db.sessions) {
        if (!(ran.id == prior.session) || !(ran.user == user) || !ran.finishedAtMs) continue;
        if (std::pair(ran.startedAtMs, ran.id.str()) >=
            std::pair(oldest.startedAtMs, oldest.id.str()))
          continue;
        Set dated = prior;
        dated.completedAtMs = ran.startedAtMs;
        before.push_back(dated);
      }
    }
    out.standing = ordered(marksOf(before));
    return out;
  }

  std::vector<Set> setsOf(const SessionId& id) override {
    std::vector<Set> out;
    for (const Set& set : db.sets)
      if (set.session == id) out.push_back(set);
    std::sort(out.begin(), out.end(), [](const Set& a, const Set& b) {
      return std::pair(a.completedAtMs, a.setNumber) < std::pair(b.completedAtMs, b.setNumber);
    });
    return out;
  }

  // Finished sessions newest first on (startedAt, id), stopping at the first holding a non-warmup set.
  LastTimeOutcome lastTime(const UserId& user, const ExerciseId& exercise) override {
    std::optional<Session> newest;
    for (const Session& session : db.sessions) {
      if (!(session.user == user) || !session.finishedAtMs) continue;
      if (newest && std::pair(session.startedAtMs, session.id.str()) <
                        std::pair(newest->startedAtMs, newest->id.str()))
        continue;
      for (const Set& set : db.sets) {
        if (!(set.session == session.id) || !(set.exercise == exercise)) continue;
        if (set.kind == SetKind::warmup) continue;
        newest = session;
        break;
      }
    }
    if (!newest) {
      // Scoped like the catalog read: another account's custom movement is unknown, never merely unlogged.
      for (const Exercise& known : db.catalogOf(user))
        if (known.id == exercise) return {std::nullopt, LastTimeError::none};
      return {std::nullopt, LastTimeError::unknownExercise};
    }
    std::vector<Set> block;
    for (const Set& set : db.sets)
      if (set.session == newest->id && set.exercise == exercise && set.kind != SetKind::warmup)
        block.push_back(set);
    std::sort(block.begin(), block.end(),
              [](const Set& a, const Set& b) { return a.setNumber < b.setNumber; });
    // The name comes off the session's own frozen snapshot.
    return {LastTime{*newest, newest->displayName.value_or(newest->plan ? newest->plan->routineName : ""), block},
            LastTimeError::none};
  }

  // lastTime run over every movement this account's sets name, projected to the LAST row of each block.
  std::vector<LastSet> lastSets(const UserId& user) override {
    std::vector<ExerciseId> touched;
    for (const Set& set : db.sets) {
      if (!db.ownsSession(user, set.session)) continue;
      if (std::find(touched.begin(), touched.end(), set.exercise) == touched.end())
        touched.push_back(set.exercise);
    }
    std::sort(touched.begin(), touched.end(),
              [](const ExerciseId& a, const ExerciseId& b) { return a.str() < b.str(); });
    std::vector<LastSet> out;
    for (const ExerciseId& exercise : touched) {
      LastTimeOutcome last = lastTime(user, exercise);
      if (!last.lastTime) continue;
      const Set& tail = last.lastTime->sets.back();
      out.push_back(LastSet{exercise, tail.weightKg, tail.reps, last.lastTime->session.startedAtMs});
    }
    return out;
  }

  // Both windows compare the PAIR (startedAt, id), which keeps this session out of its own history.
  SessionHistory historyFor(const UserId& user, const Session& session) override {
    SessionHistory history;
    std::vector<Set> priorWorking;
    for (const Set& prior : db.sets) {
      if (prior.kind != SetKind::working) continue;
      std::optional<Session> ranIn;
      for (const Session& ran : db.sessions) {
        if (!(ran.id == prior.session) || !(ran.user == user) || !ran.finishedAtMs) continue;
        if (std::pair(ran.startedAtMs, ran.id.str()) <
            std::pair(session.startedAtMs, session.id.str()))
          ranIn = ran;
      }
      if (!ranIn) continue;
      bool workedToday = false;
      for (const Set& today : db.sets)
        if (today.session == session.id && today.exercise == prior.exercise &&
            today.kind == SetKind::working)
          workedToday = true;
      if (!workedToday) continue;
      // Carried over stamped with its SESSION's start, so the fold dates a mark by the earliest workout.
      Set dated = prior;
      dated.completedAtMs = ranIn->startedAtMs;
      priorWorking.push_back(dated);
    }
    std::sort(priorWorking.begin(), priorWorking.end(), [](const Set& a, const Set& b) {
      return std::tuple(a.exercise.str(), a.weightKg, -a.reps, a.completedAtMs) <
             std::tuple(b.exercise.str(), b.weightKg, -b.reps, b.completedAtMs);
    });
    for (const Set& prior : priorWorking) {
      if (!history.marks.empty() && history.marks.back().exercise == prior.exercise &&
          history.marks.back().weightKg == prior.weightKg)
        continue;
      history.marks.push_back(
          PriorMark{prior.exercise, prior.weightKg, prior.reps, prior.completedAtMs});
    }

    if (!session.routine) return history;   // no routine, no session to stand against
    for (const Session& ran : db.sessions) {
      if (!(ran.user == user) || !ran.finishedAtMs || ran.routine != session.routine) continue;
      if (std::pair(ran.startedAtMs, ran.id.str()) >=
          std::pair(session.startedAtMs, session.id.str()))
        continue;
      if (history.previous && std::pair(ran.startedAtMs, ran.id.str()) <
                                  std::pair(history.previous->startedAtMs,
                                            history.previous->id.str()))
        continue;
      history.previous = ran;
    }
    if (history.previous) history.previousSets = setsOf(history.previous->id);
    return history;
  }

  // The record read: the catalog predicate first, then the routines naming it, the sessions, the recent days.
  MovementHistory movementHistory(const UserId& user, const ExerciseId& exercise) override {
    MovementHistory history;
    for (const Exercise& known : db.catalogOf(user))
      if (known.id == exercise) history.exercise = known;
    if (!history.exercise) return history;

    // DISTINCT and in the lifter's own program order: a routine naming the movement twice is still one day.
    std::vector<Routine> naming;
    for (const Routine& routine : db.routineRows) {
      if (!(routine.user == user)) continue;
      for (const RoutineEntry& entry : routine.entries)
        if (entry.exercise == exercise) {
          naming.push_back(routine);
          break;
        }
    }
    std::sort(naming.begin(), naming.end(), [](const Routine& a, const Routine& b) {
      return std::pair(a.position, a.id.str()) < std::pair(b.position, b.id.str());
    });
    for (const Routine& routine : naming) history.routines.push_back(routine.name);

    std::vector<Session> ran;
    for (const Session& session : db.sessions)
      if (session.user == user && session.finishedAtMs) ran.push_back(session);
    std::sort(ran.begin(), ran.end(), [](const Session& a, const Session& b) {
      return std::pair(a.startedAtMs, a.id.str()) < std::pair(b.startedAtMs, b.id.str());
    });
    for (const Session& session : ran) {
      std::vector<Set> held;
      for (const Set& set : setsOf(session.id))
        if (set.exercise == exercise) held.push_back(set);
      std::vector<PriorMark> loads = ordered(marksOf(held));
      if (loads.empty()) continue;
      for (PriorMark& load : loads) load.atMs = session.startedAtMs;   // the store's dating rule
      history.sessions.push_back(MovementSession{session.id, session.startedAtMs, std::move(loads)});
    }

    for (auto session = ran.rbegin(); session != ran.rend(); ++session) {
      std::vector<Set> block;
      for (const Set& set : setsOf(session->id))
        if (set.exercise == exercise && set.kind != SetKind::warmup) block.push_back(set);
      if (block.empty()) continue;
      std::sort(block.begin(), block.end(),
                [](const Set& a, const Set& b) { return a.setNumber < b.setNumber; });
      history.recent.push_back(MovementDay{session->id, session->startedAtMs, std::move(block)});
      if (static_cast<int>(history.recent.size()) == kRecentDays) break;
    }
    return history;
  }

  // The series is DISTINCT ON (movement, session) dated by the SESSION; weeks are contiguous Monday-to-Monday UTC.
  TrainingLog trainingLog(const UserId& user) override {
    TrainingLog log;
    std::vector<std::pair<Session, Set>> lived = workingSetsOfFinished(user);

    std::sort(lived.begin(), lived.end(), [](const auto& a, const auto& b) {
      return std::tuple(a.second.exercise.str(), a.first.startedAtMs, a.first.id.str(),
                        -a.second.weightKg, -a.second.reps, a.second.completedAtMs) <
             std::tuple(b.second.exercise.str(), b.first.startedAtMs, b.first.id.str(),
                        -b.second.weightKg, -b.second.reps, b.second.completedAtMs);
    });
    std::optional<std::pair<std::string, std::string>> lastTop;
    for (const auto& [ran, set] : lived) {
      const std::pair<std::string, std::string> key{set.exercise.str(), ran.id.str()};
      if (lastTop == key) continue;
      lastTop = key;
      log.tops.push_back(MovementTop{set.exercise, ran.startedAtMs, set.weightKg, set.reps});
    }

    std::vector<Set> priors;
    for (const auto& [ran, set] : lived) {
      Set dated = set;
      dated.completedAtMs = ran.startedAtMs;   // a mark is dated by the workout that set it
      priors.push_back(dated);
    }
    std::sort(priors.begin(), priors.end(), [](const Set& a, const Set& b) {
      return std::tuple(a.exercise.str(), a.weightKg, -a.reps, a.completedAtMs) <
             std::tuple(b.exercise.str(), b.weightKg, -b.reps, b.completedAtMs);
    });
    for (const Set& prior : priors) {
      if (!log.marks.empty() && log.marks.back().exercise == prior.exercise &&
          log.marks.back().weightKg == prior.weightKg)
        continue;
      log.marks.push_back(
          PriorMark{prior.exercise, prior.weightKg, prior.reps, prior.completedAtMs});
    }

    std::map<std::uint64_t, TrainingWeek> byWeek;
    for (const Session& ran : db.sessions) {
      if (!(ran.user == user) || !ran.finishedAtMs) continue;
      TrainingWeek& counted = byWeek[weekStartMs(ran.startedAtMs)];
      counted.startedAtMs = weekStartMs(ran.startedAtMs);
      ++counted.sessions;
    }
    for (const auto& [ran, set] : lived) {
      TrainingWeek& counted = byWeek[weekStartMs(ran.startedAtMs)];
      counted.startedAtMs = weekStartMs(ran.startedAtMs);
      ++counted.workingSets;
    }
    if (byWeek.empty()) return log;
    for (std::uint64_t week = byWeek.begin()->first; week <= byWeek.rbegin()->first;
         week += 604'800'000) {
      const auto held = byWeek.find(week);
      if (held == byWeek.end()) {
        log.weeks.push_back(TrainingWeek{week, 0, 0});
        continue;
      }
      log.weeks.push_back(held->second);
    }
    return log;
  }

  std::vector<LogShare> logShareRows;
  std::map<std::string, std::vector<HistoryWorkout>> logSnapshots;
  std::set<std::string> revokedLogShares;

  HistoryPage history(const UserId& user, const HistoryQuery& query) override {
    std::vector<HistoryWorkout> workouts;
    for (const Session& session : db.sessions) {
      if (session.user != user || !session.finishedAtMs) continue;
      HistoryWorkout workout{session.id.str(), session.startedAtMs, *session.finishedAtMs,
          session.routine ? session.routine->str() : "", session.displayName.value_or(session.plan ? session.plan->routineName : ""), {}};
      for (const Set& set : setsOf(session.id))
        workout.sets.push_back(HistorySet{set.id.str(), set.exercise.str(),
            db.nameOf(user, set.exercise).value_or(""), set.setNumber, set.weightKg, set.reps,
            set.rpe, set.completedAtMs, set.kind == SetKind::working});
      workouts.push_back(std::move(workout));
    }
    return historyPage(std::move(workouts), query);
  }

  std::optional<LogShare> createLogShare(const LogShare& incoming) override {
    for (const LogShare& held : logShareRows) {
      if (held.id != incoming.id) continue;
      if (!held.sameRequest(incoming) || held.expiresAtMs <= incoming.createdAtMs ||
          revokedLogShares.contains(held.id)) return std::nullopt;
      return held;
    }
    logShareRows.push_back(incoming);
    if (incoming.mode == LogShareMode::snapshot) {
      HistoryQuery query = incoming.constrain(HistoryQuery{});
      query.limit = 200;
      for (;;) {
        const HistoryPage page = history(incoming.user, query);
        auto& rows = logSnapshots[incoming.id];
        rows.insert(rows.end(), page.sessions.begin(), page.sessions.end());
        if (!page.hasMore) break;
        query.beforeMs = page.sessions.back().startedAtMs;
        query.beforeId = page.sessions.back().id;
      }
    }
    return incoming;
  }

  std::vector<LogShare> logShares(const UserId& user, std::uint64_t nowMs) override {
    std::vector<LogShare> rows;
    for (const LogShare& share : logShareRows)
      if (share.user == user && share.expiresAtMs > nowMs && !revokedLogShares.contains(share.id))
        rows.push_back(share);
    std::reverse(rows.begin(), rows.end());
    return rows;
  }

  void revokeLogShare(const UserId& user, const std::string& id) override {
    for (const LogShare& share : logShareRows)
      if (share.user == user && share.id == id) {
        revokedLogShares.insert(id);
        logSnapshots.erase(id);
      }
  }

  std::optional<SharedHistory> sharedHistory(const std::string& token,
      const HistoryQuery& query, std::uint64_t nowMs) override {
    for (const LogShare& share : logShareRows) {
      if (share.token != token || share.expiresAtMs <= nowMs || revokedLogShares.contains(share.id)) continue;
      if (share.mode == LogShareMode::snapshot)
        return SharedHistory{share, historyPage(logSnapshots[share.id], share.constrain(query))};
      return SharedHistory{share, history(share.user, share.constrain(query))};
    }
    return std::nullopt;
  }

  std::vector<ProgressSet> progressHistory(const UserId& user) override {
    std::vector<ProgressSet> history;
    for (const auto& [session, set] : workingSetsOfFinished(user))
      history.push_back(ProgressSet{session.id, session.startedAtMs, set.exercise,
                                   PerformedFact{set.id, set.weightKg, set.reps, set.rpe}});
    std::sort(history.begin(), history.end(), [](const ProgressSet& a, const ProgressSet& b) {
      return std::tuple(a.startedAtMs, a.session.str(), a.exercise.str(), a.performed.set.str()) <
             std::tuple(b.startedAtMs, b.session.str(), b.exercise.str(), b.performed.set.str());
    });
    return history;
  }

  // The INSERT..SELECT off the caller's own session row; the conflict is on the SESSION, so a live share replays.
  std::optional<SessionShare> insertShare(const SessionShare& incoming,
                                          std::uint64_t nowMs) override {
    bool owned = false;
    for (const Session& ran : db.sessions)
      if (ran.id == incoming.session && ran.user == incoming.user) owned = true;
    if (!owned) return std::nullopt;
    for (SessionShare& held : db.shares) {
      if (!(held.session == incoming.session)) continue;
      if (held.expiresAtMs > nowMs) return held;
      held = incoming;
      return held;
    }
    db.shares.push_back(incoming);
    return incoming;
  }

  bool revokeShare(const UserId& user, const SessionId& id) override {
    for (auto row = db.shares.begin(); row != db.shares.end(); ++row) {
      if (!(row->session == id) || !(row->user == user)) continue;
      db.shares.erase(row);
      return true;
    }
    return false;   // absent and another account's are the same fact here too
  }

  // Revoked, expired and never-minted are one value here, so nothing above can tell them apart.
  std::optional<SharedSession> sharedSession(const std::string& token,
                                             std::uint64_t nowMs) override {
    for (const SessionShare& held : db.shares) {
      if (held.token != token || held.expiresAtMs <= nowMs) continue;
      for (const Session& ran : db.sessions) {
        if (!(ran.id == held.session)) continue;
        std::vector<SharedSet> block;
        for (const Set& set : setsOf(ran.id)) {
          std::optional<std::string> movement = db.nameOf(ran.user, set.exercise);
          if (!movement) continue;
          block.push_back(SharedSet{*movement, set.setNumber, set.weightKg, set.reps, set.kind,
                                    set.rpe, set.note, set.completedAtMs});
        }
        return SharedSession{ran.startedAtMs, ran.finishedAtMs,
                             ran.displayName.value_or(ran.plan ? ran.plan->routineName : ""), std::move(block)};
      }
    }
    return std::nullopt;
  }

private:
  static HistoryPage historyPage(std::vector<HistoryWorkout> workouts, const HistoryQuery& query) {
    std::sort(workouts.begin(), workouts.end(), [](const auto& a, const auto& b) {
      return std::pair(a.startedAtMs, a.id) > std::pair(b.startedAtMs, b.id);
    });
    HistoryPage page;
    std::vector<ProgressSet> facts;
    std::map<std::string, HistoryFacet> exercises;
    std::map<std::string, HistoryFacet> routines;
    std::map<std::string, int> months;
    for (const auto& workout : workouts) {
      if (workout.startedAtMs < query.fromMs || workout.startedAtMs >= query.untilMs ||
          (!query.routine.empty() && workout.routineId != query.routine)) continue;
      if (!query.exercise.empty() && std::none_of(workout.sets.begin(), workout.sets.end(),
          [&](const auto& set) { return set.exerciseId == query.exercise; })) continue;
      for (const auto& set : workout.sets)
        if (set.working) facts.push_back(ProgressSet{SessionId{workout.id}, workout.startedAtMs,
            ExerciseId{set.exerciseId}, PerformedFact{SetId{set.id}, set.weightKg, set.reps, set.rpe}});
      const auto totals = workout.totals();
      ++page.summary.sessions;
      page.summary.sets += totals.sets;
      page.summary.reps += totals.reps;
      page.summary.tonnageKg += totals.tonnageKg;
      const std::chrono::year_month_day date{std::chrono::floor<std::chrono::days>(
          std::chrono::sys_time<std::chrono::milliseconds>{std::chrono::milliseconds{workout.startedAtMs}})};
      const unsigned month = unsigned(date.month());
      ++months[std::to_string(int(date.year())) + "-" + (month < 10 ? "0" : "") + std::to_string(month)];
      std::set<std::string> seen;
      for (const auto& set : workout.sets) {
        if (!seen.insert(set.exerciseId).second) continue;
        auto& facet = exercises[set.exerciseId];
        facet.id = set.exerciseId;
        facet.name = set.exercise;
        ++facet.sessions;
      }
      if (!workout.routineId.empty()) {
        auto& facet = routines[workout.routineId];
        if (facet.id.empty()) facet = HistoryFacet{workout.routineId, workout.routineName, 0};
        ++facet.sessions;
      }
      if (std::pair(workout.startedAtMs, workout.id) >= std::pair(query.beforeMs, query.beforeId)) continue;
      if (page.sessions.size() < static_cast<std::size_t>(query.limit)) page.sessions.push_back(workout);
      else page.hasMore = true;
    }
    for (auto row = months.rbegin(); row != months.rend(); ++row)
      page.months.push_back(HistoryMonth{row->first, row->second});
    for (const auto& [id, facet] : exercises) page.exercises.push_back(facet);
    for (const auto& [id, facet] : routines) page.routines.push_back(facet);
    if (query.includeProgress) {
      std::sort(facts.begin(), facts.end(), [](const auto& a, const auto& b) {
        return std::tuple(a.startedAtMs,a.session.str(),a.exercise.str(),a.performed.set.str()) <
               std::tuple(b.startedAtMs,b.session.str(),b.exercise.str(),b.performed.set.str());
      });
      page.progress = statsProgress(facts, query.asOfMs);
    }
    return page;
  }

  // This account's working sets in its FINISHED sessions only, each carrying the session it was lived in.
  std::vector<std::pair<Session, Set>> workingSetsOfFinished(const UserId& user) const {
    std::vector<std::pair<Session, Set>> lived;
    for (const Set& set : db.sets) {
      if (set.kind != SetKind::working) continue;
      for (const Session& ran : db.sessions) {
        if (!(ran.id == set.session) || !(ran.user == user) || !ran.finishedAtMs) continue;
        lived.push_back({ran, set});
      }
    }
    return lived;
  }

  // The order both DISTINCT ON statements hand marks back in: by movement, heaviest load first.
  static std::vector<PriorMark> ordered(std::vector<PriorMark> marks) {
    std::sort(marks.begin(), marks.end(), [](const PriorMark& a, const PriorMark& b) {
      return std::pair(a.exercise.str(), -a.weightKg) < std::pair(b.exercise.str(), -b.weightKg);
    });
    return marks;
  }
};

class FakeCatalogRepository : public CatalogRepository {
public:
  explicit FakeCatalogRepository(FakeGymStore& db) : db(db) {}

  FakeGymStore& db;

  // The store's projection, which is also the predicate every write naming a movement checks (visibleTo).
  std::vector<Exercise> catalog(const UserId& user) override { return db.catalogOf(user); }
};

class FakeProgramRepository : public ProgramRepository {
public:
  std::optional<Routine> routineCreation(const UserId& user, const RoutineId& id) override {
    for (const auto& row : db.routineCreations) if (row.user == user && row.id == id) return row;
    return std::nullopt;
  }

  explicit FakeProgramRepository(FakeGymStore& db) : db(db) {}

  FakeGymStore& db;

  std::vector<Routine> routines(const UserId& user) override {
    std::vector<Routine> out;
    for (const Routine& routine : db.routineRows)
      if (routine.user == user) out.push_back(db.readRoutine(routine));
    // Most recently trained first, the never-trained after them, ties broken by (position, id).
    std::sort(out.begin(), out.end(), [](const Routine& a, const Routine& b) {
      if (a.lastTrainedAtMs != b.lastTrainedAtMs) {
        if (!a.lastTrainedAtMs) return false;
        if (!b.lastTrainedAtMs) return true;
        return *a.lastTrainedAtMs > *b.lastTrainedAtMs;
      }
      return std::pair(a.position, a.id.str()) < std::pair(b.position, b.id.str());
    });
    return out;
  }

  std::optional<Routine> routine(const UserId& user, const RoutineId& id) override {
    for (const Routine& routine : db.routineRows)
      if (routine.user == user && routine.id == id) return db.readRoutine(routine);
    return std::nullopt;   // another account's routine is the same fact as no routine at all
  }

  // Proposals newest first, bounded, then the creation row — always last and never against the bound.
  std::vector<RoutineEvent> routineHistory(const UserId& user, const RoutineId& id) override {
    std::vector<RoutineEvent> history;
    if (!routine(user, id)) return history;
    for (const ProposalHead& head : proposalHeads(user, ProposalQuery{id, false})) {
      if (static_cast<int>(history.size()) == kRoutineHistoryProposals) break;
      history.push_back(
          RoutineEvent{RoutineEventKind::proposal, head.createdAtMs, std::nullopt, std::nullopt,
                       head});
    }
    const auto made = db.createdRoutines.find(id.str());
    // A row seeded straight into routineRows carries no creation columns, and zero is not an instant.
    if (made == db.createdRoutines.end())
      history.push_back(
          RoutineEvent{RoutineEventKind::created, 0, std::nullopt, std::nullopt, std::nullopt});
    else
      history.push_back(RoutineEvent{RoutineEventKind::created, made->second.atMs,
                                     made->second.door, made->second.movements, std::nullopt});
    return history;
  }

  std::vector<ProposalHead> proposalHeads(const UserId& user, const ProposalQuery& query) override {
    std::vector<ProposalHead> out;
    for (const RoutineProposal& held : db.proposalRows) {
      if (!(held.head.user == user)) continue;
      if (query.routine && !(held.head.routine == *query.routine)) continue;
      if (query.pendingOnly && held.head.state != ProposalState::pending) continue;
      out.push_back(held.head);
    }
    // Newest first on (createdAt, id), the unique key the SQL orders by.
    std::sort(out.begin(), out.end(), [](const ProposalHead& a, const ProposalHead& b) {
      return std::pair(a.createdAtMs, a.id.str()) > std::pair(b.createdAtMs, b.id.str());
    });
    return out;
  }

  std::optional<RoutineProposal> proposal(const UserId& user, const ProposalId& id) override {
    for (const RoutineProposal& held : db.proposalRows) {
      if (!(held.head.id == id) || !(held.head.user == user)) continue;
      return withLoggedSets(held, user);
    }
    return std::nullopt;   // another account's is the same fact as no proposal at all
  }

private:
  // The `loggedSets` pass, which the SQL does with a LEFT JOIN onto gym_sets at READ time.
  RoutineProposal withLoggedSets(RoutineProposal held, const UserId& user) const {
    for (RoutineChange& change : held.changes) {
      if (change.kind != ChangeKind::removed) continue;
      change.loggedSets = 0;
      for (const Set& set : db.sets)
        if (set.exercise == change.exercise && db.ownsSession(user, set.session))
          ++change.loggedSets;
    }
    return held;
  }

};

class FakeAskThreadRepository : public AskThreadRepository {
public:
  explicit FakeAskThreadRepository(FakeGymStore& db) : db(db) {}
  std::vector<ThreadId> deletedThreads;
  struct GenerationRow {
    UserId user;
    ThreadId thread;
    AskGeneration generation;
    std::vector<CoachOperation> operations;
  };
  std::vector<GenerationRow> generations;
  struct ImageRow { UserId user; ThreadId thread; CoachImage image; };
  std::vector<ImageRow> images;
  std::optional<CoachImage> image(const UserId& user, const ThreadId& thread, const std::string& id) override {
    for (const auto& row : images)
      if (row.user == user && row.thread == thread && row.image.attachment.id == id) return row.image;
    return std::nullopt;
  }
  ImageWriteError putImage(const UserId& user, const ThreadId& thread, const CoachImage& image) override {
    for (const auto& held : db.threadRows)
      if (held.id == thread && held.user != user) return ImageWriteError::notFound;
    for (const auto& row : images)
      if (row.image.attachment.id == image.attachment.id)
        return row.user == user && row.thread == thread && row.image.data == image.data ? ImageWriteError::none : ImageWriteError::idTaken;
    images.push_back({user, thread, image});
    return ImageWriteError::none;
  }
  std::optional<AskGeneration> stopGeneration(const UserId& user, const ThreadId& thread, const std::string& requestId) override {
    for (auto& row : generations)
      if (row.user == user && row.thread == thread && row.generation.requestId == requestId && row.generation.status == "running")
        row.generation.stopRequested = true;
    return generation(user, thread, requestId);
  }
  std::set<std::string> active;
  std::mutex mutex;

  struct Lease : ThreadLease {
    FakeAskThreadRepository& repository;
    std::string id;
    Lease(FakeAskThreadRepository& repository, std::string id) : repository(repository), id(std::move(id)) {}
    ~Lease() override { std::lock_guard lock(repository.mutex); repository.active.erase(id); }
  };
  bool threadAvailable(const UserId& user, const ThreadId& id) override {
    if (std::find(deletedThreads.begin(), deletedThreads.end(), id) != deletedThreads.end()) return false;
    for (const auto& row : db.threadRows) if (row.id == id && row.user != user) return false;
    return true;
  }
  std::unique_ptr<ThreadLease> tryLease(const UserId&, const ThreadId& id) override {
    std::lock_guard lock(mutex);
    if (!active.insert(id.str()).second) return nullptr;
    return std::make_unique<Lease>(*this, id.str());
  }
  std::vector<AskThread> threadPage(const UserId& user, const ThreadCursor& cursor) override {
    std::vector<AskThread> result;
    for (const auto& held : db.threadRows)
      if (held.user == user && (!cursor.beforeMs || std::pair(held.askedAtMs, held.id.str()) < std::pair(cursor.beforeMs, cursor.beforeId)))
        result.push_back(withMinted(held, false));
    std::sort(result.begin(), result.end(), [](const auto& a, const auto& b) {
      return std::pair(a.askedAtMs, a.id.str()) > std::pair(b.askedAtMs, b.id.str());
    });
    if (result.size() > static_cast<std::size_t>(cursor.limit)) result.resize(cursor.limit);
    return result;
  }
  std::optional<AskThread> messagePage(const UserId& user, const ThreadId& id, std::uint64_t before, int limit) override {
    auto result = thread(user, id);
    if (!result) return result;
    std::erase_if(result->turns, [&](const auto& turn) { return before && turn.position >= before; });
    if (result->turns.size() > static_cast<std::size_t>(limit)) {
      result->turns.erase(result->turns.begin(), result->turns.end() - limit);
      result->nextCursor = std::to_string(result->turns.front().position);
    }
    return result;
  }
  std::optional<AskGeneration> generation(const UserId& user, const ThreadId& thread, const std::string& requestId) override {
    for (const auto& row : generations)
      if (row.user == user && row.thread == thread && row.generation.requestId == requestId) return row.generation;
    return std::nullopt;
  }
  void saveGeneration(const UserId& user, const ThreadId& thread, AskGeneration& generation) override {
    auto prior = this->generation(user, thread, generation.requestId);
    if (prior && (prior->status == "completed" || prior->status == "stopped")) { generation = *prior; return; }
    generation.revision = prior ? prior->revision + 1 : 1;
    generation.stopRequested = prior && prior->stopRequested;
    bool found = false;
    for (auto& row : generations)
      if (row.user == user && row.thread == thread && row.generation.requestId == generation.requestId) {
        row.generation = generation; found = true;
      }
    if (!found) generations.push_back({user, thread, generation});
    if (generation.status != "running") {
      bool replaced = false;
      for (auto& held : db.threadRows)
        if (held.id == thread && held.user == user)
          for (auto& turn : held.turns)
            if (turn.generationId == generation.id) {
              turn.text = turn.fromLifter ? generation.question : generation.answer;
              turn.receipt = turn.fromLifter ? std::nullopt : generation.receipt;
              turn.results = turn.fromLifter ? std::vector<CoachResult>{} : generation.results;
              turn.status = generation.status;
              replaced = true;
            }
      if (!replaced) appendTurns(user, thread, {{true, generation.question, generation.atMs, {}, 0, generation.id, {}, generation.requestId, generation.status, generation.attachments},
        {false, generation.answer, generation.atMs, generation.receipt, 0, generation.id, generation.results, generation.requestId, generation.status}});
    }
    for (auto& held : db.threadRows)
      if (held.user == user && held.id == thread) { held.generation = generation; held.askedAtMs = generation.atMs; }
  }
  std::vector<CoachOperation> operations(const UserId& user, const ThreadId& thread, const std::string& generationId) override {
    for (const auto& row : generations)
      if (row.user == user && row.thread == thread && row.generation.id == generationId) return row.operations;
    return {};
  }
  void saveOperation(const UserId& user, const ThreadId& thread, const std::string& generationId, const CoachOperation& operation) override {
    for (auto& row : generations) {
      if (row.user != user || row.thread != thread || row.generation.id != generationId) continue;
      for (auto& stored : row.operations)
        if (stored.id == operation.id) { stored = operation; return; }
      row.operations.push_back(operation);
      return;
    }
  }



  FakeGymStore& db;

  // The turns are stored on the row; `minted` is DERIVED on every read from the proposal ledger.
  std::vector<AskThread> threads(const UserId& user) override {
    std::vector<AskThread> out;
    for (const AskThread& held : db.threadRows)
      if (held.user == user) out.push_back(withMinted(held, false));
    std::sort(out.begin(), out.end(), [](const AskThread& a, const AskThread& b) {
      return std::pair(a.askedAtMs, a.id.str()) > std::pair(b.askedAtMs, b.id.str());
    });
    if (static_cast<int>(out.size()) > kThreadList) out.resize(kThreadList);
    return out;
  }

  std::optional<AskThread> thread(const UserId& user, const ThreadId& id) override {
    for (const AskThread& held : db.threadRows)
      if (held.id == id && held.user == user) return withMinted(held, true);
    return std::nullopt;   // absent and another account's are one answer
  }

  ThreadOpenOutcome openThread(const UserId& user, const ThreadId& id, const std::string& title,
                               std::uint64_t nowMs) override {
    // The store's race, made reachable: the loser's insert loses to ON CONFLICT DO NOTHING and reads back empty.
    if (db.loseThreadRace) return {std::nullopt, ThreadOpenError::none};
    if (std::find(deletedThreads.begin(), deletedThreads.end(), id) != deletedThreads.end()) return {std::nullopt, ThreadOpenError::idTaken};
    for (const AskThread& held : db.threadRows) {
      if (!(held.id == id)) continue;
      if (!(held.user == user)) return {std::nullopt, ThreadOpenError::idTaken};
      return {withMinted(held, true), ThreadOpenError::none};
    }
    // The title is written ONCE, here, from the lifter's first message.
    db.threadRows.push_back(AskThread{id, user, title, nowMs, nowMs, {}, {}});
    return {withMinted(db.threadRows.back(), true), ThreadOpenError::none};
  }

  void appendTurns(const UserId& user, const ThreadId& id,
                   const std::vector<ThreadTurn>& turns) override {
    for (AskThread& held : db.threadRows) {
      if (!(held.id == id) || !(held.user == user)) continue;
      for (ThreadTurn turn : turns) {
        turn.position = held.turns.size() + 1;
        held.turns.push_back(turn);
      }
      if (!turns.empty()) held.askedAtMs = turns.back().atMs;
      return;
    }
  }

  void discardEmptyThread(const UserId& user, const ThreadId& id) override {
    std::erase_if(db.threadRows, [&](const AskThread& held) {
      return held.id == id && held.user == user && held.turns.empty() && !held.generation;
    });
  }

  bool deleteThread(const UserId& user, const ThreadId& id,
                    const std::function<void()>& beforeDelete) override {
    if (!thread(user, id)) return false;
    auto lease = tryLease(user, id);
    if (!lease) throw ThreadBusy{};
    beforeDelete();
    const std::size_t before = db.threadRows.size();
    std::erase_if(db.threadRows,
                  [&](const AskThread& held) { return held.id == id && held.user == user; });
    if (db.threadRows.size() == before) return false;
    deletedThreads.push_back(id);
    std::erase_if(images, [&](const auto& row) { return row.thread == id && row.user == user; });
    std::erase_if(generations, [&](const auto& row) { return row.thread == id && row.user == user; });
    // `on delete set null`: every proposal the conversation minted keeps its row and loses only the link.
    for (RoutineProposal& held : db.proposalRows)
      if (held.head.source.thread == id) held.head.source.thread.reset();
    return true;
  }

private:
  // What this conversation minted, in mint order, each carrying the routine's name AS IT NOW STANDS.
  AskThread withMinted(const AskThread& held, bool withTurns) const {
    AskThread out = held;
    out.results.clear();
    for (const auto& row : generations)
      if (row.user == held.user && row.thread == held.id)
        out.results.insert(out.results.end(), row.generation.results.begin(), row.generation.results.end());
    out.referencedProposals.clear();
    for (ThreadTurn& turn : out.turns) {
      if (turn.fromLifter || (turn.receipt && !turn.receipt->valid())) turn.receipt.reset();
      if (!turn.receipt) continue;
      for (const std::string& id : turn.receipt->proposals)
        out.referencedProposals.emplace_back(id);
    }
    if (!withTurns) out.turns.clear();
    out.minted.clear();
    std::vector<const RoutineProposal*> minted;
    for (const RoutineProposal& proposal : db.proposalRows) {
      if (proposal.head.source.thread != held.id) continue;
      if (!(proposal.head.user == held.user)) continue;
      minted.push_back(&proposal);
    }
    std::sort(minted.begin(), minted.end(),
              [](const RoutineProposal* a, const RoutineProposal* b) {
                return std::pair(a->head.createdAtMs, a->head.id.str()) <
                       std::pair(b->head.createdAtMs, b->head.id.str());
              });
    for (const RoutineProposal* proposal : minted) {
      // The SQL joins gym_routines, so a proposal whose routine is gone is off this list.
      std::string name;
      bool found = false;
      for (const Routine& routine : db.routineRows)
        if (routine.id == proposal->head.routine) {
          name = routine.name;
          found = true;
        }
      if (!found) continue;
      out.minted.push_back(ThreadProposal{proposal->head.id, proposal->head.state,
                                          proposal->head.changes, proposal->head.routine, name,
                                          proposal->head.createdAtMs});
    }
    return out;
  }
};

class FakePreferencesRepository : public PreferencesRepository {
public:
  explicit FakePreferencesRepository(FakeGymStore& db) : db(db) {}

  FakeGymStore& db;

  // At most one row per account; a lifter who never wrote holds NONE, and the defaults are a layer up.
  std::optional<GymPreferences> preferences(const UserId& user) override {
    for (const GymPreferences& row : db.preferenceRows)
      if (row.user == user) return row;
    return std::nullopt;
  }

};

class FakeNotesRepository : public NotesRepository {
public:
  explicit FakeNotesRepository(FakeGymStore& db) : db(db) {}

  FakeGymStore& db;

  // Owner-scoped, position ascending — the SQL's ORDER BY.
  std::vector<Note> notes(const UserId& user) override {
    std::vector<Note> out;
    for (const Note& note : db.noteRows)
      if (note.user == user) out.push_back(note);
    std::sort(out.begin(), out.end(),
              [](const Note& a, const Note& b) { return a.position < b.position; });
    return out;
  }

  std::optional<Note> noteSave(const UserId& user, const NoteId& id) override {
    const auto saved = db.noteSaves.find(id.str());
    if (saved == db.noteSaves.end() || saved->second.user != user) return std::nullopt;
    return saved->second;
  }

};

class FakeBodyweightRepository : public BodyweightRepository {
public:
  explicit FakeBodyweightRepository(FakeGymStore& db) : db(db) {}

  FakeGymStore& db;

  // Owner-scoped, both bounds inclusive, day ascending — the SQL's WHERE and ORDER BY. The day
  // strings compare as the calendar does, because they are zero-padded YYYY-MM-DD.
  std::vector<Bodyweight> entries(const UserId& user, const BodyweightRange& range) override {
    std::vector<Bodyweight> out;
    for (const Bodyweight& held : db.bodyweightRows) {
      if (!(held.user == user)) continue;
      if (!range.from.empty() && held.dateLocal < range.from) continue;
      if (!range.to.empty() && held.dateLocal > range.to) continue;
      out.push_back(held);
    }
    std::sort(out.begin(), out.end(),
              [](const Bodyweight& a, const Bodyweight& b) { return a.dateLocal < b.dateLocal; });
    return out;
  }

  std::optional<Bodyweight> latest(const UserId& user) override {
    const std::vector<Bodyweight> all = entries(user, BodyweightRange{});
    if (all.empty()) return std::nullopt;
    return all.back();
  }

};

// The whole store and its seven doors, in the shape a harness holds them.
struct FakeGym {
  FakeGymStore db;
  FakeLogRepository log{db};
  FakeCatalogRepository catalog{db};
  FakeProgramRepository program{db};
  FakeAskThreadRepository threads{db};
  FakePreferencesRepository preferences{db};
  FakeNotesRepository notes{db};
  FakeBodyweightRepository bodyweight{db};
};

// The door an in-memory harness hands its services. A read settles nothing and every write is refused:
// the write rules are the engine's, and their tests run on the real door (GymDoorFixture.h).
struct ReadOnlyDoor : GymWriteDoor {
  [[noreturn]] static void refuse() {
    throw std::logic_error("an in-memory gym harness writes nothing: seed FakeGymStore, or test the write on GymDoor");
  }
  void closeStale(const UserId&) override {}
  void unlinkThread(const UserId&, const ThreadId&) override {}
  StartOutcome start(const UserId&, const SessionStart&) override { refuse(); }
  AppendOutcome append(const UserId&, const SessionId&, const SetWrite&) override { refuse(); }
  BatchLogOutcome appendSets(const UserId&, const SessionId&, const std::vector<SetWrite>&) override { refuse(); }
  BatchLogOutcome importSession(const UserId&, const SessionImport&) override { refuse(); }
  FinishOutcome finish(const UserId&, const SessionId&, std::uint64_t) override { refuse(); }
  DiscardOutcome discard(const UserId&, const SessionId&) override { refuse(); }
  RoutineWriteOutcome createRoutine(const Routine&, std::optional<ProposalDoor>) override { refuse(); }
  ProposalMintOutcome propose(const UserId&, const ProposalWrite&) override { refuse(); }
  ProposalMintOutcome proposeRemoval(const UserId&, const ProposalId&, const RoutineId&, const std::string&,
                                     const ProposalSource&) override { refuse(); }
  ExerciseInsertOutcome createExercise(const UserId&, const Exercise&) override { refuse(); }
  NoteWriteOutcome saveInsight(const Note&) override { refuse(); }
};

// An AskAgent that never leaves the process: it records what it was handed, runs its plan, answers.
struct FakeAsk : AskAgent {
  bool wired = true;
  bool answers = true;
  // Metered vendor round trips this run completed; zero is a run that reached nobody.
  int turnsSpent = 1;
  bool throwsUp = false;
  int runs = 0;
  ToolScope grantedScope;
  Json::Value seenCatalog{Json::arrayValue};
  std::vector<AskTurn> seenTurns;
  // What the "model" reaches for, in order.
  std::vector<std::pair<std::string, Json::Value>> plan;

  bool configured() const override { return wired; }

  AskAnswer answer(const std::vector<AskTurn>& turns, const ToolCaller& caller,
                   ToolHost& tools) override {
    ++runs;
    if (throwsUp) throw std::runtime_error("the vendor sent a document nobody can read");
    grantedScope = caller.scope;
    seenCatalog = tools.listTools(caller);
    seenTurns = turns;
    AskAnswer out;
    out.modelTurns = turnsSpent;
    for (const std::pair<std::string, Json::Value>& step : plan) {
      const ToolResult result = tools.callTool(step.first, step.second, caller);
      out.steps.push_back(AskStep{step.first, result.isError});
    }
    out.ok = answers;
    if (!answers) {
      out.error = "the upstream never answered";
      return out;
    }
    out.answer = "You squatted 100 for five.";
    return out;
  }
};

}

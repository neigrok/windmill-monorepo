#pragma once

#include "products/gym/ports/AskAgent.h"
#include "products/gym/ports/AskThreadRepository.h"
#include "products/gym/ports/CatalogRepository.h"
#include "products/gym/ports/LogRepository.h"
#include "products/gym/ports/NotesRepository.h"
#include "products/gym/ports/PreferencesRepository.h"
#include "products/gym/ports/ProgramRepository.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <ctime>
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

// The export's three renderings, mirroring the SQL's `to_char(… AT TIME ZONE 'UTC')` and `::text` casts.
inline std::string isoUtc(std::uint64_t instantMs) {
  const std::time_t seconds = static_cast<std::time_t>(instantMs / 1000);
  std::tm parts{};
  gmtime_r(&seconds, &parts);
  char text[32] = {0};
  std::snprintf(text, sizeof(text), "%04d-%02d-%02dT%02d:%02d:%02dZ", parts.tm_year + 1900,
                parts.tm_mon + 1, parts.tm_mday, parts.tm_hour, parts.tm_min, parts.tm_sec);
  return text;
}

inline std::string scaled(double value, int decimals) {
  char text[32] = {0};
  std::snprintf(text, sizeof(text), "%.*f", decimals, value);
  return text;
}

// Monday 00:00 UTC, as `date_trunc('week', ts AT TIME ZONE 'UTC')` answers, clamped like the adapter.
inline std::uint64_t weekStartMs(std::uint64_t instantMs) {
  const long long kWeek = 604'800'000;
  const long long kEpochToMonday = 259'200'000;
  const long long shifted = static_cast<long long>(instantMs) + kEpochToMonday;
  const long long start = (shifted / kWeek) * kWeek - kEpochToMonday;
  if (start < 1) return 1;
  return static_cast<std::uint64_t>(start);
}
inline RoutineEntry benchEntry(int position = 1) {
  return RoutineEntry{position, ExerciseId{"bench-press"}, 5, 5, 82.5, 180};
}
inline Routine pushA(std::vector<RoutineEntry> entries = {benchEntry()},
                     std::string id = "rt_00000001") {
  return Routine{rtId(std::move(id)), uid(), "Push A", 0, std::move(entries)};
}

// An in-memory gym store applying the SAME rules as the SQL; the six Fake…Repositories are its ports.
struct FakeGymStore {
  // gym_set_revisions: what a correction replaced and what a delete took out of the log.
  struct KeptSet {
    Set set;
    bool deleted;

    bool operator==(const KeptSet&) const = default;
  };

  std::vector<Exercise> seeds;
  std::vector<std::pair<std::string, Exercise>> customs;   // (owner, row)
  std::vector<Session> sessions;
  std::vector<Set> sets;              // one row per set that currently stands
  std::vector<KeptSet> kept;          // what corrections replaced, and what deletes took
  std::vector<Routine> routineRows;   // the stored rows; lastTrainedAtMs is derived on every read
  // gym_proposals + gym_proposal_changes as one value: the rows are one document (domain/Proposal.h).
  std::vector<RoutineProposal> proposalRows;
  std::vector<AskThread> threadRows;   // Ask's conversations; `minted` is derived on every read
  bool loseThreadRace = false;         // stage the concurrent-mint race `openThread` explains
  std::vector<SessionShare> shares;   // one per session at most, exactly as the primary key says
  std::vector<GymPreferences> preferenceRows;   // one per account at most, likewise
  std::vector<Note> noteRows;                   // gym_notes: dense on position per account
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
  std::uint64_t renames = 0;   // stands in for gym_exercise_aliases.created_at: rename order

  void seed(const Exercise& exercise) { seeds.push_back(exercise); }
  void seedCustom(const UserId& owner, const Exercise& exercise) {
    customs.push_back({owner.str(), exercise});
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

  std::optional<std::uint64_t> lastActivity(const SessionId& id) override {
    std::optional<std::uint64_t> last;
    for (const Set& set : db.sets) {
      if (!(set.session == id)) continue;
      if (!last || set.completedAtMs > *last) last = set.completedAtMs;
    }
    return last;
  }

  void insertSession(const Session& incoming) override {
    // routine_id is a real foreign key and is NOT owner-scoped: a broken pointer is a storage failure.
    bool plannedExists = !incoming.routine;
    for (const Routine& routine : db.routineRows)
      if (incoming.routine == routine.id) plannedExists = true;
    if (!plannedExists) throw std::runtime_error("no such routine");
    for (const Session& session : db.sessions)
      if (session.id == incoming.id) return;                              // the PK no-op
    for (const Session& session : db.sessions)
      if (session.user == incoming.user && !session.finishedAtMs) return; // one open per user
    db.sessions.push_back(incoming);
  }

  void close(const SessionId& id, std::uint64_t finishedAtMs, ClosedBy closedBy) override {
    // An open row takes the instant and the word; a stale close upgrades to a FINISH; nothing lands over a finish.
    for (Session& session : db.sessions) {
      if (!(session.id == id)) continue;
      if (!session.finishedAtMs) {
        session.finishedAtMs = finishedAtMs;
        session.closedBy = closedBy;
        continue;
      }
      if (session.closedBy == ClosedBy::stale && closedBy == ClosedBy::finish) {
        session.finishedAtMs = finishAfterStaleClose(session, finishedAtMs);
        session.closedBy = ClosedBy::finish;
      }
    }
  }

  SetInsertOutcome insertSet(const Set& incoming) override {
    // The lock statement READS the state it locks: whose session this is, and whether it is closed.
    std::optional<Session> ran;
    for (const Session& session : db.sessions)
      if (session.id == incoming.session) ran = session;
    if (!ran) return {std::nullopt, SetInsertError::idTaken};
    // The revisions read under the same lock: a DELETED id is spent for good, asked before the closed refusal.
    for (const FakeGymStore::KeptSet& row : db.kept) {
      if (!row.deleted || !(row.set.id == incoming.id)) continue;
      if (db.ownsSession(ran->user, row.set.session))
        return {std::nullopt, SetInsertError::deleted};
    }
    // The one door through the finished boundary: a set continuing a STALE close lands and moves the finish forward.
    const bool continuesStaleClose = ran->finishedAtMs && lateSetLands(*ran, incoming.completedAtMs);
    if (ran->finishedAtMs && !continuesStaleClose) return {std::nullopt, SetInsertError::finished};
    // Scoped on the SESSION's owner: a foreign key alone would admit another lifter's private movement.
    if (!db.visibleTo(ran->user, incoming.exercise))
      return {std::nullopt, SetInsertError::unknownExercise};
    // The read-back, scoped to (id, session_id) and taken last, as the statement order has it.
    for (const Set& set : db.sets) {
      if (!(set.id == incoming.id)) continue;
      if (set.session == incoming.session)
        return {set, SetInsertError::none};                // the PK no-op: replay returns stored
      return {std::nullopt, SetInsertError::idTaken};      // the id is spent outside this session
    }
    int number = 1;
    for (const Set& set : db.sets)
      if (set.session == incoming.session && set.exercise == incoming.exercise)
        number = std::max(number, set.setNumber + 1);
    Set stored = incoming;
    stored.setNumber = number;
    db.sets.push_back(stored);
    if (continuesStaleClose)
      for (Session& session : db.sessions)
        if (session.id == incoming.session)
          session.finishedAtMs = std::max(*session.finishedAtMs, incoming.completedAtMs);
    return {stored, SetInsertError::none};
  }

  // The correction, scoped (id, session, owner); what it replaces is kept BEFORE the row is rewritten.
  std::optional<Set> updateSet(const UserId& user, const Set& corrected) override {
    for (Set& set : db.sets) {
      if (!(set.id == corrected.id) || !(set.session == corrected.session)) continue;
      if (!db.ownsSession(user, set.session)) return std::nullopt;
      // Kept only where the row actually MOVES, the SQL's `IS DISTINCT FROM` guard: `{}` is a legal fix.
      if (!(set == corrected)) db.kept.push_back(FakeGymStore::KeptSet{set, false});
      set = corrected;
      return set;
    }
    return std::nullopt;
  }

  // The delete, same scope: the row moves whole into the kept list marked deleted, and numbers are left alone.
  void deleteSet(const UserId& user, const SessionId& session, const SetId& id) override {
    for (auto row = db.sets.begin(); row != db.sets.end(); ++row) {
      if (!(row->id == id) || !(row->session == session)) continue;
      if (!db.ownsSession(user, session)) return;
      db.kept.push_back(FakeGymStore::KeptSet{*row, true});
      db.sets.erase(row);
      return;
    }
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
    return {LastTime{*newest, newest->plan ? newest->plan->routineName : "", block},
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

  bool deleteSession(const UserId& user, const SessionId& id) override {
    for (auto row = db.sessions.begin(); row != db.sessions.end(); ++row) {
      if (!(row->id == id) || !(row->user == user)) continue;
      db.sessions.erase(row);
      // `on delete cascade`: the sets go with the session, and the revisions with them.
      std::erase_if(db.sets, [&](const Set& set) { return set.session == id; });
      std::erase_if(db.kept,
                    [&](const FakeGymStore::KeptSet& held) { return held.set.session == id; });
      return true;
    }
    return false;   // absent and another account's are the same fact
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

  // Every set this account holds, the OPEN session included; the catalog join is an INNER one.
  std::vector<ExportedSet> exportedSets(const UserId& user) override {
    std::vector<std::pair<Session, Set>> lived;
    for (const Set& set : db.sets)
      for (const Session& ran : db.sessions) {
        if (!(ran.id == set.session) || !(ran.user == user)) continue;
        lived.push_back({ran, set});
      }
    std::sort(lived.begin(), lived.end(), [](const auto& a, const auto& b) {
      return std::tuple(a.first.startedAtMs, a.first.id.str(), a.second.completedAtMs,
                        a.second.setNumber) <
             std::tuple(b.first.startedAtMs, b.first.id.str(), b.second.completedAtMs,
                        b.second.setNumber);
    });

    std::vector<ExportedSet> out;
    for (const auto& [ran, set] : lived) {
      std::optional<std::string> movement = db.nameOf(user, set.exercise);
      if (!movement) continue;
      out.push_back(ExportedSet{ran.id.str(),
                                isoUtc(ran.startedAtMs),
                                ran.finishedAtMs ? isoUtc(*ran.finishedAtMs) : "",
                                ran.plan ? ran.plan->routineName : "",
                                set.id.str(),
                                set.exercise.str(),
                                *movement,
                                std::to_string(set.setNumber),
                                scaled(set.weightKg, 2),
                                std::to_string(set.reps),
                                toString(set.kind),
                                set.rpe ? scaled(*set.rpe, 1) : "",
                                set.note,
                                isoUtc(set.completedAtMs)});
    }
    return out;
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
                             ran.plan ? ran.plan->routineName : "", std::move(block)};
      }
    }
    return std::nullopt;
  }

private:
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

  ExerciseInsertOutcome insertExercise(const UserId& owner, const Exercise& incoming) override {
    for (const Exercise& seed : db.seeds)
      if (seed.id == incoming.id) return {std::nullopt, ExerciseInsertError::idTaken};
    for (const auto& [heldBy, exercise] : db.customs) {
      if (!(exercise.id == incoming.id)) continue;
      if (heldBy == owner.str())
        return {exercise, ExerciseInsertError::none};      // the caller's own id: a replay
      return {std::nullopt, ExerciseInsertError::idTaken};
    }
    db.seedCustom(owner, incoming);
    return {incoming, ExerciseInsertError::none};
  }

  // A movement this account created renames in place; a SEED is global and takes a per-account name.
  // Renaming a seed back to its own name deletes that line rather than storing a copy.
  std::optional<Exercise> renameExercise(const UserId& user, const ExerciseId& id,
                                         const std::string& name) override {
    for (const Exercise& row : db.seeds) {
      if (!(row.id == id)) continue;
      const std::string was = *db.nameOf(user, id);
      const Exercise renamed{row.id, name, row.pattern, row.equipment, row.stepKg, row.custom};
      std::erase_if(db.displayNames, [&](const auto& held) {
        return held.first.first == user.str() && held.first.second == id.str();
      });
      if (renamed.name != row.name)
        db.displayNames.push_back({{user.str(), id.str()}, renamed.name});
      keepOldName(user, id, was, renamed.name);
      return Exercise{row.id,        *db.nameOf(user, id), row.pattern,
                      row.equipment, row.stepKg,        row.custom,
                      db.aliasesOf(user, id)};
    }
    for (auto& [owner, exercise] : db.customs) {
      if (!(exercise.id == id) || owner != user.str()) continue;
      const std::string was = exercise.name;
      exercise = Exercise{exercise.id,        name,           exercise.pattern,
                          exercise.equipment, exercise.stepKg, exercise.custom};
      keepOldName(user, id, was, exercise.name);
      return Exercise{exercise.id,        exercise.name, exercise.pattern,
                      exercise.equipment, exercise.stepKg, exercise.custom,
                      db.aliasesOf(user, id)};
    }
    return std::nullopt;   // absent and another account's are the one fact
  }

private:
  // The old name becomes one this account USED to use, the new one stops being one, newest kMaxAliases kept.
  void keepOldName(const UserId& user, const ExerciseId& id, const std::string& was,
                   const std::string& now) {
    if (was != now) {
      std::erase_if(db.aliasRows, [&](const FakeGymStore::Alias& held) {
        return held.user == user.str() && held.exercise == id.str() && held.name == was;
      });
      db.aliasRows.push_back(FakeGymStore::Alias{user.str(), id.str(), was, ++db.renames});
    }
    std::erase_if(db.aliasRows, [&](const FakeGymStore::Alias& held) {
      return held.user == user.str() && held.exercise == id.str() && held.name == now;
    });
    std::vector<std::string> kept = db.aliasesOf(user, id);
    if (kept.size() <= kMaxAliases) return;
    kept.resize(kMaxAliases);
    std::erase_if(db.aliasRows, [&](const FakeGymStore::Alias& held) {
      if (held.user != user.str() || held.exercise != id.str()) return false;
      return std::find(kept.begin(), kept.end(), held.name) == kept.end();
    });
  }
};

class FakeProgramRepository : public ProgramRepository {
public:
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

  // The creation row is written by the winner of the id and by nobody else (ON CONFLICT DO NOTHING).
  RoutineWriteOutcome insertRoutine(const Routine& incoming, std::optional<ProposalDoor> byAgent,
                                    std::uint64_t nowMs) override {
    for (const Routine& routine : db.routineRows) {
      if (!(routine.id == incoming.id)) continue;
      if (routine.user == incoming.user)
        return {db.readRoutine(routine), RoutineWriteError::none};   // the PK no-op: a replay reads back stored
      return {std::nullopt, RoutineWriteError::idTaken};   // the id is spent by an account we can't see
    }
    // Every line names a movement this account may see; one transaction, so a refused line leaves no row.
    for (const RoutineEntry& entry : incoming.entries)
      if (!db.visibleTo(incoming.user, entry.exercise))
        return {std::nullopt, RoutineWriteError::unknownExercise};
    db.routineRows.push_back(incoming);
    db.createdRoutines[incoming.id.str()] =
        FakeGymStore::Created{nowMs, byAgent, static_cast<int>(incoming.entries.size())};
    return {db.readRoutine(incoming), RoutineWriteError::none};
  }

  // A write moving the document or the NAME bumps the revision and supersedes every pending proposal on it.
  RoutineWriteOutcome replaceRoutine(const Routine& incoming, std::uint64_t nowMs,
                                     std::optional<int> expectedRevision) override {
    for (Routine& routine : db.routineRows) {
      if (!(routine.id == incoming.id) || !(routine.user == incoming.user)) continue;
      for (const RoutineEntry& entry : incoming.entries)
        if (!db.visibleTo(incoming.user, entry.exercise))
          return {std::nullopt, RoutineWriteError::unknownExercise};
      const bool moved =
          routine.name != incoming.name || !(routine.entries == incoming.entries);
      if (moved && expectedRevision && routine.revision != *expectedRevision)
        return {std::nullopt, RoutineWriteError::stale};
      routine = Routine{incoming.id,       incoming.user,           incoming.name,
                        incoming.position, incoming.entries,        incoming.lastTrainedAtMs,
                        moved ? routine.revision + 1 : routine.revision};
      if (moved) supersedeOnRoutine(incoming.user, incoming.id, ProposalId{}, nowMs);
      return {db.readRoutine(routine), RoutineWriteError::none};
    }
    return {std::nullopt, RoutineWriteError::notFound};   // absent and another's are one answer
  }

  bool deleteRoutine(const UserId& user, const RoutineId& id) override {
    for (auto row = db.routineRows.begin(); row != db.routineRows.end(); ++row) {
      if (!(row->id == id) || !(row->user == user)) continue;
      db.routineRows.erase(row);
      db.createdRoutines.erase(id.str());   // the row is gone, and its creation columns with it
      // `on delete set null`: the sessions keep their frozen snapshots and lose only the pointer.
      for (Session& session : db.sessions)
        if (session.routine == id) session.routine = std::nullopt;
      // `on delete cascade`: the proposals on a routine go with it, settled ones included.
      std::erase_if(db.proposalRows,
                    [&](const RoutineProposal& held) { return held.head.routine == id; });
      return true;
    }
    return false;
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

  // The mint's steps in the SQL's order: resolve the routine, answer a spent id, supersede the door's pending, then insert.
  ProposalMintOutcome insertProposal(const RoutineProposal& incoming) override {
    std::optional<Routine> base = routine(incoming.head.user, incoming.head.routine);
    if (!base) return {std::nullopt, ProposalMintError::unknownRoutine};
    for (const RoutineProposal& held : db.proposalRows) {
      if (!(held.head.id == incoming.head.id)) continue;
      if (!(held.head.user == incoming.head.user))
        return {std::nullopt, ProposalMintError::idTaken};
      if (isReplayOf(held, incoming))
        return {withLoggedSets(held, incoming.head.user), ProposalMintError::none};
      return {std::nullopt, ProposalMintError::idReused};
    }
    // Every line names a movement this account may see, refused HERE at the mint.
    for (const RoutineChange& change : incoming.changes)
      if (!db.visibleTo(incoming.head.user, change.exercise))
        return {std::nullopt, ProposalMintError::unknownExercise};
    supersedeFromDoor(incoming);
    db.proposalRows.push_back(incoming);
    return {withLoggedSets(incoming, incoming.head.user), ProposalMintError::none};
  }

  ProposalSettleOutcome applyRevision(const UserId& user, const ProposalId& id,
                                      const Routine& becomes, std::uint64_t nowMs) override {
    RoutineProposal* held = pendingOrSettled(user, id);
    if (!held) return {std::nullopt, std::nullopt, ProposalSettleError::notFound};
    std::optional<Routine> base = routine(user, held->head.routine);
    if (!base) return {std::nullopt, std::nullopt, ProposalSettleError::notFound};
    if (held->head.state == ProposalState::applied)
      return {withLoggedSets(*held, user), base, ProposalSettleError::none};   // the replayed tap
    if (held->head.state == ProposalState::dismissed)
      return {std::nullopt, std::nullopt, ProposalSettleError::settled};
    if (held->head.state == ProposalState::superseded)
      return {std::nullopt, std::nullopt, ProposalSettleError::superseded};
    if (base->revision != held->baseRevision) {
      held->head.state = ProposalState::superseded;
      held->head.settledAtMs = nowMs;
      return {std::nullopt, std::nullopt, ProposalSettleError::superseded};
    }

    for (Routine& row : db.routineRows) {
      if (!(row.id == becomes.id) || !(row.user == user)) continue;
      row = becomes;
    }
    held->head.state = ProposalState::applied;
    held->head.settledAtMs = nowMs;
    // The routine just moved, so every other proposal waiting on it is superseded.
    supersedeOnRoutine(user, becomes.id, id, nowMs);
    return {withLoggedSets(*held, user), routine(user, becomes.id), ProposalSettleError::none};
  }

  ProposalSettleOutcome applyRemoval(const UserId& user, const ProposalId& id,
                                     std::uint64_t nowMs) override {
    RoutineProposal* held = pendingOrSettled(user, id);
    if (!held) return {std::nullopt, std::nullopt, ProposalSettleError::notFound};
    std::optional<Routine> base = routine(user, held->head.routine);
    if (!base) return {std::nullopt, std::nullopt, ProposalSettleError::notFound};
    if (held->head.state == ProposalState::applied ||
        held->head.state == ProposalState::dismissed)
      return {std::nullopt, std::nullopt, ProposalSettleError::settled};
    if (held->head.state == ProposalState::superseded)
      return {std::nullopt, std::nullopt, ProposalSettleError::superseded};
    if (base->revision != held->baseRevision) {
      held->head.state = ProposalState::superseded;
      held->head.settledAtMs = nowMs;
      return {std::nullopt, std::nullopt, ProposalSettleError::superseded};
    }

    // Composed BEFORE the delete, because the delete cascades this very row away with the routine.
    RoutineProposal answer = withLoggedSets(*held, user);
    answer.head.state = ProposalState::applied;
    answer.head.settledAtMs = nowMs;
    deleteRoutine(user, base->id);
    return {answer, std::nullopt, ProposalSettleError::none};
  }

  ProposalSettleOutcome dismissProposal(const UserId& user, const ProposalId& id,
                                        std::uint64_t nowMs) override {
    RoutineProposal* held = pendingOrSettled(user, id);
    if (!held) return {std::nullopt, std::nullopt, ProposalSettleError::notFound};
    if (held->head.state == ProposalState::applied)
      return {std::nullopt, std::nullopt, ProposalSettleError::settled};
    if (held->head.state == ProposalState::superseded)
      return {std::nullopt, std::nullopt, ProposalSettleError::superseded};
    if (held->head.state == ProposalState::pending) {
      held->head.state = ProposalState::dismissed;
      held->head.settledAtMs = nowMs;
    }
    return {withLoggedSets(*held, user), std::nullopt, ProposalSettleError::none};
  }

private:
  // The stored row itself, so a settle can move it. Owner-scoped like every read here.
  RoutineProposal* pendingOrSettled(const UserId& user, const ProposalId& id) {
    for (RoutineProposal& held : db.proposalRows)
      if (held.head.id == id && held.head.user == user) return &held;
    return nullptr;
  }

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

  // What every pending proposal on a routine becomes when that routine MOVES — every door's, and not a delete.
  void supersedeOnRoutine(const UserId& user, const RoutineId& routine, const ProposalId& except,
                          std::uint64_t nowMs) {
    for (RoutineProposal& held : db.proposalRows) {
      if (!(held.head.user == user) || !(held.head.routine == routine)) continue;
      if (held.head.state != ProposalState::pending || held.head.id == except) continue;
      held.head.state = ProposalState::superseded;
      held.head.settledAtMs = nowMs;
    }
  }

  // The partial unique index's rule: one pending proposal per (routine, door, connection).
  void supersedeFromDoor(const RoutineProposal& incoming) {
    for (RoutineProposal& held : db.proposalRows) {
      if (!(held.head.user == incoming.head.user) ||
          !(held.head.routine == incoming.head.routine))
        continue;
      if (held.head.state != ProposalState::pending || held.head.id == incoming.head.id) continue;
      // Keyed on (routine, door, connection), not the whole source.
      if (held.head.source.door != incoming.head.source.door ||
          held.head.source.connection != incoming.head.source.connection)
        continue;
      held.head.state = ProposalState::superseded;
      held.head.settledAtMs = incoming.head.createdAtMs;
    }
  }
};

class FakeAskThreadRepository : public AskThreadRepository {
public:
  explicit FakeAskThreadRepository(FakeGymStore& db) : db(db) {}

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

  // The archive's read: every row, no ceiling, oldest first.
  std::vector<AskThread> allThreads(const UserId& user) override {
    std::vector<AskThread> out;
    for (const AskThread& held : db.threadRows)
      if (held.user == user) out.push_back(withMinted(held, false));
    std::sort(out.begin(), out.end(), [](const AskThread& a, const AskThread& b) {
      return std::pair(a.createdAtMs, a.id.str()) < std::pair(b.createdAtMs, b.id.str());
    });
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
      for (const ThreadTurn& turn : turns) held.turns.push_back(turn);
      if (!turns.empty()) held.askedAtMs = turns.back().atMs;
      return;
    }
  }

  void discardEmptyThread(const UserId& user, const ThreadId& id) override {
    std::erase_if(db.threadRows, [&](const AskThread& held) {
      return held.id == id && held.user == user && held.turns.empty();
    });
  }

  bool deleteThread(const UserId& user, const ThreadId& id) override {
    const std::size_t before = db.threadRows.size();
    std::erase_if(db.threadRows,
                  [&](const AskThread& held) { return held.id == id && held.user == user; });
    if (db.threadRows.size() == before) return false;
    // `on delete set null`: every proposal the conversation minted keeps its row and loses only the link.
    for (RoutineProposal& held : db.proposalRows)
      if (held.head.source.thread == id) held.head.source.thread.reset();
    return true;
  }

  std::vector<ExportedThreadTurn> exportedThreadTurns(const UserId& user) override {
    std::vector<AskThread> held;
    for (const AskThread& row : db.threadRows)
      if (row.user == user) held.push_back(row);
    std::sort(held.begin(), held.end(), [](const AskThread& a, const AskThread& b) {
      return std::pair(a.createdAtMs, a.id.str()) < std::pair(b.createdAtMs, b.id.str());
    });
    std::vector<ExportedThreadTurn> out;
    for (const AskThread& row : held) {
      // A thread that holds no turns is still a row, with the turn columns empty (the store's LEFT JOIN).
      if (row.turns.empty()) {
        out.push_back(ExportedThreadTurn{row.id.str(), row.title, "", "", "",
                                         isoUtc(row.createdAtMs), "", "", "", ""});
        continue;
      }
      int position = 0;
      for (const ThreadTurn& turn : row.turns) {
        ++position;
        // The outcome columns come back EMPTY: ThreadService stamps that ladder on.
        out.push_back(ExportedThreadTurn{row.id.str(), row.title, "", "", "",
                                         isoUtc(row.createdAtMs), std::to_string(position),
                                         turn.fromLifter ? "lifter" : "coach", turn.text,
                                         isoUtc(turn.atMs)});
      }
    }
    return out;
  }

private:
  // What this conversation minted, in mint order, each carrying the routine's name AS IT NOW STANDS.
  AskThread withMinted(const AskThread& held, bool withTurns) const {
    AskThread out = held;
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

  GymPreferences savePreferences(const GymPreferences& incoming) override {
    for (GymPreferences& row : db.preferenceRows) {
      if (!(row.user == incoming.user)) continue;
      row = incoming;
      return row;
    }
    db.preferenceRows.push_back(incoming);
    return incoming;
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

  // The store's steps in the SQL's order: the id asked globally, a replay read back untouched, an
  // edit stamped, else the cap and an append at position n.
  NoteWriteOutcome saveNote(const Note& incoming, std::uint64_t nowMs) override {
    for (Note& held : db.noteRows) {
      if (!(held.id == incoming.id)) continue;
      if (!(held.user == incoming.user)) return {std::nullopt, NoteWriteError::idTaken};
      if (held.title == incoming.title && held.body == incoming.body)
        return {held, NoteWriteError::none};
      held = Note{held.id, held.user, incoming.title, incoming.body, held.position, nowMs};
      return {held, NoteWriteError::none};
    }
    const std::vector<Note> standing = notes(incoming.user);
    if (standing.size() >= kMaxNotes) return {std::nullopt, NoteWriteError::full};
    db.noteRows.push_back(Note{incoming.id, incoming.user, incoming.title, incoming.body,
                               static_cast<int>(standing.size()), nowMs});
    return {db.noteRows.back(), NoteWriteError::none};
  }

  // Absent and another account's are one no-op; the rows after the gap move up one.
  void deleteNote(const UserId& user, const NoteId& id) override {
    for (auto row = db.noteRows.begin(); row != db.noteRows.end(); ++row) {
      if (!(row->id == id) || !(row->user == user)) continue;
      const int gap = row->position;
      db.noteRows.erase(row);
      for (Note& held : db.noteRows)
        if (held.user == user && held.position > gap) --held.position;
      return;
    }
  }

  // Precedence is not the note's text: `updatedAtMs` stays where it was.
  NotesOrderOutcome reorderNotes(const UserId& user, const std::vector<NoteId>& order) override {
    if (!namesEveryNoteOnce(notes(user), order)) return {{}, NotesOrderError::mismatch};
    for (Note& held : db.noteRows) {
      if (!(held.user == user)) continue;
      held.position =
          static_cast<int>(std::find(order.begin(), order.end(), held.id) - order.begin());
    }
    return {notes(user), NotesOrderError::none};
  }

  std::vector<ExportedNote> exportedNotes(const UserId& user) override {
    std::vector<ExportedNote> out;
    for (const Note& note : notes(user))
      out.push_back(ExportedNote{std::to_string(note.position), note.title, note.body,
                                 isoUtc(note.updatedAtMs)});
    return out;
  }
};

// The whole store and its six doors, in the shape a harness holds them.
struct FakeGym {
  FakeGymStore db;
  FakeLogRepository log{db};
  FakeCatalogRepository catalog{db};
  FakeProgramRepository program{db};
  FakeAskThreadRepository threads{db};
  FakePreferencesRepository preferences{db};
  FakeNotesRepository notes{db};
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

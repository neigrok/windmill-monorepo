#pragma once

#include "products/gym/ports/TrainingRepository.h"

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

// The export's three renderings, which the SQL does with `to_char(… AT TIME ZONE 'UTC')` and two
// `::text` casts off numeric columns of a fixed scale. They are mirrored here rather than
// approximated, because a fake that framed a cell differently from the live store would let a
// column drift with every test still green — and PgTrainingRepositoryTest pins the two together by
// asserting these exact strings against a real Postgres.
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

// Monday 00:00 UTC, which is what `date_trunc('week', ts AT TIME ZONE 'UTC')` answers. The epoch
// itself was a Thursday, so the walk is shifted three days before it is floored and shifted back —
// and the result is clamped exactly as the adapter's instantFrom clamps it, so the first week of
// 1970 cannot come back as a negative instant on either side.
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

// An in-memory TrainingRepository that applies the SAME rules as the SQL — the PK no-op on a
// duplicate id, the one-open-session refusal that makes a second insert a no-op, max+1-per-
// exercise numbering, the owner scope on every read, the read-back scoped to the session (a set id
// spent elsewhere resolves to NOTHING, never to that row), the revisions read that makes a DELETED
// id spent for good so a replayed append cannot resurrect it, the copy taken only where a correction
// actually moves the row, the owner-scoped predicate that refuses a
// set or a routine entry naming a movement this account cannot see, the closed session that refuses
// a set which never landed, the routine name read off the session's own frozen snapshot, the
// derived last-trained instant the routines list sorts on, the cascade that nulls a deleted
// routine's id on every session that ran it, the cascade that takes a discarded session's sets with
// it, the (startedAt, id) window that keeps a session out of its own history, and the IS NULL guard
// that makes close first-writer-wins. Lift's proposal-apply bug survived precisely as long as its
// mock didn't model the persistence boundary, so this fidelity is an architecture requirement: the
// service tests can never quietly disagree with the adapter about what a replay returns — and a
// fake that mirrors a leak hides it behind green.
class FakeTrainingRepository : public TrainingRepository {
public:
  // gym_set_revisions: what a correction replaced, and what a delete took out of the log. The
  // product reads it NOWHERE — there is no trash and no recovery door — so it is here for the one
  // thing that must be provable: a test can assert that nothing a lifter logged was destroyed.
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
  std::vector<SessionShare> shares;   // one per session at most, exactly as the primary key says
  // gym_exercise_names: what one account calls one SEED. Keyed (owner, movement) like the table's
  // own primary key, and every read of a display name coalesces it over the seed's — a fake that
  // resolved names off the catalog row alone would let the global-rename hazard ship behind green.
  std::vector<std::pair<std::pair<std::string, std::string>, std::string>> displayNames;

  void seed(const Exercise& exercise) { seeds.push_back(exercise); }
  void seedCustom(const UserId& owner, const Exercise& exercise) {
    customs.push_back({owner.str(), exercise});
  }

  // Seeds under the name THIS account calls them, then the account's own movements — and the sort
  // is on the resolved name, exactly as the SQL orders by the coalesce rather than by the column.
  std::vector<Exercise> catalog(const UserId& user) override {
    std::vector<Exercise> out;
    for (const Exercise& row : seeds)
      out.push_back(Exercise{row.id, *nameOf(user, row.id), row.pattern, row.equipment, row.stepKg,
                             row.custom});
    for (const auto& [owner, exercise] : customs)
      if (owner == user.str()) out.push_back(exercise);
    std::sort(out.begin(), out.end(), [](const Exercise& a, const Exercise& b) {
      return std::pair(toString(a.pattern), a.name) < std::pair(toString(b.pattern), b.name);
    });
    return out;
  }

  std::optional<Session> open(const UserId& user) override {
    for (const Session& session : sessions)
      if (session.user == user && !session.finishedAtMs) return session;
    return std::nullopt;
  }

  std::optional<Session> session(const UserId& user, const SessionId& id) override {
    for (const Session& session : sessions)
      if (session.user == user && session.id == id) return session;
    return std::nullopt;
  }

  std::optional<Set> setOf(const UserId& user, const SetId& id) override {
    for (const Set& set : sets) {
      if (!(set.id == id)) continue;
      for (const Session& session : sessions)
        if (session.id == set.session && session.user == user) return set;
      return std::nullopt;   // another account's set is the same fact as no set at all
    }
    return std::nullopt;
  }

  std::optional<std::uint64_t> lastActivity(const SessionId& id) override {
    std::optional<std::uint64_t> last;
    for (const Set& set : sets) {
      if (!(set.session == id)) continue;
      if (!last || set.completedAtMs > *last) last = set.completedAtMs;
    }
    return last;
  }

  void insertSession(const Session& incoming) override {
    // routine_id is a real foreign key, and it is NOT owner-scoped: a session may point only at a
    // routine that exists, and a broken pointer is a storage failure rather than a refusal — the
    // service loads the routine, owner-scoped, before it ever builds this row.
    bool plannedExists = !incoming.routine;
    for (const Routine& routine : routineRows)
      if (incoming.routine == routine.id) plannedExists = true;
    if (!plannedExists) throw std::runtime_error("no such routine");
    for (const Session& session : sessions)
      if (session.id == incoming.id) return;                              // the PK no-op
    for (const Session& session : sessions)
      if (session.user == incoming.user && !session.finishedAtMs) return; // one open per user
    sessions.push_back(incoming);
  }

  void close(const SessionId& id, std::uint64_t finishedAtMs) override {
    for (Session& session : sessions)
      if (session.id == id && !session.finishedAtMs) session.finishedAtMs = finishedAtMs;
  }

  SetInsertOutcome insertSet(const Set& incoming) override {
    // The lock statement, which READS the state it locks: whose session this is and whether it has
    // already been closed. Both refusals come off it before anything is written, exactly as they do
    // in the SQL. Without a session row the real INSERT..SELECT selects nothing, so nothing lands
    // and the read-back finds nothing — the same answer as a spent id, and LogService loads the
    // session before it ever gets here. A CLOSED one refuses outright: a set that never landed may
    // not land after the finish, and only the locked row can say so without a race.
    std::optional<Session> ran;
    for (const Session& session : sessions)
      if (session.id == incoming.session) ran = session;
    if (!ran) return {std::nullopt, SetInsertError::idTaken};
    // The revisions read, under the same lock and in the same place the SQL asks it: an id this
    // account holds as DELETED is spent for good, so a replayed append cannot hand back a set the
    // lifter took out of the log. Asked before the closed-session refusal, exactly as the SQL asks
    // it, so the two implementations answer a deleted set in a finished workout with the same word.
    for (const KeptSet& row : kept) {
      if (!row.deleted || !(row.set.id == incoming.id)) continue;
      if (ownsSession(ran->user, row.set.session)) return {std::nullopt, SetInsertError::deleted};
    }
    if (ran->finishedAtMs) return {std::nullopt, SetInsertError::finished};
    // Scoped on the SESSION's owner, the way the write is scoped in SQL. A foreign key alone would
    // admit another lifter's private movement, and their movement name would then be printed by
    // this account's log, its export and its coach share.
    if (!visibleTo(ran->user, incoming.exercise))
      return {std::nullopt, SetInsertError::unknownExercise};
    // The read-back, scoped to (id, session_id) and taken last, as the statement order has it.
    for (const Set& set : sets) {
      if (!(set.id == incoming.id)) continue;
      if (set.session == incoming.session)
        return {set, SetInsertError::none};                // the PK no-op: replay returns stored
      return {std::nullopt, SetInsertError::idTaken};      // the id is spent outside this session
    }
    int number = 1;
    for (const Set& set : sets)
      if (set.session == incoming.session && set.exercise == incoming.exercise)
        number = std::max(number, set.setNumber + 1);
    Set stored = incoming;
    stored.setNumber = number;
    sets.push_back(stored);
    return {stored, SetInsertError::none};
  }

  // The correction, scoped (id, session, owner) exactly as the SQL's two statements are: a set id
  // that resolves under this account but in another workout is not this session's to correct, and
  // another account's is not there at all. What it replaces is kept BEFORE the row is rewritten —
  // a fake that skipped that would let the whole promise of §1 ship behind green.
  std::optional<Set> updateSet(const UserId& user, const Set& corrected) override {
    for (Set& set : sets) {
      if (!(set.id == corrected.id) || !(set.session == corrected.session)) continue;
      if (!ownsSession(user, set.session)) return std::nullopt;
      // Kept only where the row actually MOVES, the SQL's own `IS DISTINCT FROM` guard: `{}` is a
      // legal fix and a resent one is what a client does with a lost reply, so an unconditional copy
      // grows a version per retry standing for a change nobody made.
      if (!(set == corrected)) kept.push_back(KeptSet{set, false});
      set = corrected;
      return set;
    }
    return std::nullopt;
  }

  // The delete, and the same scope. The row moves whole into the kept list marked deleted — it is
  // never simply dropped — and nothing is answered, because a set that was never here does not stand
  // either. Set numbers are left alone: the SQL closes no gaps and neither does this.
  void deleteSet(const UserId& user, const SessionId& session, const SetId& id) override {
    for (auto row = sets.begin(); row != sets.end(); ++row) {
      if (!(row->id == id) || !(row->session == session)) continue;
      if (!ownsSession(user, session)) return;
      kept.push_back(KeptSet{*row, true});
      sets.erase(row);
      return;
    }
  }

  LogPage log(const UserId& user, const LogCursor& cursor) override {
    // The same unique sort key the SQL uses: (startedAt, id) descending, the whole pair compared
    // against the whole cursor, so a tie at a page edge cannot swallow a session.
    const std::string beforeId = cursor.beforeId ? cursor.beforeId->str() : "";
    std::vector<Session> page;
    for (const Session& session : sessions) {
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
      for (const Set& set : sets) {
        if (!(set.session == session.id)) continue;
        ++count;
        if (std::optional<std::string> name = nameOf(user, set.exercise)) names.insert(*name);
        if (!lastSetAtMs || set.completedAtMs > *lastSetAtMs) lastSetAtMs = set.completedAtMs;
        held.push_back(set);
        if (set.kind != SetKind::working) continue;
        ++working;
        // The aggregate's `greatest(weight_kg, 0) * reps`: an assisted set logs a negative load and
        // moved no external weight, so it adds nothing rather than subtracting.
        tonnage += std::max(set.weightKg, 0.0) * set.reps;
        // The lateral's ORDER BY weight_kg DESC, reps DESC over the WORKING sets, and the same rule
        // stated once in TopWorkingSet: heaviest, ties to more reps, never volume.
        if (top && std::pair(set.weightKg, set.reps) <= std::pair(top->weightKg, top->reps))
          continue;
        top = TopWorkingSet{set.weightKg, set.reps};
      }
      // The marks statement: the domain's own projection of this session's working sets, ordered
      // the way `DISTINCT ON (session, movement, load) … ORDER BY movement, load DESC` hands them
      // back. It goes through marksOf rather than being re-derived here, because a fake that made
      // the projection its own way could agree with the rule while disagreeing with the store.
      // Then dated by the SESSION, which is what every mark a STORE hands over carries
      // (domain/Review.h) — marksOf dates by the set because it is used where a session's own sets
      // are in hand, and a fake that skipped this would hand back a vector the SQL never would.
      std::vector<PriorMark> marks = ordered(marksOf(held));
      for (PriorMark& one : marks) one.atMs = session.startedAtMs;
      // The SQL's `finished_at = coalesce(max(completed_at), started_at)`: the four-hour rule's own
      // signature, inferred rather than stored, for the reason SessionSummary spells out.
      const bool closedItself = session.finishedAtMs &&
                                *session.finishedAtMs == lastSetAtMs.value_or(session.startedAtMs);
      out.sessions.push_back(SessionSummary{session, count, working, tonnage,
                                            std::vector<std::string>(names.begin(), names.end()),
                                            top, std::move(marks), closedItself});
    }
    if (out.sessions.empty()) return out;

    // The standing statement: the same projection over this account's FINISHED sessions strictly
    // older than the page's last row, narrowed to the movements the page trains. The window is the
    // pair (startedAt, id), the unique key every read here compares on. Each set is carried over
    // stamped with its SESSION's start, so folding them gives the mark the SQL's DISTINCT ON keeps
    // — the best reps, dated by the earliest workout that hit them.
    const Session& oldest = out.sessions.back().session;
    std::vector<Set> before;
    for (const Set& prior : sets) {
      if (prior.kind != SetKind::working) continue;
      bool onPage = false;
      for (const SessionSummary& row : out.sessions)
        for (const PriorMark& mark : row.workingMarks)
          if (mark.exercise == prior.exercise) onPage = true;
      if (!onPage) continue;
      for (const Session& ran : sessions) {
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
    for (const Set& set : sets)
      if (set.session == id) out.push_back(set);
    std::sort(out.begin(), out.end(), [](const Set& a, const Set& b) {
      return std::pair(a.completedAtMs, a.setNumber) < std::pair(b.completedAtMs, b.setNumber);
    });
    return out;
  }

  // The same walk the SQL does: this account's finished sessions newest first on (startedAt, id),
  // stopping at the first that holds a non-warmup set of the movement. The open session is stepped
  // over — today's sets are today's, not last time — and another account's is invisible, so nothing
  // here can answer with a session the caller may not read.
  LastTimeOutcome lastTime(const UserId& user, const ExerciseId& exercise) override {
    std::optional<Session> newest;
    for (const Session& session : sessions) {
      if (!(session.user == user) || !session.finishedAtMs) continue;
      if (newest && std::pair(session.startedAtMs, session.id.str()) <
                        std::pair(newest->startedAtMs, newest->id.str()))
        continue;
      for (const Set& set : sets) {
        if (!(set.session == session.id) || !(set.exercise == exercise)) continue;
        if (set.kind == SetKind::warmup) continue;
        newest = session;
        break;
      }
    }
    if (!newest) {
      // Scoped exactly like the catalog read the adapter checks against: another account's custom
      // movement is unknown here, never merely unlogged.
      for (const Exercise& known : catalog(user))
        if (known.id == exercise) return {std::nullopt, LastTimeError::none};
      return {std::nullopt, LastTimeError::unknownExercise};
    }
    std::vector<Set> block;
    for (const Set& set : sets)
      if (set.session == newest->id && set.exercise == exercise && set.kind != SetKind::warmup)
        block.push_back(set);
    std::sort(block.begin(), block.end(),
              [](const Set& a, const Set& b) { return a.setNumber < b.setNumber; });
    // The name comes off the session's own frozen snapshot — never off a side map a test author
    // fills in, which is how a fake comes to agree with an answer the real store cannot produce.
    // The snapshot is typed now, so "the name is a string or there is no name" is a fact of the
    // type; what the adapter's `jsonb_typeof(plan->'routine') = 'string'` guard still defends
    // against is a raw blob no writer of ours can lay down (PgTrainingRepositoryTest pins that).
    return {LastTime{*newest, newest->plan ? newest->plan->routineName : "", block},
            LastTimeError::none};
  }

  // The same three answers the SQL gives, under the same rules. The marks are DISTINCT ON in a
  // vector: the qualifying prior working sets ordered by (movement, load, most reps, earliest
  // instant), keeping the first of each pair — so a mark carries the best reps ever done at that
  // load and is dated the day they were first hit. Both windows compare the PAIR (startedAt, id),
  // which is what keeps this session out of its own history: without it a review re-read after the
  // finish would find every set tying itself and would report no record at all.
  SessionHistory historyFor(const UserId& user, const Session& session) override {
    SessionHistory history;
    std::vector<Set> priorWorking;
    for (const Set& prior : sets) {
      if (prior.kind != SetKind::working) continue;
      std::optional<Session> ranIn;
      for (const Session& ran : sessions) {
        if (!(ran.id == prior.session) || !(ran.user == user) || !ran.finishedAtMs) continue;
        if (std::pair(ran.startedAtMs, ran.id.str()) <
            std::pair(session.startedAtMs, session.id.str()))
          ranIn = ran;
      }
      if (!ranIn) continue;
      bool workedToday = false;
      for (const Set& today : sets)
        if (today.session == session.id && today.exercise == prior.exercise &&
            today.kind == SetKind::working)
          workedToday = true;
      if (!workedToday) continue;
      // Carried over stamped with its SESSION's start: a mark the store hands back is dated by the
      // workout that set it, so the fold below dates it by the earliest workout to hit those reps.
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
    for (const Session& ran : sessions) {
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
    for (auto row = sessions.begin(); row != sessions.end(); ++row) {
      if (!(row->id == id) || !(row->user == user)) continue;
      sessions.erase(row);
      // `on delete cascade`: the sets go with the session, so nothing is left pointing at a row
      // that is gone — and a fake that kept them would hide exactly that leak behind green. The
      // revisions cascade too, which is what keeps a discard's own promise true: it is permanent,
      // and nothing keeps a copy of a workout that was thrown away.
      std::erase_if(sets, [&](const Set& set) { return set.session == id; });
      std::erase_if(kept, [&](const KeptSet& held) { return held.set.session == id; });
      return true;
    }
    return false;   // absent and another account's are the same fact
  }

  std::vector<Routine> routines(const UserId& user) override {
    std::vector<Routine> out;
    for (const Routine& routine : routineRows)
      if (routine.user == user) out.push_back(read(routine));
    // The routines screen's order, and the SQL's: most recently trained first, the never-trained
    // after them rather than above them, ties broken by (position, id) so the walk is deterministic.
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
    for (const Routine& routine : routineRows)
      if (routine.user == user && routine.id == id) return read(routine);
    return std::nullopt;   // another account's routine is the same fact as no routine at all
  }

  RoutineWriteOutcome insertRoutine(const Routine& incoming) override {
    for (const Routine& routine : routineRows) {
      if (!(routine.id == incoming.id)) continue;
      if (routine.user == incoming.user)
        return {read(routine), RoutineWriteError::none};   // the PK no-op: a replay reads back stored
      return {std::nullopt, RoutineWriteError::idTaken};   // the id is spent by an account we can't see
    }
    // Every line names a movement this account may see, under the write's own scope rather than the
    // foreign key's — another lifter's private movement is unknown here, not merely someone else's.
    // The whole document is one transaction there, so a refused line leaves NO row behind.
    for (const RoutineEntry& entry : incoming.entries)
      if (!visibleTo(incoming.user, entry.exercise))
        return {std::nullopt, RoutineWriteError::unknownExercise};
    routineRows.push_back(incoming);
    return {read(incoming), RoutineWriteError::none};
  }

  RoutineWriteOutcome replaceRoutine(const Routine& incoming) override {
    for (Routine& routine : routineRows) {
      if (!(routine.id == incoming.id) || !(routine.user == incoming.user)) continue;
      for (const RoutineEntry& entry : incoming.entries)
        if (!visibleTo(incoming.user, entry.exercise))
          return {std::nullopt, RoutineWriteError::unknownExercise};
      routine = incoming;
      return {read(routine), RoutineWriteError::none};
    }
    return {std::nullopt, RoutineWriteError::notFound};   // absent and another's are one answer
  }

  bool deleteRoutine(const UserId& user, const RoutineId& id) override {
    for (auto row = routineRows.begin(); row != routineRows.end(); ++row) {
      if (!(row->id == id) || !(row->user == user)) continue;
      routineRows.erase(row);
      // `on delete set null`: the sessions trained under it keep their frozen snapshots and lose
      // only the pointer, so the log still says which day of the program each one was.
      for (Session& session : sessions)
        if (session.routine == id) session.routine = std::nullopt;
      return true;
    }
    return false;
  }

  ExerciseInsertOutcome insertExercise(const UserId& owner, const Exercise& incoming) override {
    for (const Exercise& seed : seeds)
      if (seed.id == incoming.id) return {std::nullopt, ExerciseInsertError::idTaken};
    for (const auto& [heldBy, exercise] : customs) {
      if (!(exercise.id == incoming.id)) continue;
      if (heldBy == owner.str())
        return {exercise, ExerciseInsertError::none};      // the caller's own id: a replay
      return {std::nullopt, ExerciseInsertError::idTaken};
    }
    seedCustom(owner, incoming);
    return {incoming, ExerciseInsertError::none};
  }

  // The rename, under the SAME split the SQL makes and for the same reason: a movement this account
  // created is its own row and renames in place, a SEED is a global row shared by every account on
  // the server and takes a per-account display name instead. Renaming a seed back to its own name
  // deletes that line rather than storing a copy of it. The renamed entity is CONSTRUCTED before
  // either write, so a name the store could not hold is refused before anything moves — a fake that
  // skipped the construction would let an unstorable name pass every service test.
  std::optional<Exercise> renameExercise(const UserId& user, const ExerciseId& id,
                                         const std::string& name) override {
    for (const Exercise& row : seeds) {
      if (!(row.id == id)) continue;
      const Exercise renamed{row.id, name, row.pattern, row.equipment, row.stepKg, row.custom};
      std::erase_if(displayNames, [&](const auto& held) {
        return held.first.first == user.str() && held.first.second == id.str();
      });
      if (renamed.name != row.name) displayNames.push_back({{user.str(), id.str()}, renamed.name});
      return Exercise{row.id, *nameOf(user, id), row.pattern, row.equipment, row.stepKg, row.custom};
    }
    for (auto& [owner, exercise] : customs) {
      if (!(exercise.id == id) || owner != user.str()) continue;
      exercise = Exercise{exercise.id,        name,           exercise.pattern,
                          exercise.equipment, exercise.stepKg, exercise.custom};
      return exercise;
    }
    return std::nullopt;   // absent and another account's are the one fact
  }

  // The record read: the catalog's own predicate first — no row means this account holds no such
  // movement and nothing else is loaded — then the routines that name it, then one ladder per
  // FINISHED session oldest first, then the last kRecentDays days of non-warmup sets. Every number
  // the page prints is computed from these by the pure rule; nothing here estimates anything.
  MovementHistory movementHistory(const UserId& user, const ExerciseId& exercise) override {
    MovementHistory history;
    for (const Exercise& known : catalog(user))
      if (known.id == exercise) history.exercise = known;
    if (!history.exercise) return history;

    for (const Routine& routine : routineRows) {
      if (!(routine.user == user)) continue;
      for (const RoutineEntry& entry : routine.entries)
        if (entry.exercise == exercise) {
          ++history.routines;   // DISTINCT: a routine naming it twice is still one routine
          break;
        }
    }

    std::vector<Session> ran;
    for (const Session& session : sessions)
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

  // The same three answers the SQL gives. The series is `DISTINCT ON (movement, session)` keeping
  // the heaviest set with the most reps and then the earliest — TopSet's rule, made by the store
  // because it is an ordering — and every point carries the SESSION's start, never a set's device
  // stamp. The marks are historyFor's projection with both of its windows removed. The weeks are
  // Monday-to-Monday in UTC and CONTIGUOUS: generate_series fills the gaps there, so a week nobody
  // trained is a zero here rather than a row that is simply missing. No e1RM is computed anywhere
  // in this method, because none is computed anywhere in the query it mirrors.
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
    for (const Session& ran : sessions) {
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

  // Every set this account holds, the OPEN session included, in the order the workouts were lived.
  // The join onto the catalog is an INNER one in the SQL, so a set naming a movement no catalog
  // holds is not in the file at all — it cannot exist behind the foreign key, and a fake that
  // emitted it with a blank name would be inventing a row the live store cannot produce.
  std::vector<ExportedSet> exportedSets(const UserId& user) override {
    std::vector<std::pair<Session, Set>> lived;
    for (const Set& set : sets)
      for (const Session& ran : sessions) {
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
      std::optional<std::string> movement = nameOf(user, set.exercise);
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

  // The INSERT..SELECT off the caller's own session row: a session that is absent or another
  // account's selects nothing, so nothing lands, nothing conflicts, and the owner-scoped read-back
  // finds nothing — one answer for all three, and no branch here that could be got wrong. The
  // conflict is on the SESSION, so a live share answers with itself (the mint is idempotent) while
  // one that has already ended is replaced, which is the DO UPDATE's guard exactly.
  std::optional<SessionShare> insertShare(const SessionShare& incoming,
                                          std::uint64_t nowMs) override {
    bool owned = false;
    for (const Session& ran : sessions)
      if (ran.id == incoming.session && ran.user == incoming.user) owned = true;
    if (!owned) return std::nullopt;
    for (SessionShare& held : shares) {
      if (!(held.session == incoming.session)) continue;
      if (held.expiresAtMs > nowMs) return held;
      held = incoming;
      return held;
    }
    shares.push_back(incoming);
    return incoming;
  }

  bool revokeShare(const UserId& user, const SessionId& id) override {
    for (auto row = shares.begin(); row != shares.end(); ++row) {
      if (!(row->session == id) || !(row->user == user)) continue;
      shares.erase(row);
      return true;
    }
    return false;   // absent and another account's are the same fact here too
  }

  // Revoked (no row), expired (a row the predicate rejects) and never-minted (no row) leave this
  // with nothing to return — one value, so nothing above can tell them apart. The sets carry their
  // movement's display name and no id at all, and the routine name comes off the session's own
  // frozen snapshot rather than off a routine as it is called today.
  std::optional<SharedSession> sharedSession(const std::string& token,
                                             std::uint64_t nowMs) override {
    for (const SessionShare& held : shares) {
      if (held.token != token || held.expiresAtMs <= nowMs) continue;
      for (const Session& ran : sessions) {
        if (!(ran.id == held.session)) continue;
        std::vector<SharedSet> block;
        for (const Set& set : setsOf(ran.id)) {
          std::optional<std::string> movement = nameOf(ran.user, set.exercise);
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
  // The join both statistics projections are taken over: this account's working sets, in its
  // FINISHED sessions only, each carrying the session it was lived in. An open workout is today's
  // screen and not history — the same reason lastTime and historyFor step over it.
  std::vector<std::pair<Session, Set>> workingSetsOfFinished(const UserId& user) const {
    std::vector<std::pair<Session, Set>> lived;
    for (const Set& set : sets) {
      if (set.kind != SetKind::working) continue;
      for (const Session& ran : sessions) {
        if (!(ran.id == set.session) || !(ran.user == user) || !ran.finishedAtMs) continue;
        lived.push_back({ran, set});
      }
    }
    return lived;
  }

  // Every routine read carries the store's derived answer, never the value a caller happened to
  // construct with: the newest session this account started under it, which is what the list sorts
  // on and what the routines screen prints as "trained {when}".
  Routine read(const Routine& stored) const {
    std::optional<std::uint64_t> lastTrained;
    for (const Session& session : sessions) {
      if (!(session.user == stored.user) || session.routine != stored.id) continue;
      if (!lastTrained || session.startedAtMs > *lastTrained) lastTrained = session.startedAtMs;
    }
    return Routine{stored.id, stored.user, stored.name, stored.position, stored.entries,
                   lastTrained};
  }

  // The owner scope the two set writes carry in their WHERE clause: a set is this caller's when the
  // workout holding it is. It is a session lookup rather than the set's own user_id because that is
  // what the SQL joins on, and a fake that trusted a copy of the owner could disagree with it.
  bool ownsSession(const UserId& user, const SessionId& id) const {
    for (const Session& ran : sessions)
      if (ran.id == id && ran.user == user) return true;
    return false;
  }

  // The catalog read's predicate, applied where a WRITE names a movement: a seed, or one this
  // account created. It is the twin of nameOf, which stays unscoped on purpose — that one renders a
  // row the store already holds, this one decides whether an account may point at it at all.
  bool visibleTo(const UserId& owner, const ExerciseId& exercise) {
    for (const Exercise& known : catalog(owner))
      if (known.id == exercise) return true;
    return false;
  }

  // What THIS account calls a movement: its own line over the seed's name, the seed's name where
  // there is none, and a created movement's own row. The account is a parameter because a seed row
  // is global — the whole reason gym_exercise_names exists — so "the name" is not a property of the
  // catalog row alone.
  std::optional<std::string> nameOf(const UserId& user, const ExerciseId& id) const {
    for (const auto& [key, name] : displayNames)
      if (key.first == user.str() && key.second == id.str()) return name;
    for (const Exercise& exercise : seeds)
      if (exercise.id == id) return exercise.name;
    for (const auto& [owner, exercise] : customs)
      if (exercise.id == id) return exercise.name;
    return std::nullopt;
  }

  // The order both DISTINCT ON statements hand marks back in: by movement, heaviest load first.
  static std::vector<PriorMark> ordered(std::vector<PriorMark> marks) {
    std::sort(marks.begin(), marks.end(), [](const PriorMark& a, const PriorMark& b) {
      return std::pair(a.exercise.str(), -a.weightKg) < std::pair(b.exercise.str(), -b.weightKg);
    });
    return marks;
  }
};

}

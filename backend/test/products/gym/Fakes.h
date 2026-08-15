#pragma once

#include "products/gym/ports/AskThreadRepository.h"
#include "products/gym/ports/CatalogRepository.h"
#include "products/gym/ports/LogRepository.h"
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

// The export's three renderings, which the SQL does with `to_char(… AT TIME ZONE 'UTC')` and two
// `::text` casts off numeric columns of a fixed scale. They are mirrored here rather than
// approximated, because a fake that framed a cell differently from the live store would let a
// column drift with every test still green — and PgLogRepositoryTest pins the two together by
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

// An in-memory gym store that applies the SAME rules as the SQL — the PK no-op on a
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
//
// IT IS SHAPED THE WAY POSTGRES IS: one database, five repositories over it. FakeGymStore is the
// tables, plus every rule that reads across more than one aggregate — the catalog projection a set
// write and a routine write both check a movement against, the name this account calls a movement
// under, whose session a set is in, the last-trained instant a routine derives from the log — so
// each rule is written once and both fakes that need it read the same one. The five Fake…Repository
// classes are the ports, each holding a reference to the store and owning only the helpers that
// exactly one of them uses. The schema's cascades therefore read as one fake mutating rows another
// fake serves — deleteRoutine nulling sessions, deleteThread unlinking proposals — which is what a
// cascade IS, and the store is where that is visible. FakeGym bundles the six for a test harness.
struct FakeGymStore {
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
  // gym_proposals + gym_proposal_changes, as one value because the rows are one document: the diff
  // and the run it describes are the same rows read two ways (domain/Proposal.h).
  std::vector<RoutineProposal> proposalRows;
  std::vector<AskThread> threadRows;   // Ask's conversations; `minted` is derived on every read
  bool loseThreadRace = false;         // stage the concurrent-mint race `openThread` explains
  std::vector<SessionShare> shares;   // one per session at most, exactly as the primary key says
  std::vector<GymPreferences> preferenceRows;   // one per account at most, likewise
  // gym_exercise_names: what one account calls one SEED. Keyed (owner, movement) like the table's
  // own primary key, and every read of a display name coalesces it over the seed's — a fake that
  // resolved names off the catalog row alone would let the global-rename hazard ship behind green.
  std::vector<std::pair<std::pair<std::string, std::string>, std::string>> displayNames;
  // gym_exercise_aliases: what one account USED to call one movement, seeds and its own alike. `at`
  // stands in for created_at — the rename order, which is the order the read hands them back in —
  // and the row set is capped by the rename exactly as the SQL caps it.
  struct Alias {
    std::string user;
    std::string exercise;
    std::string name;
    std::uint64_t at;
  };
  std::vector<Alias> aliasRows;
  // gym_routines' three creation columns, which the entity deliberately does not carry: they are
  // facts about the WRITE and not about the document, so a replace cannot rewrite them.
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

  // Seeds under the name THIS account calls them, then the account's own movements — and the sort
  // is on the resolved name, exactly as the SQL orders by the coalesce rather than by the column.
  // It is on the store rather than on the catalog fake alone because it is also the predicate every
  // write that names a movement checks against (visibleTo below).
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

  // The catalog read's predicate, applied where a WRITE names a movement: a seed, or one this
  // account created. It is the twin of nameOf, which stays unscoped on purpose — that one renders a
  // row the store already holds, this one decides whether an account may point at it at all.
  bool visibleTo(const UserId& owner, const ExerciseId& exercise) const {
    for (const Exercise& known : catalogOf(owner))
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

  // The owner scope the two set writes carry in their WHERE clause: a set is this caller's when the
  // workout holding it is. It is a session lookup rather than the set's own user_id because that is
  // what the SQL joins on, and a fake that trusted a copy of the owner could disagree with it.
  bool ownsSession(const UserId& user, const SessionId& id) const {
    for (const Session& ran : sessions)
      if (ran.id == id && ran.user == user) return true;
    return false;
  }

  // Every routine read carries the store's derived answer, never the value a caller happened to
  // construct with: the newest session this account started under it, which is what the list sorts
  // on and what the routines screen prints as "trained {when}".
  Routine readRoutine(const Routine& stored) const {
    std::optional<std::uint64_t> lastTrained;
    for (const Session& session : sessions) {
      if (!(session.user == stored.user) || session.routine != stored.id) continue;
      if (!lastTrained || session.startedAtMs > *lastTrained) lastTrained = session.startedAtMs;
    }
    return Routine{stored.id,      stored.user, stored.name,     stored.position,
                   stored.entries, lastTrained, stored.revision};
  }

  // What this account used to call a movement, newest rename first — the order the SQL's
  // `ORDER BY created_at DESC, name ASC` hands back.
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
    // routine_id is a real foreign key, and it is NOT owner-scoped: a session may point only at a
    // routine that exists, and a broken pointer is a storage failure rather than a refusal — the
    // service loads the routine, owner-scoped, before it ever builds this row.
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
    for (Session& session : db.sessions) {
      if (!(session.id == id) || session.finishedAtMs) continue;
      session.finishedAtMs = finishedAtMs;
      session.closedBy = closedBy;
    }
  }

  SetInsertOutcome insertSet(const Set& incoming) override {
    // The lock statement, which READS the state it locks: whose session this is and whether it has
    // already been closed. Both refusals come off it before anything is written, exactly as they do
    // in the SQL. Without a session row the real INSERT..SELECT selects nothing, so nothing lands
    // and the read-back finds nothing — the same answer as a spent id, and TrainingService loads the
    // session before it ever gets here. A CLOSED one refuses outright: a set that never landed may
    // not land after the finish, and only the locked row can say so without a race.
    std::optional<Session> ran;
    for (const Session& session : db.sessions)
      if (session.id == incoming.session) ran = session;
    if (!ran) return {std::nullopt, SetInsertError::idTaken};
    // The revisions read, under the same lock and in the same place the SQL asks it: an id this
    // account holds as DELETED is spent for good, so a replayed append cannot hand back a set the
    // lifter took out of the log. Asked before the closed-session refusal, exactly as the SQL asks
    // it, so the two implementations answer a deleted set in a finished workout with the same word.
    for (const FakeGymStore::KeptSet& row : db.kept) {
      if (!row.deleted || !(row.set.id == incoming.id)) continue;
      if (db.ownsSession(ran->user, row.set.session))
        return {std::nullopt, SetInsertError::deleted};
    }
    // The one door through the finished boundary, the same one the SQL opens: a set continuing a
    // STALE-closed workout lands and moves the finish forward to it (below), never a set after the
    // lifter's own finish.
    const bool continuesStaleClose = ran->finishedAtMs && lateSetLands(*ran, incoming.completedAtMs);
    if (ran->finishedAtMs && !continuesStaleClose) return {std::nullopt, SetInsertError::finished};
    // Scoped on the SESSION's owner, the way the write is scoped in SQL. A foreign key alone would
    // admit another lifter's private movement, and their movement name would then be printed by
    // this account's log, its export and its coach share.
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

  // The correction, scoped (id, session, owner) exactly as the SQL's two statements are: a set id
  // that resolves under this account but in another workout is not this session's to correct, and
  // another account's is not there at all. What it replaces is kept BEFORE the row is rewritten —
  // a fake that skipped that would let the whole promise of §1 ship behind green.
  std::optional<Set> updateSet(const UserId& user, const Set& corrected) override {
    for (Set& set : db.sets) {
      if (!(set.id == corrected.id) || !(set.session == corrected.session)) continue;
      if (!db.ownsSession(user, set.session)) return std::nullopt;
      // Kept only where the row actually MOVES, the SQL's own `IS DISTINCT FROM` guard: `{}` is a
      // legal fix and a resent one is what a client does with a lost reply, so an unconditional copy
      // grows a version per retry standing for a change nobody made.
      if (!(set == corrected)) db.kept.push_back(FakeGymStore::KeptSet{set, false});
      set = corrected;
      return set;
    }
    return std::nullopt;
  }

  // The delete, and the same scope. The row moves whole into the kept list marked deleted — it is
  // never simply dropped — and nothing is answered, because a set that was never here does not stand
  // either. Set numbers are left alone: the SQL closes no gaps and neither does this.
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
    // The same unique sort key the SQL uses: (startedAt, id) descending, the whole pair compared
    // against the whole cursor, so a tie at a page edge cannot swallow a session.
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

  // The same walk the SQL does: this account's finished sessions newest first on (startedAt, id),
  // stopping at the first that holds a non-warmup set of the movement. The open session is stepped
  // over — today's sets are today's, not last time — and another account's is invisible, so nothing
  // here can answer with a session the caller may not read.
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
      // Scoped exactly like the catalog read the adapter checks against: another account's custom
      // movement is unknown here, never merely unlogged.
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
    // The name comes off the session's own frozen snapshot — never off a side map a test author
    // fills in, which is how a fake comes to agree with an answer the real store cannot produce.
    // The snapshot is typed now, so "the name is a string or there is no name" is a fact of the
    // type; what the adapter's `jsonb_typeof(plan->'routine') = 'string'` guard still defends
    // against is a raw blob no writer of ours can lay down (PgLogRepositoryTest pins that).
    return {LastTime{*newest, newest->plan ? newest->plan->routineName : "", block},
            LastTimeError::none};
  }

  // The picker's meta, and it is written as what it is: lastTime run over every movement this
  // account's sets name, projected to the LAST row of each block and dated by that block's session.
  // Composing it out of lastTime is the point rather than a shortcut — the SQL's DISTINCT ON claims
  // to be that same locator, and a fake that re-derived the rule by hand could agree with a green
  // suite while the two reads disagreed about which set you did last.
  //
  // The walk starts at the SETS, exactly as the statement's FROM does, so a movement this account
  // has never worked yields nothing and the vector stays sparse. Ordered by movement id, which is
  // the DISTINCT ON key and the key the caller joins on.
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

  // The same three answers the SQL gives, under the same rules. The marks are DISTINCT ON in a
  // vector: the qualifying prior working sets ordered by (movement, load, most reps, earliest
  // instant), keeping the first of each pair — so a mark carries the best reps ever done at that
  // load and is dated the day they were first hit. Both windows compare the PAIR (startedAt, id),
  // which is what keeps this session out of its own history: without it a review re-read after the
  // finish would find every set tying itself and would report no record at all.
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
      // `on delete cascade`: the sets go with the session, so nothing is left pointing at a row
      // that is gone — and a fake that kept them would hide exactly that leak behind green. The
      // revisions cascade too, which is what keeps a discard's own promise true: it is permanent,
      // and nothing keeps a copy of a workout that was thrown away.
      std::erase_if(db.sets, [&](const Set& set) { return set.session == id; });
      std::erase_if(db.kept,
                    [&](const FakeGymStore::KeptSet& held) { return held.set.session == id; });
      return true;
    }
    return false;   // absent and another account's are the same fact
  }

  // The record read: the catalog's own predicate first — no row means this account holds no such
  // movement and nothing else is loaded — then the routines that name it, then one ladder per
  // FINISHED session oldest first, then the last kRecentDays days of non-warmup sets. Every number
  // the page prints is computed from these by the pure rule; nothing here estimates anything.
  MovementHistory movementHistory(const UserId& user, const ExerciseId& exercise) override {
    MovementHistory history;
    for (const Exercise& known : db.catalogOf(user))
      if (known.id == exercise) history.exercise = known;
    if (!history.exercise) return history;

    // DISTINCT and in the lifter's own program order, which is what the SQL's ORDER BY says: a
    // routine naming the movement twice is still one day, and the sheet prints the days by name.
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

  // Every set this account holds, the OPEN session included, in the order the workouts were lived.
  // The join onto the catalog is an INNER one in the SQL, so a set naming a movement no catalog
  // holds is not in the file at all — it cannot exist behind the foreign key, and a fake that
  // emitted it with a blank name would be inventing a row the live store cannot produce.
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

  // The INSERT..SELECT off the caller's own session row: a session that is absent or another
  // account's selects nothing, so nothing lands, nothing conflicts, and the owner-scoped read-back
  // finds nothing — one answer for all three, and no branch here that could be got wrong. The
  // conflict is on the SESSION, so a live share answers with itself (the mint is idempotent) while
  // one that has already ended is replaced, which is the DO UPDATE's guard exactly.
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

  // Revoked (no row), expired (a row the predicate rejects) and never-minted (no row) leave this
  // with nothing to return — one value, so nothing above can tell them apart. The sets carry their
  // movement's display name and no id at all, and the routine name comes off the session's own
  // frozen snapshot rather than off a routine as it is called today.
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
  // The join both statistics projections are taken over: this account's working sets, in its
  // FINISHED sessions only, each carrying the session it was lived in. An open workout is today's
  // screen and not history — the same reason lastTime and historyFor step over it.
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

  // The store's projection, which is also the predicate every write that names a movement checks
  // against (FakeGymStore::visibleTo).
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

  // The rename, under the SAME split the SQL makes and for the same reason: a movement this account
  // created is its own row and renames in place, a SEED is a global row shared by every account on
  // the server and takes a per-account display name instead. Renaming a seed back to its own name
  // deletes that line rather than storing a copy of it. The renamed entity is CONSTRUCTED before
  // either write, so a name the store could not hold is refused before anything moves — a fake that
  // skipped the construction would let an unstorable name pass every service test.
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
  // The rename's three alias statements, in the SQL's own order and for the SQL's own reasons: the
  // name this account was using becomes one it USED to use, the name it is using now stops being
  // one — which is what a rename BACK needs, or the old name would shadow the truth in the picker —
  // and only the newest kMaxAliases are kept. Renaming to the same name adds nothing.
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
    for (const Routine& routine : db.routineRows)
      if (routine.user == user && routine.id == id) return db.readRoutine(routine);
    return std::nullopt;   // another account's routine is the same fact as no routine at all
  }

  // The routine's dated ledger: its proposals newest first, bounded, then its creation row — which
  // is always last and never counts against the bound, because it is the sentence a lifter reads to
  // learn where the day came from. A routine that is absent or another account's has no history at
  // all, which is the same one fact every read here gives.
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
    // A row seeded straight into routineRows by a test never went through the create, so it carries
    // no creation columns. Zero is not an instant the domain accepts anywhere, so it cannot be read
    // as a date; the live store always has one, because the column has always been NOT NULL.
    if (made == db.createdRoutines.end())
      history.push_back(
          RoutineEvent{RoutineEventKind::created, 0, std::nullopt, std::nullopt, std::nullopt});
    else
      history.push_back(RoutineEvent{RoutineEventKind::created, made->second.atMs,
                                     made->second.door, made->second.movements, std::nullopt});
    return history;
  }

  // The creation row of the history is written by the winner of the id and by nobody else, exactly
  // as the SQL's ON CONFLICT DO NOTHING decides it: a replay writes nothing, so the day a lifter
  // built on Sunday is not re-dated to whenever a queue got its reply through.
  RoutineWriteOutcome insertRoutine(const Routine& incoming, std::optional<ProposalDoor> byAgent,
                                    std::uint64_t nowMs) override {
    for (const Routine& routine : db.routineRows) {
      if (!(routine.id == incoming.id)) continue;
      if (routine.user == incoming.user)
        return {db.readRoutine(routine), RoutineWriteError::none};   // the PK no-op: a replay reads back stored
      return {std::nullopt, RoutineWriteError::idTaken};   // the id is spent by an account we can't see
    }
    // Every line names a movement this account may see, under the write's own scope rather than the
    // foreign key's — another lifter's private movement is unknown here, not merely someone else's.
    // The whole document is one transaction there, so a refused line leaves NO row behind.
    for (const RoutineEntry& entry : incoming.entries)
      if (!db.visibleTo(incoming.user, entry.exercise))
        return {std::nullopt, RoutineWriteError::unknownExercise};
    db.routineRows.push_back(incoming);
    db.createdRoutines[incoming.id.str()] =
        FakeGymStore::Created{nowMs, byAgent, static_cast<int>(incoming.entries.size())};
    return {db.readRoutine(incoming), RoutineWriteError::none};
  }

  // The lifter's own hand, and the two facts that make the ledger safe beside it: the revision
  // moves, and every proposal still pending on this routine is superseded in the same write. A fake
  // that skipped either would let a proposal be applied over a base the lifter had already replaced,
  // behind a green suite — which is precisely the bug Lift's own proposal-apply shipped.
  //
  // Both turn on the document or the NAME having moved, exactly as the SQL asks it: a PUT that lands
  // the bytes already standing — an editor saving on close, a logger writing the whole document back
  // to change one weight, a drag up the routines screen — settles nothing, because it destroyed no
  // base.
  RoutineWriteOutcome replaceRoutine(const Routine& incoming, std::uint64_t nowMs,
                                     std::optional<int> expectedRevision) override {
    for (Routine& routine : db.routineRows) {
      if (!(routine.id == incoming.id) || !(routine.user == incoming.user)) continue;
      for (const RoutineEntry& entry : incoming.entries)
        if (!db.visibleTo(incoming.user, entry.exercise))
          return {std::nullopt, RoutineWriteError::unknownExercise};
      if (expectedRevision && routine.revision != *expectedRevision)
        return {std::nullopt, RoutineWriteError::stale};
      const bool moved =
          routine.name != incoming.name || !(routine.entries == incoming.entries);
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
      // `on delete set null`: the sessions trained under it keep their frozen snapshots and lose
      // only the pointer, so the log still says which day of the program each one was.
      for (Session& session : db.sessions)
        if (session.routine == id) session.routine = std::nullopt;
      // `on delete cascade`: the proposals on a routine go with it, settled ones included. A day
      // that has left the program has no editor to draw a History section in.
      std::erase_if(db.proposalRows,
                    [&](const RoutineProposal& held) { return held.head.routine == id; });
      return true;
    }
    return false;
  }

  // ── The proposal ledger, under the same rules the SQL keeps ──

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

  // The mint's four steps in the order the SQL takes them: the routine resolved under the caller's
  // own scope, the spent id answered before anything is written, the prior pending one from the same
  // door superseded, then the row. Getting that order wrong is how a REFUSED mint settles the card
  // its caller could still see, and how a replayed mint supersedes the proposal it was replaying.
  //
  // The spent id splits three ways here as it does in SQL, and the split is the domain's own rule
  // (`isReplayOf`): another account's is taken, the caller's own carrying the same document is the
  // replay, and the caller's own carrying a different one is refused rather than answered with a
  // proposal it does not describe.
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
    // Every line names a movement this account may see, under the write's own scope rather than a
    // foreign key's — and refused HERE, at the mint, so a proposal a lifter could not apply never
    // reaches their screen.
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
    // The routine just moved, so every other proposal waiting on it is now against a base that is
    // gone — an apply settles them exactly as the lifter's own write does.
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

  // The `loggedSets` pass, which the SQL does with a LEFT JOIN onto gym_sets at READ time. It is
  // counted here rather than stored for the reason it is counted there: §D14's *41 logged sets kept*
  // has to be true when a lifter reads it.
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

  // What every pending proposal on a routine becomes the moment that routine MOVES — every door's,
  // because the base they were all minted against is gone. Not a delete: a superseded proposal drops
  // into the routine's dated history.
  void supersedeOnRoutine(const UserId& user, const RoutineId& routine, const ProposalId& except,
                          std::uint64_t nowMs) {
    for (RoutineProposal& held : db.proposalRows) {
      if (!(held.head.user == user) || !(held.head.routine == routine)) continue;
      if (held.head.state != ProposalState::pending || held.head.id == except) continue;
      held.head.state = ProposalState::superseded;
      held.head.settledAtMs = nowMs;
    }
  }

  // The narrower rule the partial unique index keys on: ONE PENDING PROPOSAL PER (routine, door,
  // connection). A mint replaces only what its own door had waiting; another door's stands, because
  // the lifter has two things to decide and losing one because the other spoke second would be the
  // ledger deciding for them.
  void supersedeFromDoor(const RoutineProposal& incoming) {
    for (RoutineProposal& held : db.proposalRows) {
      if (!(held.head.user == incoming.head.user) ||
          !(held.head.routine == incoming.head.routine))
        continue;
      if (held.head.state != ProposalState::pending || held.head.id == incoming.head.id) continue;
      // The partial unique index's own key, (routine, door, connection) — not the whole source, so
      // the fake supersedes exactly what the SQL would otherwise refuse and nothing more.
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

  // ── Ask's threads ────────────────────────────────────────────────────────────────────────────
  //
  // The turns are stored on the row and `minted` is DERIVED on every read from the proposal ledger,
  // exactly as the SQL derives it from a join — so a fake that stored an outcome could never drift
  // from one, because there is no outcome stored on either side.
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

  // The archive's read: every row, no ceiling, oldest first — the shape the export stamps outcomes
  // from, and the reason it is separate from the list is that a screen's ceiling is not an archive's.
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
    // The store's race, made reachable: two accounts mint one id at once, the loser's global probe
    // finds it free, its insert loses to ON CONFLICT DO NOTHING, and its owner-scoped read back comes
    // home empty — no thread and no named error. Only a flag can stage that deterministically.
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
    // `on delete set null`: THE CONVERSATION GOES AND THE CONSEQUENCE STAYS. Every proposal it
    // minted keeps its row, its state and its place in the routine's history, and loses only the
    // link back to a conversation that no longer exists.
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
      // A thread that holds no turns is still a row, with the turn columns empty — the store's LEFT
      // JOIN, said in the fake so both sides of the port answer alike. Such a thread is real for the
      // whole of every in-flight ask, and it is listed on screen.
      if (row.turns.empty()) {
        out.push_back(ExportedThreadTurn{row.id.str(), row.title, "", "", "",
                                         isoUtc(row.createdAtMs), "", "", "", ""});
        continue;
      }
      int position = 0;
      for (const ThreadTurn& turn : row.turns) {
        ++position;
        // The outcome columns come back EMPTY: that ladder is the domain's, and ThreadService stamps
        // it on — the same split the SQL keeps.
        out.push_back(ExportedThreadTurn{row.id.str(), row.title, "", "", "",
                                         isoUtc(row.createdAtMs), std::to_string(position),
                                         turn.fromLifter ? "lifter" : "ask", turn.text,
                                         isoUtc(turn.atMs)});
      }
    }
    return out;
  }

private:
  // The join the list read makes: what this conversation minted, in mint order, each carrying the
  // routine's name AS IT NOW STANDS — a day renamed since has to be findable under the name it has.
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
      // The SQL joins gym_routines, so a proposal whose routine is gone is off this list on both
      // sides — the routine's deletion took the proposal with it anyway.
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

  // The settings row, under the primary key's own rule: at most one per account, and a lifter who
  // has never written holds NONE — the absence is the fact, and the defaults are given a layer up
  // (PreferencesService), never invented here. The write is a whole-document upsert and last write wins,
  // which is the same ordering the claim replay leans on when a signed-in account meets the
  // settings an anonymous device just touched.
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

// The whole store and its five doors, in the shape a harness holds them: `FakeGym repo;` then
// `repo.db.sessions` for the rows and `repo.log`, `repo.program`, … for the ports a service takes.
struct FakeGym {
  FakeGymStore db;
  FakeLogRepository log{db};
  FakeCatalogRepository catalog{db};
  FakeProgramRepository program{db};
  FakeAskThreadRepository threads{db};
  FakePreferencesRepository preferences{db};
};

}

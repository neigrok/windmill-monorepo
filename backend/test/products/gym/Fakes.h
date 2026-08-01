#pragma once

#include "products/gym/ports/TrainingRepository.h"

#include <json/json.h>

#include <algorithm>
#include <memory>
#include <optional>
#include <set>
#include <string>
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

// An in-memory TrainingRepository that applies the SAME rules as the SQL — the PK no-op on a
// duplicate id, the one-open-session refusal that makes a second insert a no-op, max+1-per-
// exercise numbering, the owner scope on every read, the read-back scoped to the session (a set id
// spent elsewhere resolves to NOTHING, never to that row), the FK that refuses a set naming no
// known exercise, the routine name derived from the session's own frozen snapshot, and the IS NULL
// guard that makes close first-writer-wins. Lift's proposal-apply
// bug survived precisely as long as its mock didn't model the persistence boundary, so this
// fidelity is an architecture requirement: the service tests can never quietly disagree with the
// adapter about what a replay returns — and a fake that mirrors a leak hides it behind green.
class FakeTrainingRepository : public TrainingRepository {
public:
  std::vector<Exercise> seeds;
  std::vector<std::pair<std::string, Exercise>> customs;   // (owner, row)
  std::vector<Session> sessions;
  std::vector<Set> sets;

  void seed(const Exercise& exercise) { seeds.push_back(exercise); }
  void seedCustom(const UserId& owner, const Exercise& exercise) {
    customs.push_back({owner.str(), exercise});
  }

  std::vector<Exercise> catalog(const UserId& user) override {
    std::vector<Exercise> out = seeds;
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
    for (const Set& set : sets) {
      if (!(set.id == incoming.id)) continue;
      if (set.session == incoming.session)
        return {set, SetInsertError::none};                // the PK no-op: replay returns stored
      return {std::nullopt, SetInsertError::idTaken};      // the id is spent outside this session
    }
    bool sessionExists = false;
    for (const Session& session : sessions)
      if (session.id == incoming.session) sessionExists = true;
    // Without a session row the real INSERT..SELECT selects nothing, so nothing lands, no foreign
    // key is ever consulted, and the read-back finds nothing — the same answer as a spent id.
    // LogService loads the session before it ever gets here.
    if (!sessionExists) return {std::nullopt, SetInsertError::idTaken};
    // The exercise FK, stated as the same value the adapter reports its foreign_key_violation as.
    // It used to throw InvalidTraining here, so the fake said "could not read that set" where the
    // live server says "no such exercise" and no test could pin either — exactly the divergence
    // this file exists to make impossible.
    if (!nameOf(incoming.exercise)) return {std::nullopt, SetInsertError::unknownExercise};
    int number = 1;
    for (const Set& set : sets)
      if (set.session == incoming.session && set.exercise == incoming.exercise)
        number = std::max(number, set.setNumber + 1);
    Set stored = incoming;
    stored.setNumber = number;
    sets.push_back(stored);
    return {stored, SetInsertError::none};
  }

  std::vector<SessionSummary> log(const UserId& user, const LogCursor& cursor) override {
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

    std::vector<SessionSummary> out;
    for (const Session& session : page) {
      int count = 0;
      std::set<std::string> names;   // iterates sorted, exactly like the SQL's ORDER BY e.name
      for (const Set& set : sets) {
        if (!(set.session == session.id)) continue;
        ++count;
        if (std::optional<std::string> name = nameOf(set.exercise)) names.insert(*name);
      }
      out.push_back(SessionSummary{session, count,
                                   std::vector<std::string>(names.begin(), names.end())});
    }
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
    return {LastTime{*newest, routineNameOf(*newest), block}, LastTimeError::none};
  }

private:
  // Derived from the session's own frozen snapshot, exactly like the adapter's
  // `CASE WHEN jsonb_typeof(plan->'routine') = 'string' THEN plan->>'routine' ELSE '' END` — never
  // from a side map a test author fills in, which is how a fake comes to agree with an answer the
  // real store cannot produce. Anything that is not a string in an object plan is no name at all.
  std::string routineNameOf(const Session& session) const {
    if (session.planJson.empty()) return "";
    Json::Value plan;
    Json::CharReaderBuilder builder;
    const std::unique_ptr<Json::CharReader> reader{builder.newCharReader()};
    const char* begin = session.planJson.data();
    std::string errors;
    if (!reader->parse(begin, begin + session.planJson.size(), &plan, &errors)) return "";
    if (!plan.isObject()) return "";
    const Json::Value routine = plan.get("routine", Json::Value());
    if (!routine.isString()) return "";
    return routine.asString();
  }

  std::optional<std::string> nameOf(const ExerciseId& id) const {
    for (const Exercise& exercise : seeds)
      if (exercise.id == id) return exercise.name;
    for (const auto& [owner, exercise] : customs)
      if (exercise.id == id) return exercise.name;
    return std::nullopt;
  }
};

}

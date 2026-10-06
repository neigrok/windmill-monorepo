#include "products/gym/sync/domain/GymRules.h"

#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/TextMerge.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <set>

namespace wm::gym::engine {

using namespace sync;

const Row* GymFacts::row(const std::string& type, const std::string& id) const {
  for (const Row& row : rows) if (row.t == type && row.id.column() == id) return &row;
  const auto found = locked.find({type, id});
  return found != locked.end() && found->second.stored ? &*found->second.stored : nullptr;
}

IdState::Kind GymFacts::identity(const std::string& type, const std::string& id) const {
  if (const auto found = locked.find({type, id}); found != locked.end()) return found->second.state.kind;
  const Row* stored = row(type, id);
  if (stored) return stored->alive() ? IdState::Kind::alive : IdState::Kind::dead;
  return IdState::Kind::none;
}

Json::Value value(const Row* row, const std::string& field) {
  if (!row) return {};
  const auto found = row->lattice.f.find(field);
  return found == row->lattice.f.end() ? Json::Value() : found->second.value;
}

bool open(const Row& session) {
  return session.alive() && value(&session, "finishedAt").isNull();
}

Ms lastActivity(const GymFacts& facts, const Row& session) {
  std::optional<Ms> last;
  for (const Row& set : facts.rows) {
    if (set.t != "set" || !set.alive() || value(&set, "sessionId") != session.id.json()) continue;
    const Ms at = value(&set, "completedAt").asUInt64();
    last = std::max(last.value_or(at), at);
  }
  return last.value_or(value(&session, "startedAt").asUInt64());
}

namespace {

bool same(const Json::Value& a, const Json::Value& b) { return jcs(a) == jcs(b); }
bool created(const Change& change) { return change.after.alive() && !change.wasAlive(); }
bool died(const Change& change) { return !change.after.alive() && change.wasAlive(); }
bool changed(const Change& change, const std::string& field) {
  return change.after.alive() && change.wasAlive() && !same(value(&*change.stored, field), value(&change.after, field));
}

// A.2 display names: one created or changed to a blank one is `invalid`, whoever writes it. A stored one stands.
bool blankNamed(const Change& change, const std::string& field) {
  const Json::Value name = value(&change.after, field);
  return name.isString() && isBlank(name.asString()) && (created(change) || changed(change, field));
}

Delta deltaFor(const Row& row) {
  Delta delta{.t = row.t, .id = row.id};
  delta.lattice.born = row.lattice.born;
  return delta;
}

Delta fields(const Row& row, const Json::Value& values) {
  Delta delta = deltaFor(row);
  for (const std::string& name : values.getMemberNames()) delta.lattice.f.emplace(name, Reg(values[name], Stamp{}));
  return delta;
}

Delta death(const Row& row) {
  Delta delta = deltaFor(row);
  delta.lattice.life = Life(LifeState::dead, Stamp{});
  return delta;
}

Json::Value object(std::initializer_list<std::pair<const char*, Json::Value>> entries) {
  Json::Value result(Json::objectValue);
  for (const auto& [key, v] : entries) result[key] = v;
  return result;
}

Json::Value renamed(const Json::Value& aliases, const Json::Value& before, const Json::Value& after) {
  Json::Value result(Json::arrayValue);
  result.append(before);
  for (const Json::Value& alias : aliases) {
    if (alias == before || alias == after || result.size() == 5) continue;
    result.append(alias);
  }
  return result;
}

std::string stateOf(const Row& proposal) { return value(&proposal, "state").isNull() ? "pending" : value(&proposal, "state").asString(); }

std::vector<Delta> staleClose(const GymFacts& facts, Ms now) {
  for (const Row& row : facts.rows) {
    if (row.t != "session" || !open(row)) continue;
    const Ms at = lastActivity(facts, row);
    if (now < at || now - at < kStaleMs) return {};
    return {fields(row, object({{"finishedAt", Json::UInt64(at)}, {"closedBy", "stale"}}))};
  }
  return {};
}

void requireAlive(const GymFacts& facts, const std::string& type, const std::string& id) {
  const IdState::Kind state = facts.identity(type, id);
  if (state == IdState::Kind::none || state == IdState::Kind::foreign) throw Refusal(code::unknownRecord);
  if (state == IdState::Kind::dead) throw Refusal(code::recordDead);
}

std::vector<WriteEntry> replayWrite(const GymFacts& facts, const std::string& id, const Json::Value& sets) {
  std::vector<WriteEntry> entries;
  auto add = [&](const std::string& type, const std::string& id) {
    const Row* row = facts.row(type, id);
    if (row && row->alive()) entries.push_back(WriteEntry{.t = type, .id = row->id, .born = row->lattice.born});
  };
  add("session", id);
  for (const Json::Value& set : sets) add("set", set["id"].asString());
  return entries;
}

void append(CommandOutcome& outcome, Delta delta, bool born = false) {
  WriteEntry entry{.t = delta.t, .id = delta.id};
  if (born) entry.born = Stamp{};
  for (const auto& [name, reg] : delta.lattice.f) entry.f.emplace(name, Stamp{});
  outcome.deltas.push_back(std::move(delta));
  outcome.write.push_back(std::move(entry));
}

void checkInterval(const GymFacts& facts, const std::string& id, const Json::Value& args, Ms now) {
  const Ms start = args["startedAt"].asUInt64();
  const Ms finish = args["finishedAt"].asUInt64();
  if (finish < start || finish > now) throw Refusal("bad-instant");
  for (const Json::Value& set : args["sets"]) {
    const Ms at = set["completedAt"].asUInt64();
    if (at < start || at > finish) throw Refusal("bad-instant");
  }
  const Row* crossing = nullptr;
  for (const Row& row : facts.rows) {
    if (row.t != "session" || !row.alive() || row.id.column() == id || value(&row, "finishedAt").isNull()) continue;
    const Ms otherStart = value(&row, "startedAt").asUInt64();
    const Ms otherEnd = std::max(value(&row, "finishedAt").asUInt64(), otherStart + 1);
    if (otherStart >= std::max(finish, start + 1) || start >= otherEnd) continue;
    if (!crossing || std::pair(otherStart, row.id) < std::pair(value(crossing, "startedAt").asUInt64(), crossing->id)) crossing = &row;
  }
  if (crossing) throw Refusal("session-overlap", object({{"sessionId", crossing->id.json()}}));
}

void uniqueIds(const Json::Value& sets) {
  std::set<std::string> ids;
  for (const Json::Value& set : sets) if (!ids.insert(set["id"].asString()).second) throw Refusal(code::invalid);
}

Delta newSession(const GymFacts& facts, const Json::Value& args, bool finished) {
  Delta delta{.t = "session", .id = RecordId(args["id"])};
  delta.lattice.born = Stamp{};
  delta.lattice.life = Life(LifeState::alive, Stamp{});
  delta.lattice.f.emplace("startedAt", Reg(args["startedAt"], Stamp{}));
  if (finished) {
    delta.lattice.f.emplace("finishedAt", Reg(args["finishedAt"], Stamp{}));
    delta.lattice.f.emplace("closedBy", Reg("finish", Stamp{}));
  }
  if (!args.isMember("routineId")) return delta;
  const Row* routine = facts.row("routine", args["routineId"].asString());
  const bool readable = routine && routine->alive();
  const Json::Value plan = readable ? object({{"routine", value(routine, "name")}, {"entries", value(routine, "entries")}}) : Json::Value();
  delta.lattice.f.emplace("routineId", Reg(readable ? args["routineId"] : Json::Value(), Stamp{}));
  delta.lattice.f.emplace("plan", Reg(plan, Stamp{}));
  if (readable) delta.lattice.f.emplace("historyRoutineId", Reg(args["routineId"], Stamp{}));
  return delta;
}

Delta newSet(const std::string& session, const Json::Value& set, bool correction) {
  Delta delta{.t = "set", .id = RecordId(set["id"])};
  delta.lattice.born = Stamp{};
  delta.lattice.life = Life(LifeState::alive, Stamp{});
  Json::Value f = object({{"sessionId", session}, {"exerciseId", set["exerciseId"]}, {"weightKg", set["weightKg"]},
                         {"reps", set["reps"]}, {"kind", correction ? Json::Value("working") : set.get("kind", "working")},
                         {"note", set.get("note", "")}, {"completedAt", set["completedAt"]}});
  if (set.isMember("rpe")) f["rpe"] = set["rpe"];
  for (const std::string& name : f.getMemberNames()) delta.lattice.f.emplace(name, Reg(f[name], Stamp{}));
  if (correction) delta.v["setNumber"] = set["setNumber"];
  return delta;
}

std::string supersededReason(const GymFacts& facts, const Row& proposal) {
  if (!value(&proposal, "supersededBy").isNull()) return "replaced";
  const std::string routine = value(&proposal, "routineId").asString();
  if (value(facts.row("routine", routine), "revision") != value(&proposal, "baseRevision")) return "routine-changed";
  return "superseded";
}

Json::Value proposalChanges(const Json::Value& base, const Json::Value& proposed) {
  auto side = [](const Json::Value& entry) {
    Json::Value result(Json::objectValue);
    for (const char* field : {"sets", "restSeconds"}) if (entry.isMember(field)) result[field] = entry[field];
    return result;
  };
  std::set<Json::ArrayIndex> matched;
  Json::Value changes(Json::arrayValue);
  for (const Json::Value& entry : proposed) {
    Json::Value change = object({{"kind", "added"}, {"exerciseId", entry["exerciseId"]}, {"after", side(entry)}});
    for (Json::ArrayIndex i = 0; i < base.size(); ++i) {
      if (matched.contains(i) || base[i]["exerciseId"] != entry["exerciseId"]) continue;
      matched.insert(i);
      change["before"] = side(base[i]);
      change["kind"] = same(change["before"], change["after"]) ? "kept" : "retargeted";
      break;
    }
    changes.append(change);
  }
  for (Json::ArrayIndex i = 0; i < base.size(); ++i) {
    if (!matched.contains(i)) changes.append(object({{"kind", "removed"}, {"exerciseId", base[i]["exerciseId"]}, {"before", side(base[i])}}));
  }
  return changes;
}

}

std::vector<Delta> checkGym(const GymFacts& facts, const std::vector<Change>& changes, const Intent& intent, bool server, Ms now) {
  const std::map<std::string, std::vector<std::string>> authored{
      {"routine", {"revision", "createdEntries"}}, {"proposal", {"baseRevision", "baseName", "changeCount"}}, {"note", {"updatedAt"}}};
  for (const Delta& delta : intent.d) {
    if (delta.t == "routineCreation") throw Refusal(code::invalid);
    const auto found = authored.find(delta.t);
    if (found != authored.end()) for (const std::string& field : found->second)
      if (delta.lattice.f.contains(field)) throw Refusal(code::invalid);
  }
  using Key = std::pair<std::string, std::string>;
  std::map<Key, Row> joined;
  std::set<std::string> futureProposals;
  std::map<std::pair<std::string, std::string>, std::int64_t> numbers;
  for (const Row& row : facts.rows) {
    joined.insert_or_assign({row.t, row.id.column()}, row);
    if (row.t != "set" || !row.alive()) continue;
    const auto number = row.v.find("setNumber");
    if (number == row.v.end()) continue;
    auto& highest = numbers[{value(&row, "sessionId").asString(), value(&row, "exerciseId").asString()}];
    highest = std::max(highest, number->second.asInt64());
  }
  for (const Change& change : changes) {
    joined.insert_or_assign({change.after.t, change.after.id.column()}, change.after);
    if (change.after.t == "proposal" && created(change)) futureProposals.insert(change.after.id.column());
  }
  auto current = [&](const std::string& type, const Json::Value& id) -> const Row* {
    if (!id.isString()) return nullptr;
    const auto found = joined.find({type, id.asString()});
    return found == joined.end() ? nullptr : &found->second;
  };
  auto known = [&](const Json::Value& id) {
    if (!id.isString()) return false;
    if (facts.books["seeds"].isMember(id.asString())) return true;
    const Row* exercise = current("exercise", id);
    return exercise && exercise->alive();
  };
  auto activity = [&](const Row& session) {
    std::optional<Ms> last;
    for (const auto& [key, set] : joined) {
      if (set.t != "set" || !set.alive() || value(&set, "sessionId") != session.id.json()) continue;
      const Ms at = value(&set, "completedAt").asUInt64();
      last = std::max(last.value_or(at), at);
    }
    return last.value_or(value(&session, "startedAt").asUInt64());
  };
  std::vector<Delta> appended;
  auto append = [&](Delta delta) {
    auto [position, inserted] = joined.try_emplace(Key{delta.t, delta.id.column()}, delta.t, delta.id);
    Row& row = position->second;
    if (delta.lattice.life) row.lattice.life = delta.lattice.life;
    for (const auto& [field, reg] : delta.lattice.f) row.lattice.f.insert_or_assign(field, reg);
    appended.push_back(std::move(delta));
  };
  for (const Change& change : changes) {
    const Row& after = change.after;
    if (after.t != "routine" || !after.alive()) continue;
    const bool fresh = created(change);
    if (!fresh && !changed(change, "name") && !changed(change, "entries")) continue;
    const Json::Value prior = value(change.stored ? &*change.stored : nullptr, "revision");
    if (!fresh && (prior.isNull() || prior.asInt64() >= 2'147'483'647)) throw Refusal(code::invalid);
    Json::Value values = object({{"revision", fresh ? Json::Value(1) : Json::Value(prior.asInt64() + 1)}});
    if (fresh) values["createdEntries"] = value(&after, "entries").size();
    append(fields(after, values));
  }
  for (const Change& change : changes) {
    const Row& after = change.after;
    if (after.t == "set") {
      if (after.alive()) {
        const auto supplied = after.v.find("setNumber");
        if (supplied != after.v.end() && (supplied->second.asInt64() < 1 || supplied->second.asInt64() > 2'147'483'647)) throw Refusal(code::invalid);
      }
      if (!created(change)) {
        for (const Delta& delta : intent.d) {
          if (delta.t == "set" && delta.id == after.id && delta.lattice.f.contains("completedAt") && change.stored) throw Refusal(code::invalid);
        }
        continue;
      }
      const Row* session = current("session", value(&after, "sessionId"));
      const bool command = std::find(change.createdBy.begin(), change.createdBy.end(), Source::command) != change.createdBy.end();
      if (!command && session && session->alive()) {
        const Json::Value finished = value(session, "finishedAt");
        if (!finished.isNull()) {
          const Ms at = value(&after, "completedAt").asUInt64();
          if (value(session, "closedBy") != "stale" || at > finished.asUInt64() + kStaleMs) throw Refusal("session-finished");
          if (at > finished.asUInt64()) append(fields(*session, object({{"finishedAt", Json::UInt64(at)}})));
        }
      }
      if (!known(value(&after, "exerciseId"))) throw Refusal("unknown-exercise");
      if (change.isNew) {
        auto& highest = numbers[{value(&after, "sessionId").asString(), value(&after, "exerciseId").asString()}];
        const auto supplied = after.v.find("setNumber");
        const std::int64_t number = supplied == after.v.end() ? highest + 1 : supplied->second.asInt64();
        if (number > 2'147'483'647) throw Refusal(code::invalid);
        highest = std::max(highest, number);
      }
      continue;
    }
    if (after.t == "session") {
      if (created(change)) {
        if (std::any_of(change.createdBy.begin(), change.createdBy.end(), [](Source source) { return source != Source::command; })) throw Refusal(code::invalid);
        continue;
      }
      if (!died(change)) continue;
      const Row& prior = *change.stored;
      const Ms at = activity(prior);
      if (value(&prior, "finishedAt").isNull() && (now < at || now - at < kStaleMs)) throw Refusal("session-open");
      for (const auto& [key, set] : joined) if (set.t == "set" && set.alive() && value(&set, "sessionId") == after.id.json()) append(death(set));
      continue;
    }
    if (after.t == "routine") {
      if (died(change)) {
        for (const auto& [key, row] : joined) {
          if (!row.alive() || value(&row, "routineId") != after.id.json()) continue;
          if (row.t == "proposal") append(death(row));
          if (row.t == "session") append(fields(row, object({{"routineId", Json::Value()}})));
        }
        continue;
      }
      if (!after.alive()) continue;
      if (blankNamed(change, "name")) throw Refusal(code::invalid);
      if (created(change) || changed(change, "entries")) {
        const Json::Value entries = value(&after, "entries");
        if (!entries.isArray() || entries.empty()) throw Refusal(code::invalid);
        for (const Json::Value& entry : entries) {
          if (entry.isMember("sets") && entry["sets"].empty()) throw Refusal(code::invalid);
        }
        for (const Json::Value& entry : entries) if (!known(entry["exerciseId"])) throw Refusal("unknown-exercise");
      }
      if (created(change) && value(&after, "createdDoor") == "ask") {
        if (current("routineCreation", after.id.json())) throw Refusal(code::invalid);
        Json::Value snapshot = object({{"id", after.id.json()}, {"name", value(&after, "name")},
            {"position", value(&after, "position").isNull() ? Json::Value(0) : value(&after, "position")},
            {"revision", 1}, {"entries", value(&after, "entries")}});
        int position = 0;
        for (auto& entry : snapshot["entries"]) entry["position"] = ++position;
        Row receipt("routineCreation", after.id);
        append(fields(receipt, object({{"snapshot", snapshot}})));
      }
      if (!changed(change, "name") && !changed(change, "entries")) continue;
      for (const auto& [key, proposal] : joined) {
        if (proposal.t != "proposal" || !proposal.alive() || value(&proposal, "routineId") != after.id.json() || stateOf(proposal) != "pending") continue;
        append(fields(proposal, object({{"state", "superseded"}, {"settledAt", Json::UInt64(now)}})));
      }
      continue;
    }
    if (after.t == "exercise") {
      if (died(change) || (created(change) && value(&after, "stepKg").isNull())) throw Refusal(code::invalid);
      if (blankNamed(change, "name")) throw Refusal(code::invalid);
      if (changed(change, "name")) append(fields(after, object({{"aliases", renamed(value(&after, "aliases"), value(&*change.stored, "name"), value(&after, "name"))}})));
      continue;
    }
    if (after.t == "exerciseName") {
      const Json::Value seed = facts.books["seeds"][after.id.column()];
      if (seed.isNull()) throw Refusal(code::invalid);
      if (blankNamed(change, "name")) throw Refusal(code::invalid);
      Json::Value before = value(change.stored ? &*change.stored : nullptr, "name");
      Json::Value next = value(&after, "name");
      if (before.isNull()) before = seed["name"];
      if (next.isNull()) next = seed["name"];
      if (before != next) append(fields(after, object({{"aliases", renamed(value(&after, "aliases"), before, next)}})));
      continue;
    }
    if (after.t == "weighin") {
      using namespace std::chrono;
      const year_month_day day{floor<days>(sys_time<milliseconds>{milliseconds{now + 86'400'000}})};
      char date[11];
      std::snprintf(date, sizeof date, "%04d-%02u-%02u", int(day.year()), unsigned(day.month()), unsigned(day.day()));
      if (after.alive() && after.id.column() > date) throw Refusal("bad-instant");
      continue;
    }
    if (after.t == "note") {
      if (blankNamed(change, "title")) throw Refusal(code::invalid);
      if (created(change) || changed(change, "title") || changed(change, "body")) append(fields(after, object({{"updatedAt", Json::UInt64(now)}})));
      continue;
    }
    if (after.t != "proposal" || !created(change)) continue;
    futureProposals.erase(after.id.column());
    if (!server && (value(&after, "door") != "ask" || !value(&after, "connection").asString().empty() || !value(&after, "agent").asString().empty())) throw Refusal(code::invalid);
    const Json::Value routineId = value(&after, "routineId");
    const Row* routine = current("routine", routineId);
    if (!routine || !routine->alive()) throw Refusal(code::unknownRecord);
    if (!server) {
      for (const char* field : {"entries", "name"}) {
        const auto reg = routine->lattice.f.find(field);
        const std::optional<Stamp> stamp = reg == routine->lattice.f.end() ? std::nullopt : std::optional(reg->second.stamp);
        if (std::none_of(intent.guard.begin(), intent.guard.end(), [&](const Guard& guard) { return guard.t == "routine" && guard.id.json() == routineId && guard.field == field && guard.stamp == stamp; })) throw Refusal(code::invalid);
      }
    }
    Json::Value proposed(Json::arrayValue);
    for (const Json::Value& line : value(&after, "changes")) {
      if (line["kind"] == "removed") continue;
      Json::Value entry = line["after"];
      entry["exerciseId"] = line["exerciseId"];
      proposed.append(entry);
    }
    if (value(&after, "intent") == "remove" ? !proposed.empty() : proposed.empty() || proposed.size() > 50 || isBlank(value(&after, "proposedName").asString())) throw Refusal(code::invalid);
    for (const Json::Value& entry : proposed) {
      if (entry.isMember("sets") && entry["sets"].empty()) throw Refusal(code::invalid);
    }
    if (!same(value(&after, "changes"), proposalChanges(value(routine, "entries"), proposed))) throw Refusal(code::invalid);
    for (const Json::Value& entry : proposed) if (!known(entry["exerciseId"])) throw Refusal("unknown-exercise");
    append(fields(after, object({{"baseRevision", value(routine, "revision")},
        {"baseName", value(routine, "name")},
        {"changeCount", proposalChangeCount(value(routine, "entries"), value(&after, "changes"), value(routine, "name"), value(&after, "proposedName"))}})));
    for (const auto& [key, other] : joined) {
      if (other.t != "proposal" || other.id == after.id || futureProposals.contains(other.id.column())) continue;
      if (!other.alive() || stateOf(other) != "pending" || value(&other, "routineId") != routineId || value(&other, "door") != value(&after, "door")) continue;
      if (value(&other, "connection").asString() != value(&after, "connection").asString()) continue;
      append(fields(other, object({{"state", "superseded"}, {"supersededBy", after.id.json()}, {"settledAt", Json::UInt64(now)}})));
    }
  }
  return appended;
}

GymOutcome runGym(const std::string& name, const Json::Value& args, const Json::Value& rawArgs, const GymFacts& facts, Ms now) {
  GymOutcome result;
  CommandOutcome& outcome = result.command;
  if (name == "gym.closeStale") {
    outcome.deltas = staleClose(facts, now);
    return result;
  }
  if (name == "gym.start") {
    outcome.deltas = staleClose(facts, now);
    const std::string called = args["id"].asString();
    const Json::Value receipt = facts.books["starts"][called];
    const Row* own = facts.row("session", called);
    if (!receipt.isNull() || own) {
      const std::string resolved = receipt.isNull() ? called : receipt.asString();
      const Row* session = facts.row("session", resolved);
      if (!session || !session->alive()) return result;
      WriteEntry entry{.t = "session", .id = session->id, .born = session->lattice.born};
      if (resolved != called) entry.from = RecordId(called);
      outcome.write.push_back(std::move(entry));
      return result;
    }
    for (const Row& session : facts.rows) {
      if (session.t != "session" || !open(session)) continue;
      if (std::any_of(outcome.deltas.begin(), outcome.deltas.end(), [&](const Delta& delta) { return delta.id == session.id; })) continue;
      if (!args["joinOpenSession"].asBool()) throw Refusal("session-open");
      result.receiptKind = "starts";
      result.receiptId = called;
      result.receipt = session.id.json();
      outcome.write.push_back(WriteEntry{.t = "session", .id = session.id, .from = RecordId(called), .born = session.lattice.born});
      return result;
    }
    result.receiptKind = "starts";
    result.receiptId = called;
    result.receipt = called;
    append(outcome, newSession(facts, args, false), true);
    return result;
  }
  if (name == "gym.importSession") {
    outcome.deltas = staleClose(facts, now);
    const std::string id = args["id"].asString();
    const Json::Value receipt = facts.books["imports"][id];
    if (!receipt.isNull() || facts.books["importHashes"].isMember(id)) {
      const Json::Value hash = facts.books["importHashes"][id];
      if (hash.isString() ? hash.asString() != sha256(jcs(rawArgs)).hex() : !same(receipt, rawArgs)) throw Refusal("payload-conflict");
      outcome.write = replayWrite(facts, id, args["sets"]);
      return result;
    }
    const IdState::Kind state = facts.identity("session", id);
    if (state == IdState::Kind::alive || state == IdState::Kind::dead) throw Refusal("payload-conflict");
    if (state == IdState::Kind::foreign) throw Refusal(code::idTaken);
    uniqueIds(args["sets"]);
    checkInterval(facts, id, args, now);
    append(outcome, newSession(facts, args, true), true);
    for (const Json::Value& set : args["sets"]) append(outcome, newSet(id, set, false), true);
    result.receiptKind = "imports";
    result.receiptId = id;
    result.receipt = rawArgs;
    return result;
  }
  if (name == "gym.correctSession") {
    const std::string id = args["sessionId"].asString();
    requireAlive(facts, "session", id);
    const std::string request = args["requestId"].asString();
    const Json::Value receipt = facts.books["corrections"][request];
    if (!receipt.isNull()) {
      const Json::Value hash = facts.books["correctionHashes"][request];
      const bool conflict = hash.isString() ? hash.asString() != sha256(jcs(rawArgs)).hex() : !same(receipt["args"], rawArgs);
      if (receipt["sessionId"] != args["sessionId"] || conflict) throw Refusal("payload-conflict");
      outcome.write = replayWrite(facts, id, args["sets"]);
      return result;
    }
    const Row& session = *facts.row("session", id);
    if (open(session)) throw Refusal("session-open");
    if (args["sets"].empty()) throw Refusal(code::invalid);
    uniqueIds(args["sets"]);
    std::set<std::pair<std::string, std::int64_t>> numbers;
    for (const Json::Value& set : args["sets"]) if (!numbers.emplace(set["exerciseId"].asString(), set["setNumber"].asInt64()).second) throw Refusal(code::invalid);
    checkInterval(facts, id, args, now);
    append(outcome, fields(session, object({{"startedAt", args["startedAt"]}, {"finishedAt", args["finishedAt"]}, {"closedBy", "finish"}, {"displayName", args["routineName"]}})));
    std::set<std::string> named;
    for (const Json::Value& set : args["sets"]) {
      const std::string setId = set["id"].asString();
      named.insert(setId);
      const Row* prior = facts.row("set", setId);
      if (!prior || !prior->alive() || value(prior, "sessionId") != args["sessionId"]) {
        append(outcome, newSet(id, set, true), true);
        continue;
      }
      if (value(prior, "exerciseId") != set["exerciseId"]) throw Refusal(code::invalid);
      Json::Value f = object({{"weightKg", set["weightKg"]}, {"reps", set["reps"]}, {"completedAt", set["completedAt"]}});
      for (const char* field : {"rpe", "note"}) if (set.isMember(field)) f[field] = set[field];
      Delta delta = fields(*prior, f);
      delta.v["setNumber"] = set["setNumber"];
      append(outcome, std::move(delta));
    }
    for (const Row& row : facts.rows) if (row.t == "set" && row.alive() && value(&row, "sessionId") == args["sessionId"] && !named.contains(row.id.column())) outcome.deltas.push_back(death(row));
    result.receiptKind = "corrections";
    result.receiptId = request;
    result.receipt = object({{"sessionId", args["sessionId"]}, {"args", rawArgs}});
    return result;
  }
  if (name == "gym.finish") {
    const std::string id = args["sessionId"].asString();
    requireAlive(facts, "session", id);
    const Row& session = *facts.row("session", id);
    const Ms finish = args["finishedAt"].asUInt64();
    if (!finish || finish < value(&session, "startedAt").asUInt64()) throw Refusal("bad-instant");
    const Json::Value stored = value(&session, "finishedAt");
    if (!stored.isNull() && value(&session, "closedBy") != "stale") return result;
    const Ms at = stored.isNull() ? finish : finish > stored.asUInt64() + kStaleMs ? stored.asUInt64() : std::max(stored.asUInt64(), finish);
    append(outcome, fields(session, object({{"finishedAt", Json::UInt64(at)}, {"closedBy", "finish"}})));
    return result;
  }
  const std::string id = args["proposalId"].asString();
  requireAlive(facts, "proposal", id);
  const Row& proposal = *facts.row("proposal", id);
  const bool apply = name == "gym.applyProposal";
  const std::string state = stateOf(proposal);
  if (state == (apply ? "applied" : "dismissed")) return result;
  if (state == "applied" || state == "dismissed") throw Refusal("proposal-settled", object({{"state", state}}));
  if (state == "superseded") throw Refusal("proposal-superseded", object({{"reason", supersededReason(facts, proposal)}}));
  const std::string routineId = value(&proposal, "routineId").asString();
  if (apply && value(facts.row("routine", routineId), "revision") != value(&proposal, "baseRevision")) throw Refusal("proposal-superseded", object({{"reason", "routine-changed"}}));
  Delta settle = fields(proposal, object({{"state", apply ? "applied" : "dismissed"}, {"settledAt", Json::UInt64(now)}}));
  if (!apply) {
    append(outcome, std::move(settle));
    return result;
  }
  const Row& routine = *facts.row("routine", routineId);
  if (value(&proposal, "intent") == "remove") {
    outcome.deltas = {settle, death(routine)};
    return result;
  }
  Json::Value entries(Json::arrayValue);
  for (const Json::Value& change : value(&proposal, "changes")) {
    if (change["kind"] == "removed") continue;
    Json::Value entry = change["after"];
    entry["exerciseId"] = change["exerciseId"];
    entries.append(entry);
  }
  append(outcome, std::move(settle));
  append(outcome, fields(routine, object({{"name", value(&proposal, "proposedName")}, {"entries", entries}})));
  return result;
}

int proposalChangeCount(const Json::Value& base, const Json::Value& changes, const Json::Value& baseName, const Json::Value& proposedName) {
  int count = baseName == proposedName ? 0 : 1;
  for (const Json::Value& change : changes) if (change["kind"] != "kept") ++count;
  std::set<Json::ArrayIndex> matched;
  int highest = -1;
  for (const Json::Value& change : changes) {
    if (change["kind"] == "added" || change["kind"] == "removed") continue;
    for (Json::ArrayIndex i = 0; i < base.size(); ++i) {
      if (matched.contains(i) || base[i]["exerciseId"] != change["exerciseId"]) continue;
      matched.insert(i);
      if (static_cast<int>(i) < highest) return count + 1;
      highest = static_cast<int>(i);
      break;
    }
  }
  return count;
}


}

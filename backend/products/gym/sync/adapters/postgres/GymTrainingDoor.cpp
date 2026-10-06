#include "products/gym/sync/adapters/postgres/GymDoor.h"

#include "platform/adapters/postgres/PgSyncStore.h"
#include "products/gym/adapters/json/TrainingJson.h"
#include "products/gym/sync/adapters/postgres/GymDoorHash.h"

#include <algorithm>
#include <numeric>
#include <stdexcept>

namespace wm::gym {

namespace {

// A new set's fields, as a phone's create delta carries them.
Json::Value setFields(const Set& set) {
  auto fields = toJson(set);
  fields.removeMember("id");
  fields.removeMember("setNumber");
  fields["sessionId"] = set.session.str();
  fields["rpe"] = set.rpe ? Json::Value(*set.rpe) : Json::Value();
  return fields;
}

std::vector<Set> batchSets(const SessionId& session, const std::vector<SetWrite>& incoming) {
  std::vector<Set> sets;
  for (std::size_t i = 0; i < incoming.size(); ++i) {
    const auto& row = incoming[i];
    try {
      sets.emplace_back(row.id, session, row.exercise, 0, row.weightKg, row.reps,
                        row.kind, row.rpe, row.note, row.completedAtMs);
    } catch (const InvalidTraining& error) {
      throw InvalidTraining("sets[" + std::to_string(i) + "] (" + row.id.str() + "): " + error.what());
    }
  }
  return sets;
}

bool visibleMovement(pqxx::transaction_base& sql, const UserId& user, const ExerciseId& id) {
  return !sql.exec("select 1 from gym_exercises where id=$1 and (created_by is null or created_by=$2::uuid)",
                   pqxx::params{id.str(), user.str()}).empty();
}

// The receipt a created set left behind, if any: its owner, then its request's hash.
pqxx::result setReceipt(pqxx::transaction_base& sql, const SetId& id) {
  return sql.exec("select user_id::text,request_hash from gym_write_receipts where kind='set' and id=$1",
                  pqxx::params{id.str()});
}

// A set the lifter took out of the log: its delete left the whole row behind as a revision.
bool deletedFromLog(pqxx::transaction_base& sql, const UserId& user, const SetId& id) {
  return !sql.exec("select 1 from gym_set_revisions where set_id=$1 and user_id=$2::uuid and deleted limit 1",
                   pqxx::params{id.str(), user.str()}).empty();
}

// The batch's indexes in set-id order, the order every set row is locked in.
std::vector<std::size_t> inIdOrder(const std::vector<Set>& sets) {
  std::vector<std::size_t> order(sets.size());
  std::iota(order.begin(), order.end(), 0);
  std::sort(order.begin(), order.end(), [&](auto a, auto b) { return sets[a].id < sets[b].id; });
  return order;
}

BatchLogError batchRefusal(const std::string& code) {
  if (code == "id-taken") return BatchLogError::idTaken;
  if (code == "id-spent" || code == "record-dead") return BatchLogError::deleted;
  if (code == "parent-dead" || code == "unknown-record") return BatchLogError::notFound;
  if (code == "session-finished") return BatchLogError::finished;
  if (code == "unknown-exercise") return BatchLogError::unknownExercise;
  if (code == "payload-conflict") return BatchLogError::payloadConflict;
  if (code == "session-overlap") return BatchLogError::overlap;
  return BatchLogError::none;
}

}

StartOutcome GymDoor::start(const UserId& user, const SessionStart& incoming) {
  closeStale(user);
  Json::Value args(Json::objectValue);
  args["id"] = incoming.id.str();
  args["startedAt"] = Json::UInt64(incoming.startedAtMs);
  args["joinOpenSession"] = incoming.joinOpenSession;
  if (incoming.routine) args["routineId"] = incoming.routine->str();
  StartOutcome answer{std::nullopt, StartError::none};
  const auto result = execute(user, [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
    auto& sql = sync::sqlOf(txn);
    const auto receipt = sql.exec("select user_id::text,session_id from gym_write_receipts where kind='session' and id=$1",
                                  pqxx::params{incoming.id.str()});
    std::optional<Session> held = log_.session(user, incoming.id);
    if (!receipt.empty() && receipt[0][0].as<std::string>() == user.str())
      held = log_.session(user, SessionId{receipt[0][1].as<std::string>()});
    if (held) return intent("gym.start", args);
    const auto open = log_.open(user);
    if (open) {
      if (!incoming.joinOpenSession) { answer.error = StartError::alreadyOpen; return std::nullopt; }
      if (!wellFormedId(incoming.id.str()) || (!receipt.empty() && receipt[0][0].as<std::string>() == user.str())) {
        answer.session = open;
        return std::nullopt;
      }
      if (receipt.empty() && incoming.id != open->id)
        txn.reserveSpent("session", sync::RecordId{incoming.id.str()});
      return intent("gym.start", args);
    }
    if (!receipt.empty()) { answer.error = StartError::idTaken; return std::nullopt; }
    const auto now = clock_.nowMs();
    if (!canStartAt(incoming.startedAtMs, now)) {
      answer.error = StartError::clockAhead;
      answer.clockAheadMs = incoming.startedAtMs - now;
      return std::nullopt;
    }
    if (incoming.routine && !program_.routine(user, *incoming.routine)) {
      answer.error = StartError::unknownRoutine;
      return std::nullopt;
    }
    Session{incoming.id, user, incoming.startedAtMs, std::nullopt, incoming.routine};  // throws on a malformed id or instant
    return intent("gym.start", args);
  });
  const auto code = refusal(result);
  if (code == "session-open") return {std::nullopt, StartError::alreadyOpen};
  if (code == "id-taken" || code == "id-spent") return {std::nullopt, StartError::idTaken};
  requireOk(result);
  if (answer.error != StartError::none || answer.session) return answer;
  for (const auto& row : result["write"])
    if (row["t"] == "session") return {log_.session(user, SessionId{row["id"].asString()}), StartError::none};
  return {std::nullopt, StartError::idTaken};
}

AppendOutcome GymDoor::append(const UserId& user, const SessionId& session, const SetWrite& incoming) {
  AppendOutcome answer{std::nullopt, AppendError::none};
  const auto result = execute(user, [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
    const auto stored = log_.session(user, session);
    if (!stored) { answer.error = AppendError::notFound; return std::nullopt; }
    Set canonical{incoming.id, session, incoming.exercise, 0, incoming.weightKg, incoming.reps,
                  incoming.kind, incoming.rpe, incoming.note, incoming.completedAtMs};
    const auto replayed = log_.setOf(user, incoming.id);
    if (replayed) {
      if (replayed->session == session) answer.set = replayed;
      else answer.error = AppendError::idTaken;
      return std::nullopt;
    }
    auto& sql = sync::sqlOf(txn);
    const auto receipt = setReceipt(sql, incoming.id);
    if (!receipt.empty()) {
      answer.error = receipt[0][0].as<std::string>() == user.str() ? AppendError::deleted : AppendError::idTaken;
      return std::nullopt;
    }
    if (deletedFromLog(sql, user, incoming.id)) { answer.error = AppendError::deleted; return std::nullopt; }
    if (stored->finishedAtMs && !lateSetLands(*stored, incoming.completedAtMs)) {
      answer.error = AppendError::finished;
      return std::nullopt;
    }
    if (!visibleMovement(sql, user, incoming.exercise)) {
      answer.error = AppendError::unknownExercise;
      return std::nullopt;
    }
    pqxx::params precision{canonical.weightKg};
    if (canonical.rpe) precision.append(*canonical.rpe); else precision.append();
    const auto normalized = sql.exec("select $1::numeric(6,2)::float8,$2::numeric(3,1)::float8", precision);
    canonical.weightKg = normalized[0][0].as<double>();
    if (!normalized[0][1].is_null()) canonical.rpe = normalized[0][1].as<double>();
    auto value = intent();
    value["d"].append(delta("set", incoming.id.str(), setFields(canonical), true));
    return value;
  });
  const auto code = refusal(result);
  if (code == "id-taken") return {std::nullopt, AppendError::idTaken};
  if (code == "id-spent" || code == "record-dead") return {std::nullopt, AppendError::deleted};
  if (code == "parent-dead" || code == "unknown-record") return {std::nullopt, AppendError::notFound};
  if (code == "session-finished") return {std::nullopt, AppendError::finished};
  if (code == "unknown-exercise") return {std::nullopt, AppendError::unknownExercise};
  requireOk(result);
  if (answer.error != AppendError::none || answer.set) return answer;
  return {log_.setOf(user, incoming.id), AppendError::none};
}

BatchLogOutcome GymDoor::appendSets(const UserId& user, const SessionId& session, const std::vector<SetWrite>& incoming) {
  const SetBatch batch{session, batchSets(session, incoming), clock_.nowMs()};
  BatchLogOutcome answer;
  std::vector<bool> replayed(batch.sets.size(), false);
  const auto result = execute(user, [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
    answer.session = log_.session(user, session);
    if (!answer.session) { answer.error = BatchLogError::notFound; return std::nullopt; }
    batch.checkInterval(*answer.session, false);
    auto& sql = sync::sqlOf(txn);
    for (const auto index : inIdOrder(batch.sets)) {
      const auto& set = batch.sets[index];
      const auto receipt = setReceipt(sql, set.id);
      if (receipt.empty()) continue;
      if (receipt[0][0].as<std::string>() != user.str() || receipt[0][1].as<std::string>() != gymSetRequestHash(toJson(set), session.str())) {
        answer.error = BatchLogError::payloadConflict;
        answer.errorIndex = index;
        return std::nullopt;
      }
      replayed[index] = true;
    }
    auto value = intent();
    Session standing = *answer.session;
    for (std::size_t index = 0; index < batch.sets.size(); ++index) {
      if (replayed[index]) continue;
      const auto& set = batch.sets[index];
      answer.errorIndex = index;
      if (deletedFromLog(sql, user, set.id)) { answer.error = BatchLogError::deleted; return std::nullopt; }
      const bool late = standing.finishedAtMs && lateSetLands(standing, set.completedAtMs);
      if (standing.finishedAtMs && !late) { answer.error = BatchLogError::finished; return std::nullopt; }
      if (!visibleMovement(sql, user, set.exercise)) { answer.error = BatchLogError::unknownExercise; return std::nullopt; }
      if (late) standing.finishedAtMs = std::max(*standing.finishedAtMs, set.completedAtMs);
      value["d"].append(delta("set", set.id.str(), setFields(set), true));
    }
    answer.errorIndex.reset();
    answer.replayed = value["d"].empty();
    if (answer.replayed) return std::nullopt;
    return value;
  });
  const auto code = refusal(result);
  if (!code.empty()) {
    answer.error = batchRefusal(code);
    if (answer.error == BatchLogError::none) requireOk(result);
    if (result["detail"]["id"].isString())
      for (std::size_t i = 0; i < batch.sets.size(); ++i)
        if (batch.sets[i].id.str() == result["detail"]["id"].asString()) answer.errorIndex = i;
  }
  if (answer.error != BatchLogError::none) return answer;
  answer.session = log_.session(user, session);
  for (std::size_t i = 0; i < batch.sets.size(); ++i) {
    auto current = log_.setOf(user, batch.sets[i].id);
    if (current && current->session != session) current.reset();
    answer.sets.push_back({batch.sets[i].id, current, replayed[i]});
  }
  return answer;
}

BatchLogOutcome GymDoor::importSession(const UserId& user, const SessionImport& incoming) {
  const auto now = clock_.nowMs();
  Session session{incoming.id, user, incoming.startedAtMs, incoming.finishedAtMs, incoming.routine,
                  std::nullopt, ClosedBy::finish};
  if (!canFinishAt(session, incoming.finishedAtMs)) throw InvalidTraining("finishedAt must be at or after startedAt");
  if (incoming.finishedAtMs > now) throw InvalidTraining("finishedAt cannot be in the future");
  const SetBatch batch{incoming.id, batchSets(incoming.id, incoming.sets), now, true};
  batch.checkInterval(session, true);
  closeStale(user);
  Json::Value args = toJson(session);
  args["sets"] = toJson(batch.sets);
  for (auto& set : args["sets"]) set.removeMember("setNumber");
  BatchLogOutcome answer;
  const auto result = execute(user, [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
    auto& sql = sync::sqlOf(txn);
    const auto receipt = sql.exec("select user_id::text,request_hash from gym_write_receipts where kind='session' and id=$1",
                                  pqxx::params{incoming.id.str()});
    if (!receipt.empty()) {
      if (receipt[0][0].as<std::string>() != user.str() || receipt[0][1].as<std::string>() != gymImportRequestHash(args)) {
        answer.error = BatchLogError::payloadConflict;
        return std::nullopt;
      }
      answer.replayed = true;
      answer.session = log_.session(user, incoming.id);
      answer.sessionDeleted = !answer.session;
      return std::nullopt;
    }
    if (incoming.routine && !program_.routine(user, *incoming.routine)) {
      answer.error = BatchLogError::unknownRoutine;
      return std::nullopt;
    }
    for (const auto index : inIdOrder(batch.sets)) {
      const auto& set = batch.sets[index];
      const auto held = setReceipt(sql, set.id);
      if (held.empty()) continue;
      answer.errorIndex = index;
      answer.error = held[0][0].as<std::string>() == user.str() && held[0][1].as<std::string>() == gymSetRequestHash(toJson(set), incoming.id.str())
        ? BatchLogError::idTaken : BatchLogError::payloadConflict;
      return std::nullopt;
    }
    for (std::size_t i = 0; i < batch.sets.size(); ++i) {
      const auto& set = batch.sets[i];
      answer.errorIndex = i;
      if (deletedFromLog(sql, user, set.id)) { answer.error = BatchLogError::deleted; return std::nullopt; }
      if (!visibleMovement(sql, user, set.exercise)) { answer.error = BatchLogError::unknownExercise; return std::nullopt; }
    }
    answer.errorIndex.reset();
    return intent("gym.importSession", args);
  });
  const auto code = refusal(result);
  if (!code.empty()) {
    answer.error = batchRefusal(code);
    if (answer.error == BatchLogError::none) requireOk(result);
    if (code == "session-overlap") answer.overlapping = log_.session(user, SessionId{result["detail"]["sessionId"].asString()});
  }
  if (answer.error != BatchLogError::none) return answer;
  answer.session = log_.session(user, incoming.id);
  for (const auto& set : batch.sets) {
    auto current = log_.setOf(user, set.id);
    if (current && current->session != incoming.id) current.reset();
    answer.sets.push_back({set.id, current, answer.replayed});
  }
  return answer;
}

FinishOutcome GymDoor::finish(const UserId& user, const SessionId& session, std::uint64_t at) {
  Json::Value args(Json::objectValue);
  args["sessionId"] = session.str();
  args["finishedAt"] = Json::UInt64(at);
  FinishOutcome answer{std::nullopt, FinishError::none};
  const auto result = execute(user, [&](sync::SyncTxn&) -> std::optional<Json::Value> {
    const auto stored = log_.session(user, session);
    if (!stored) { answer.error = FinishError::notFound; return std::nullopt; }
    if (!canFinishAt(*stored, at)) { answer.error = FinishError::badInstant; return std::nullopt; }
    return intent("gym.finish", args);
  });
  const auto code = refusal(result);
  if (code == "unknown-record" || code == "record-dead") return {std::nullopt, FinishError::notFound};
  if (code == "bad-instant") return {std::nullopt, FinishError::badInstant};
  requireOk(result);
  if (answer.error != FinishError::none) return answer;
  return {log_.session(user, session), FinishError::none};
}

DiscardOutcome GymDoor::discard(const UserId& user, const SessionId& session) {
  DiscardOutcome answer = DiscardOutcome::done;
  const auto result = execute(user, [&](sync::SyncTxn&) -> std::optional<Json::Value> {
    const auto stored = log_.session(user, session);
    if (!stored) { answer = DiscardOutcome::notFound; return std::nullopt; }
    if (!stored->finishedAtMs) { answer = DiscardOutcome::open; return std::nullopt; }
    auto value = intent();
    value["d"].append(delta("session", session.str(), Json::Value(Json::objectValue), false, true));
    return value;
  });
  const auto code = refusal(result);
  if (code == "unknown-record" || code == "record-dead") return DiscardOutcome::notFound;
  if (code == "session-open") return DiscardOutcome::open;
  requireOk(result);
  return answer;
}

}

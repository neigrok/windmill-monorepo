#include "products/gym/adapters/postgres/PgLogRepository.h"

#include "platform/adapters/json/JsonText.h"
#include "products/gym/adapters/json/TrainingJson.h"

#include <pqxx/pqxx>

namespace wm::gym {
namespace {

std::string historySource(pqxx::transaction_base& txn, const UserId& user) {
  return "SELECT s.id, (extract(epoch from s.started_at)*1000)::bigint AS started_ms, "
      "jsonb_build_object('id',s.id,'startedAt',(extract(epoch from s.started_at)*1000)::bigint,"
      "'finishedAt',(extract(epoch from s.finished_at)*1000)::bigint,"
      "'routineId',coalesce(s.history_routine_id,''),'routineName',coalesce(s.display_name,s.plan->>'routine',''),"
      "'sets',coalesce((SELECT jsonb_agg(jsonb_build_object('id',st.id,'exerciseId',st.exercise_id,"
      "'exercise',coalesce(n.name,e.name),'equipment',e.equipment,'setNumber',st.set_number,'weightKg',st.weight_kg,"
      "'reps',st.reps,'rpe',st.rpe,'completedAt',(extract(epoch from st.completed_at)*1000)::bigint,"
      "'working',st.kind='working') ORDER BY st.completed_at,st.set_number,st.id COLLATE \"C\") "
      "FROM gym_sets st JOIN gym_exercises e ON e.id=st.exercise_id "
      "LEFT JOIN gym_exercise_names n ON n.exercise_id=e.id AND n.user_id=s.user_id "
      "WHERE st.session_id=s.id AND st.user_id=s.user_id),'[]'::jsonb)) AS workout "
      "FROM gym_sessions s WHERE s.user_id=" + txn.quote(user.str()) + "::uuid "
      "AND s.finished_at IS NOT NULL";
}

std::string historyScope(pqxx::transaction_base& txn, const std::string& source,
    const HistoryQuery& query) {
  return "WITH source AS (" + source + "), scope AS MATERIALIZED (SELECT * FROM source WHERE "
      "started_ms >= " + std::to_string(query.fromMs) + " AND started_ms < " +
      std::to_string(query.untilMs) + " AND (" + txn.quote(query.routine) + "='' OR "
      "workout->>'routineId'=" + txn.quote(query.routine) + ") AND (" +
      txn.quote(query.exercise) + "='' OR EXISTS(SELECT 1 FROM jsonb_array_elements(workout->'sets') x "
      "WHERE x->>'exerciseId'=" + txn.quote(query.exercise) + "))) ";
}

HistoryPage readHistory(pqxx::transaction_base& txn, const std::string& source,
    const HistoryQuery& query) {
  if (query.timeZone != "UTC" && txn.exec_params(
      "SELECT 1 FROM pg_timezone_names WHERE name=$1", query.timeZone).empty())
    throw InvalidTraining{"unknown time zone"};
  const std::string scope = historyScope(txn, source, query);
  const std::string progress = query.includeProgress ?
      "(SELECT coalesce(jsonb_agg(jsonb_build_object('sessionId',id,'startedAt',started_ms,'fact',fact) "
      "ORDER BY started_ms,id COLLATE \"C\",(fact->>'exerciseId') COLLATE \"C\",(fact->>'id') COLLATE \"C\") "
      "FILTER (WHERE (fact->>'working')::boolean),'[]') FROM facts)::text" : "'[]'";
  const auto rows = txn.exec(scope +
      ", page AS (SELECT * FROM scope WHERE (started_ms,id COLLATE \"C\") < (" +
      std::to_string(query.beforeMs) + "," + txn.quote(query.beforeId) + " COLLATE \"C\") "
      "ORDER BY started_ms DESC,id COLLATE \"C\" DESC LIMIT " + std::to_string(query.limit + 1) + "), "
      "facts AS MATERIALIZED (SELECT id,started_ms,x AS fact FROM scope "
      "CROSS JOIN LATERAL jsonb_array_elements(workout->'sets') x) "
      "SELECT "
      "(SELECT coalesce(jsonb_agg(workout ORDER BY started_ms DESC,id COLLATE \"C\" DESC),'[]') FROM page)::text AS sessions,"
      "(SELECT count(*)::int FROM scope) AS session_count,"
      "(SELECT count(*)::int FROM facts WHERE (fact->>'working')::boolean) AS set_count,"
      "(SELECT coalesce(sum((fact->>'reps')::int),0)::int FROM facts WHERE (fact->>'working')::boolean) AS reps,"
      "(SELECT coalesce(sum(greatest((fact->>'weightKg')::numeric,0)*(fact->>'reps')::int),0)::float8 "
      "FROM facts WHERE (fact->>'working')::boolean) AS tonnage,"
      "(SELECT coalesce(jsonb_agg(m ORDER BY month DESC),'[]') FROM (SELECT "
      "to_char(to_timestamp(started_ms/1000.0) AT TIME ZONE " + txn.quote(query.timeZone) + ",'YYYY-MM') AS month,count(*)::int AS sessions "
      "FROM scope GROUP BY month) m)::text AS months,"
      "(SELECT coalesce(jsonb_agg(e ORDER BY name,id),'[]') FROM (SELECT fact->>'exerciseId' AS id,"
      "max(fact->>'exercise') AS name,max(fact->>'equipment') AS equipment,count(DISTINCT id)::int AS sessions FROM facts "
      "GROUP BY fact->>'exerciseId') e)::text AS exercises,"
      "(SELECT coalesce(jsonb_agg(r ORDER BY name,id),'[]') FROM (SELECT workout->>'routineId' AS id,"
      "(array_agg(workout->>'routineName' ORDER BY started_ms DESC,id COLLATE \"C\" DESC))[1] AS name,"
      "count(*)::int AS sessions FROM scope WHERE workout->>'routineId'<>'' "
      "GROUP BY workout->>'routineId') r)::text AS routines, " + progress + " AS progress");
  HistoryPage page;
  const auto row = rows[0];
  for (const Json::Value& workout : parse(row["sessions"].as<std::string>()))
    page.sessions.push_back(historyWorkoutFrom(workout));
  page.hasMore = page.sessions.size() > static_cast<std::size_t>(query.limit);
  if (page.hasMore) page.sessions.resize(query.limit);
  page.summary = HistoryTotals{row["session_count"].as<int>(), row["set_count"].as<int>(),
                              row["reps"].as<int>(), row["tonnage"].as<double>()};
  for (const Json::Value& month : parse(row["months"].as<std::string>()))
    page.months.push_back(HistoryMonth{month["month"].asString(), month["sessions"].asInt()});
  for (const Json::Value& facet : parse(row["exercises"].as<std::string>()))
    page.exercises.push_back(HistoryFacet{facet["id"].asString(), facet["name"].asString(),
        facet["sessions"].asInt(), facet["equipment"].isString() ? facet["equipment"].asString() : ""});
  for (const Json::Value& facet : parse(row["routines"].as<std::string>()))
    page.routines.push_back(HistoryFacet{facet["id"].asString(), facet["name"].asString(), facet["sessions"].asInt()});
  if (query.includeProgress) {
    std::vector<ProgressSet> facts;
    for (const Json::Value& row : parse(rows[0]["progress"].as<std::string>())) {
      const auto& fact = row["fact"];
      std::optional<double> rpe;
      if (fact["rpe"].isNumeric()) rpe = fact["rpe"].asDouble();
      facts.push_back(ProgressSet{SessionId{row["sessionId"].asString()}, row["startedAt"].asUInt64(),
          ExerciseId{fact["exerciseId"].asString()}, PerformedFact{SetId{fact["id"].asString()},
          fact["weightKg"].asDouble(), fact["reps"].asInt(), rpe}});
    }
    page.progress = statsProgress(facts, query.asOfMs);
  }
  return page;
}

template <typename Row>
LogShare shareFrom(const Row& row) {
  return LogShare{row["id"].template as<std::string>(), UserId{row["user_id"].template as<std::string>()},
      row["token"].template as<std::string>(),
      row["mode"].template as<std::string>() == "snapshot" ? LogShareMode::snapshot : LogShareMode::live,
      row["scope"].template as<std::string>() == "range", row["from_ms"].template as<std::uint64_t>(),
      row["until_ms"].template as<std::uint64_t>(), row["created_ms"].template as<std::uint64_t>(),
      row["expires_ms"].template as<std::uint64_t>()};
}

}

HistoryPage PgLogRepository::history(const UserId& user, const HistoryQuery& query) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  return readHistory(txn, historySource(txn, user), query);
}

std::optional<LogShare> PgLogRepository::createLogShare(const LogShare& share) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  const auto inserted = txn.exec_params(
      "INSERT INTO gym_log_shares(id,user_id,token,mode,scope,from_ms,until_ms,created_ms,expires_ms) "
      "VALUES($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING RETURNING id",
      share.id, share.user.str(), share.token, share.mode == LogShareMode::snapshot ? "snapshot" : "live",
      share.range ? "range" : "all", share.fromMs, share.untilMs, share.createdAtMs, share.expiresAtMs);
  if (inserted.empty()) {
    const auto held = txn.exec_params("SELECT * FROM gym_log_shares WHERE id=$1 AND user_id=$2::uuid "
        "AND revoked_ms IS NULL AND expires_ms>$3", share.id, share.user.str(), share.createdAtMs);
    if (held.empty()) return std::nullopt;
    const LogShare existing = shareFrom(held[0]);
    if (!existing.sameRequest(share)) return std::nullopt;
    return existing;
  }
  if (share.mode == LogShareMode::snapshot) {
    const auto query = share.constrain(HistoryQuery{});
    txn.exec(historyScope(txn, historySource(txn, share.user), query) +
        "INSERT INTO gym_log_share_sessions(share_id,id,started_ms,workout) SELECT " +
        txn.quote(share.id) + ",id,started_ms,workout FROM scope");
  }
  txn.commit();
  return share;
}

std::vector<LogShare> PgLogRepository::logShares(const UserId& user, std::uint64_t nowMs) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  const auto rows = txn.exec_params("SELECT * FROM gym_log_shares WHERE user_id=$1::uuid "
      "AND revoked_ms IS NULL AND expires_ms>$2 ORDER BY created_ms DESC,id", user.str(), nowMs);
  std::vector<LogShare> shares;
  for (const auto& row : rows) shares.push_back(shareFrom(row));
  return shares;
}

void PgLogRepository::revokeLogShare(const UserId& user, const std::string& id) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  const auto revoked = txn.exec_params("UPDATE gym_log_shares SET revoked_ms=created_ms "
      "WHERE user_id=$1::uuid AND id=$2 AND revoked_ms IS NULL RETURNING id", user.str(), id);
  if (!revoked.empty()) txn.exec_params("DELETE FROM gym_log_share_sessions WHERE share_id=$1", id);
  txn.commit();
}

std::optional<SharedHistory> PgLogRepository::sharedHistory(const std::string& token,
    const HistoryQuery& query, std::uint64_t nowMs) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  const auto rows = txn.exec_params("SELECT * FROM gym_log_shares WHERE token=$1 AND revoked_ms IS NULL "
      "AND expires_ms>$2 FOR SHARE", token, nowMs);
  if (rows.empty()) return std::nullopt;
  const LogShare share = shareFrom(rows[0]);
  const std::string source = share.mode == LogShareMode::live ? historySource(txn, share.user) :
      "SELECT id,started_ms,workout FROM gym_log_share_sessions WHERE share_id=" + txn.quote(share.id);
  return SharedHistory{share, readHistory(txn, source, share.constrain(query))};
}

}

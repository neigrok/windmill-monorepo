#include "products/roadmap/adapters/postgres/PgTendRunRepository.h"

#include "platform/adapters/postgres/PgPool.h"

#include <json/json.h>
#include <pqxx/pqxx>

#include <sstream>
#include <string_view>

namespace wm {

namespace {
constexpr std::string_view kTendRunColumns =
    "id, tree_id, coalesce(user_id::text, '') AS user_id, prompt, status, refusal, summary, "
    "detail, edits, seq_from, seq_to, started_at, finished_at, created_node_ids";

// The created-ids column round-trips as a JSON array of strings — jsonb read back as text on the
// way out, and written as text cast to jsonb on the way in (the save below).
std::vector<std::string> parseIdArray(const std::string& json) {
  std::vector<std::string> ids;
  Json::Value root;
  Json::CharReaderBuilder builder;
  std::string errs;
  std::istringstream stream(json);
  if (Json::parseFromStream(builder, stream, &root, &errs) && root.isArray())
    for (const Json::Value& id : root) ids.push_back(id.asString());
  return ids;
}

std::string writeIdArray(const std::vector<std::string>& ids) {
  Json::Value array(Json::arrayValue);
  for (const std::string& id : ids) array.append(id);
  Json::StreamWriterBuilder builder;
  builder["indentation"] = "";
  return Json::writeString(builder, array);
}

// The inverse of tendStatusName / tendRefusalName (domain/Tending.h). The name→enum direction
// lives here, at the read boundary, because it is only ever needed when a row comes back off
// the wire — the domain owns the enum→name direction the writers use.
TendStatus tendStatusFrom(const std::string& name) {
  if (name == "running") return TendStatus::running;
  if (name == "done")    return TendStatus::done;
  if (name == "refused") return TendStatus::refused;
  return TendStatus::failed;  // an unknown status reads as failed rather than a lie of success
}

TendRefusal tendRefusalFrom(const std::string& name) {
  if (name == "not-enabled")      return TendRefusal::notEnabled;
  if (name == "rate-limited")     return TendRefusal::rateLimited;
  if (name == "out-of-allowance") return TendRefusal::outOfAllowance;
  if (name == "out-of-budget")    return TendRefusal::outOfBudget;
  if (name == "tree-too-large")   return TendRefusal::treeTooLarge;
  if (name == "prompt-empty")     return TendRefusal::promptEmpty;
  if (name == "prompt-too-long")  return TendRefusal::promptTooLong;
  return TendRefusal::none;
}

// Templated on the row type: pqxx names it row_ref on macOS and row on the CI's Linux build, so
// binding it concretely compiles on one and fails on the other.
template <typename Row>
TendRun tendRunFrom(const Row& row) {
  TendRun run;
  run.id = row["id"].template as<std::string>();
  run.tree = TreeId{row["tree_id"].template as<std::string>()};
  run.user = UserId{row["user_id"].template as<std::string>()};
  run.prompt = row["prompt"].template as<std::string>();
  run.status = tendStatusFrom(row["status"].template as<std::string>());
  run.refusal = tendRefusalFrom(row["refusal"].template as<std::string>());
  run.summary = row["summary"].template as<std::string>();
  run.detail = row["detail"].template as<std::string>();
  run.edits = row["edits"].template as<int>();
  run.seqFrom = row["seq_from"].template as<std::uint64_t>();
  run.seqTo = row["seq_to"].template as<std::uint64_t>();
  run.startedAtMs = row["started_at"].template as<std::uint64_t>();
  run.finishedAtMs = row["finished_at"].template as<std::uint64_t>();
  run.createdNodeIds = parseIdArray(row["created_node_ids"].template as<std::string>());
  return run;
}
}

PgTendRunRepository::PgTendRunRepository(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}

void PgTendRunRepository::save(const TendRun& run) {
  // Upsert keyed on the run id: start() writes the `running` row, the worker overwrites it with
  // the terminal one. The id never changes, so every field but it is refreshed to the latest.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec("INSERT INTO tend_runs "
           "(id, tree_id, user_id, prompt, status, refusal, summary, detail, edits, "
           "seq_from, seq_to, started_at, finished_at, created_node_ids) "
           "VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb) "
           "ON CONFLICT (id) DO UPDATE SET "
           "status = excluded.status, refusal = excluded.refusal, summary = excluded.summary, "
           "detail = excluded.detail, edits = excluded.edits, seq_from = excluded.seq_from, "
           "seq_to = excluded.seq_to, started_at = excluded.started_at, "
           "finished_at = excluded.finished_at, created_node_ids = excluded.created_node_ids",
           pqxx::params{run.id, run.tree.str(), run.user.str(), run.prompt,
                        tendStatusName(run.status), tendRefusalName(run.refusal), run.summary,
                        run.detail, run.edits, run.seqFrom, run.seqTo, run.startedAtMs,
                        run.finishedAtMs, writeIdArray(run.createdNodeIds)});
  txn.commit();
}

std::optional<TendRun> PgTendRunRepository::find(const std::string& id) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows =
      txn.exec_params("SELECT " + std::string(kTendRunColumns) + " FROM tend_runs WHERE id = $1", id);
  if (rows.empty()) return std::nullopt;
  return tendRunFrom(rows[0]);
}

int PgTendRunRepository::failOrphanedRuns() {
  // Every `running` row at startup was orphaned by the restart (a run lives on this process's
  // worker thread), so settle them all to `failed` with a plain diagnostic. finished_at is stamped
  // from the DB clock — no Clock dependency for a one-shot boot sweep.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result result = txn.exec(
      "UPDATE tend_runs SET status = 'failed', "
      "detail = CASE WHEN detail = '' THEN 'interrupted — the run did not survive a restart' ELSE detail END, "
      "finished_at = (extract(epoch from now()) * 1000)::bigint "
      "WHERE status = 'running'");
  txn.commit();
  return static_cast<int>(result.affected_rows());
}

int PgTendRunRepository::countForUser(const UserId& user, std::uint64_t sinceMs) {
  // The allowance read: runs this user started within the window. An agent loop is expensive, so
  // this is the real brake on a single account — counted over started_at, the indexed column.
  // Read through pqxx::result (never a bare row: pqxx names it row_ref on macOS, row on CI Linux).
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      // Only runs that actually started work count against the day's allowance — a refusal (blank
      // prompt, the dark-launch "not turned on" tap, an over-length paste) costs nothing, so
      // counting it would let someone lock themselves out for free, or pre-spend the allowance on
      // taps made while the feature was still dark.
      "SELECT count(*) AS n FROM tend_runs "
      "WHERE user_id = $1::uuid AND started_at >= $2 AND status <> 'refused'",
      user.str(), sinceMs);
  return rows[0]["n"].as<int>();
}

std::vector<TendRun> PgTendRunRepository::recentForUser(const UserId& user, std::uint64_t sinceMs,
                                                        int limit) {
  // The ledger read, newest first: the same window and refusal exclusion as the count, so the
  // receipts the user reads are exactly the runs the meter counted spent.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kTendRunColumns) + " FROM tend_runs "
      "WHERE user_id = $1::uuid AND started_at >= $2 AND status <> 'refused' "
      "ORDER BY started_at DESC LIMIT $3",
      user.str(), sinceMs, limit);
  std::vector<TendRun> out;
  out.reserve(rows.size());
  for (const auto& row : rows) out.push_back(tendRunFrom(row));
  return out;
}

}

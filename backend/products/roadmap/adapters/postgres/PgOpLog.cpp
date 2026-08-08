#include "products/roadmap/adapters/postgres/PgOpLog.h"

#include "products/roadmap/adapters/json/CommandJson.h"
#include "products/roadmap/adapters/json/TreeJson.h"
#include "platform/adapters/postgres/PgPool.h"

#include <pqxx/pqxx>

namespace wm {

namespace {
constexpr int kOpReadLimit = 10000;  // cap one replay read so a giant op log can't be slurped whole
}

PgOpLog::PgOpLog(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}

void PgOpLog::append(const TreeId& tree, const AppliedOp& op) {
  std::string payload = dump(commandPayload(op.command));
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params(
      "INSERT INTO tree_ops (tree_id, seq, actor_id, op_id, kind, payload, hlc) "
      "VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) ON CONFLICT (tree_id, op_id) DO NOTHING",
      tree.str(), static_cast<long long>(op.seq), op.actor.str(), op.opId,
      commandKind(op.command), payload, toString(op.hlc));
  txn.commit();
}

std::vector<AppliedOp> PgOpLog::since(const TreeId& tree, Seq afterSeq) const {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT seq, actor_id, op_id, kind, payload::text, hlc, "
      "(extract(epoch from created_at) * 1000)::bigint AS created_ms FROM tree_ops "
      "WHERE tree_id = $1 AND seq > $2 ORDER BY seq LIMIT $3",
      tree.str(), static_cast<long long>(afterSeq), kOpReadLimit);

  std::vector<AppliedOp> ops;
  for (const auto& row : rows) {
    std::optional<Command> command = commandFromJson(row["kind"].as<std::string>(), parse(row["payload"].as<std::string>()));
    if (!command) continue;
    AppliedOp op;
    op.seq = static_cast<Seq>(row["seq"].as<long long>());
    op.opId = row["op_id"].as<std::string>();
    op.command = std::move(*command);
    op.hlc = parseHlc(row["hlc"].as<std::string>());
    op.actor = UserId{row["actor_id"].as<std::string>()};
    op.createdAtMs = static_cast<std::uint64_t>(row["created_ms"].as<long long>());
    ops.push_back(std::move(op));
  }
  return ops;
}

}

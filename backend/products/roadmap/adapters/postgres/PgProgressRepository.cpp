#include "products/roadmap/adapters/postgres/PgProgressRepository.h"

#include "platform/adapters/postgres/PgPool.h"

#include <pqxx/pqxx>

namespace wm {

namespace {
std::string hlcText(const Hlc& at) {
  return std::to_string(at.physicalMs) + ":" + std::to_string(at.counter) + ":" + at.actor;
}
}

PgProgressRepository::PgProgressRepository(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}

Progress PgProgressRepository::load(const TreeId& tree, const UserId& user) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT node_id, status, hlc, (extract(epoch from updated_at) * 1000)::bigint AS updated_ms "
      "FROM node_progress WHERE tree_id = $1 AND user_id = $2",
      tree.str(), user.str());

  Progress progress;
  for (const auto& row : rows) {
    ProgressMark mark;
    mark.status = parseProgressStatus(row["status"].as<std::string>()).value_or(ProgressStatus::none);
    mark.at = parseHlc(row["hlc"].as<std::string>());
    // The server's own clock, not the marking device's: the HLC beside it orders writes but cannot
    // be asserted back to a reader as a time.
    mark.markedAt = static_cast<std::uint64_t>(row["updated_ms"].as<long long>());
    progress.record(NodeId{row["node_id"].as<std::string>()}, mark);
  }
  return progress;
}

std::map<TreeId, ProgressDigest> PgProgressRepository::overlaysFor(const UserId& user) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT tree_id, node_id, status, (extract(epoch from updated_at) * 1000)::bigint AS updated_ms "
      "FROM node_progress WHERE user_id = $1",
      user.str());

  std::map<TreeId, ProgressDigest> overlays;
  for (const auto& row : rows) {
    ProgressDigest& digest = overlays[TreeId{row["tree_id"].as<std::string>()}];
    NodeId node{row["node_id"].as<std::string>()};
    std::string status = row["status"].as<std::string>();
    if (status == "complete") digest.overlay.completed.insert(node);
    else if (status == "active") digest.overlay.inProgress.insert(node);
    auto markedAt = static_cast<std::uint64_t>(row["updated_ms"].as<long long>());
    if (markedAt > digest.lastMarkedAt) digest.lastMarkedAt = markedAt;
  }
  return overlays;
}

bool PgProgressRepository::setStatus(const TreeId& tree, const UserId& user, const NodeId& node,
                                     ProgressStatus status, const Hlc& at, std::uint64_t receivedAtMs) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};

  // A clear ('none') is a stamped value, not a row delete, so a stale mark can never resurrect
  // the node. The upsert lands only when the incoming stamp strictly beats the stored one.
  pqxx::result result = txn.exec_params(
      "INSERT INTO node_progress (tree_id, user_id, node_id, status, hlc, stamp_ms, stamp_counter, updated_at) "
      "VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0)) "
      "ON CONFLICT (tree_id, user_id, node_id) DO UPDATE SET status = EXCLUDED.status, hlc = EXCLUDED.hlc, "
      "stamp_ms = EXCLUDED.stamp_ms, stamp_counter = EXCLUDED.stamp_counter, updated_at = EXCLUDED.updated_at "
      "WHERE (EXCLUDED.stamp_ms, EXCLUDED.stamp_counter) > (node_progress.stamp_ms, node_progress.stamp_counter)",
      tree.str(), user.str(), node.str(), progressStatusName(status), hlcText(at),
      static_cast<long long>(at.physicalMs), static_cast<long long>(at.counter),
      static_cast<long long>(receivedAtMs));
  txn.commit();
  // The WHERE clause is the merge: no row touched means a strictly-later stamp already stood.
  return result.affected_rows() == 1;
}

}

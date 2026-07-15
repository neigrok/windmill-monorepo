#include "adapters/postgres/PgProgressRepository.h"

#include "adapters/postgres/PgConnection.h"

#include <pqxx/pqxx>

namespace wm {

namespace {
std::string hlcText(const Hlc& at) {
  return std::to_string(at.physicalMs) + ":" + std::to_string(at.counter) + ":" + at.actor;
}
}

PgProgressRepository::PgProgressRepository(std::string connString) : connString_(std::move(connString)) {}

Progress PgProgressRepository::load(const TreeId& tree, const UserId& user) {
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT node_id, status FROM node_progress WHERE tree_id = $1 AND user_id = $2",
      tree.str(), user.str());

  Progress progress;
  for (const auto& row : rows) {
    NodeId node{row["node_id"].as<std::string>()};
    std::string status = row["status"].as<std::string>();
    if (status == "complete") progress.completed.insert(node);
    else if (status == "active") progress.inProgress.insert(node);
  }
  return progress;
}

std::map<TreeId, ProgressDigest> PgProgressRepository::overlaysFor(const UserId& user) {
  pqxx::work txn{pgThreadConnection(connString_)};
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

void PgProgressRepository::setStatus(const TreeId& tree, const UserId& user, const NodeId& node,
                                     ProgressStatus status, const Hlc& at) {
  pqxx::work txn{pgThreadConnection(connString_)};

  // A clear ('none') is a stamped value, not a row delete — so it converges like any status and
  // a stale mark can never resurrect the node. The upsert is true last-writer-wins: it only
  // takes effect when the incoming stamp strictly beats the stored one.
  txn.exec_params(
      "INSERT INTO node_progress (tree_id, user_id, node_id, status, hlc, stamp_ms, stamp_counter, updated_at) "
      "VALUES ($1, $2, $3, $4, $5, $6, $7, now()) "
      "ON CONFLICT (tree_id, user_id, node_id) DO UPDATE SET status = EXCLUDED.status, hlc = EXCLUDED.hlc, "
      "stamp_ms = EXCLUDED.stamp_ms, stamp_counter = EXCLUDED.stamp_counter, updated_at = now() "
      "WHERE (EXCLUDED.stamp_ms, EXCLUDED.stamp_counter) > (node_progress.stamp_ms, node_progress.stamp_counter)",
      tree.str(), user.str(), node.str(), progressStatusName(status), hlcText(at),
      static_cast<long long>(at.physicalMs), static_cast<long long>(at.counter));
  txn.commit();
}

}

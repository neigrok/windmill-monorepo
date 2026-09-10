#include "products/roadmap/adapters/postgres/PgProgressRepository.h"

#include "platform/adapters/postgres/PgPool.h"

#include <pqxx/pqxx>

#include <algorithm>
#include <numeric>

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
      "SELECT node_id, status, out_of_order, hlc, (extract(epoch from updated_at) * 1000)::bigint AS updated_ms "
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
    mark.outOfOrder = mark.status == ProgressStatus::complete && row["out_of_order"].as<bool>();
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
    auto markedAt = static_cast<std::uint64_t>(row["updated_ms"].as<long long>());
    if (markedAt > digest.lastMarkedAt) digest.lastMarkedAt = markedAt;
  }
  return overlays;
}

bool PgProgressRepository::setStatus(const TreeId& tree, const UserId& user, const NodeId& node,
                                     ProgressStatus status, bool outOfOrder, const Hlc& at, std::uint64_t receivedAtMs) {
  return setStatuses(tree, user, {{node, status, outOfOrder, at}}, receivedAtMs).front();
}

std::vector<bool> PgProgressRepository::setStatuses(const TreeId& tree, const UserId& user,
                                                   const std::vector<ProgressUpdate>& updates,
                                                   std::uint64_t receivedAtMs) {
  std::vector<bool> applied(updates.size(), false);
  if (updates.empty()) return applied;
  std::vector<std::size_t> order(updates.size());
  std::iota(order.begin(), order.end(), 0);
  std::stable_sort(order.begin(), order.end(), [&](std::size_t left, std::size_t right) {
    return updates[left].node < updates[right].node;
  });
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  for (const std::size_t index : order) {
    const ProgressUpdate& update = updates[index];
    const pqxx::result result = txn.exec_params(
        "INSERT INTO node_progress (tree_id, user_id, node_id, status, out_of_order, hlc, stamp_ms, stamp_counter, updated_at) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9 / 1000.0)) "
        "ON CONFLICT (tree_id, user_id, node_id) DO UPDATE SET status = EXCLUDED.status, "
        "out_of_order = EXCLUDED.out_of_order, hlc = EXCLUDED.hlc, "
        "stamp_ms = EXCLUDED.stamp_ms, stamp_counter = EXCLUDED.stamp_counter, updated_at = EXCLUDED.updated_at "
        "WHERE (EXCLUDED.stamp_ms, EXCLUDED.stamp_counter) > (node_progress.stamp_ms, node_progress.stamp_counter)",
        tree.str(), user.str(), update.node.str(), progressStatusName(update.status), update.outOfOrder, hlcText(update.at),
        static_cast<long long>(update.at.physicalMs), static_cast<long long>(update.at.counter),
        static_cast<long long>(receivedAtMs));
    applied[index] = result.affected_rows() == 1;
  }
  txn.commit();
  return applied;
}

}

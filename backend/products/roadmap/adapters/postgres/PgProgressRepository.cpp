#include "products/roadmap/adapters/postgres/PgProgressRepository.h"

#include "platform/adapters/postgres/PgPool.h"

#include <pqxx/pqxx>
#include <stdexcept>

#include <algorithm>
#include <numeric>

namespace wm {

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
    mark.at = roadmapStamp(row["hlc"].as<std::string>());
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
  return setStatuses(tree, user, {{node, status, outOfOrder, at}}, StampedBy::replica, receivedAtMs).front().landed.has_value();
}

std::vector<ProgressWritten> PgProgressRepository::setStatuses(const TreeId& tree, const UserId& user,
                                                               const std::vector<ProgressUpdate>& updates,
                                                               StampedBy stampedBy, std::uint64_t receivedAtMs) {
  std::vector<ProgressWritten> written(updates.size());
  if (updates.empty()) return written;
  std::vector<std::size_t> order(updates.size());
  std::iota(order.begin(), order.end(), 0);
  std::stable_sort(order.begin(), order.end(), [&](std::size_t left, std::size_t right) {
    return updates[left].node < updates[right].node;
  });
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  if (txn.exec_params("SELECT id FROM users WHERE id=$1::uuid FOR KEY SHARE", user.str()).empty())
    throw std::runtime_error("account no longer exists");
  for (const std::size_t index : order) {
    const ProgressUpdate& update = updates[index];
    // One statement reads the row and writes it. `held` locks the row before the insert reads it — the insert selects
    // from it, so it runs first — and a write another door committed since this statement began is the row it locks, so
    // what is answered as held is what the write met. The stamp a server's mark takes is worked out against the row the
    // update holds, never one read earlier. A row the insert updated without `held` having seen it (xmax is set on an
    // updated row and not on an inserted one) was put there since this statement began: its mark cannot be answered.
    const pqxx::result result = txn.exec_params(
        "WITH held AS ("
        "  SELECT status, out_of_order, hlc FROM node_progress"
        "  WHERE tree_id = $1 AND user_id = $2 AND node_id = $3 FOR UPDATE"
        "), written AS ("
        "  INSERT INTO node_progress AS kept"
        "    (tree_id, user_id, node_id, status, out_of_order, hlc, stamp_ms, stamp_counter, updated_at)"
        "  SELECT $1::text, $2::text, $3::text, $4::text, $5::boolean, $6::bigint || ':' || $7::bigint || ':' || $8::text,"
        "         $6::bigint, $7::bigint, to_timestamp($9::bigint / 1000.0)"
        "  FROM (SELECT count(*) FROM held) AS locked"
        "  ON CONFLICT (tree_id, user_id, node_id) DO UPDATE SET"
        "    status = EXCLUDED.status, out_of_order = EXCLUDED.out_of_order, updated_at = EXCLUDED.updated_at,"
        "    (stamp_ms, stamp_counter, hlc) = ("
        "      SELECT took.ms, took.counter, took.ms || ':' || took.counter || ':' || $8::text FROM ("
        "        SELECT CASE WHEN (EXCLUDED.stamp_ms, EXCLUDED.stamp_counter) > (kept.stamp_ms, kept.stamp_counter)"
        "                      THEN EXCLUDED.stamp_ms"
        "                    WHEN kept.stamp_counter >= 4294967295 THEN kept.stamp_ms + 1 ELSE kept.stamp_ms END AS ms,"
        "               CASE WHEN (EXCLUDED.stamp_ms, EXCLUDED.stamp_counter) > (kept.stamp_ms, kept.stamp_counter)"
        "                      THEN EXCLUDED.stamp_counter"
        "                    WHEN kept.stamp_counter >= 4294967295 THEN 0 ELSE kept.stamp_counter + 1 END AS counter"
        "      ) AS took)"
        "  WHERE $10::boolean OR (EXCLUDED.stamp_ms, EXCLUDED.stamp_counter) > (kept.stamp_ms, kept.stamp_counter)"
        "  RETURNING stamp_ms, stamp_counter, (xmax = 0) AS inserted"
        ") SELECT held.status AS held_status, held.out_of_order AS held_word, held.hlc AS held_hlc,"
        "         written.stamp_ms, written.stamp_counter, written.inserted"
        "  FROM (SELECT 1) AS one LEFT JOIN held ON true LEFT JOIN written ON true",
        tree.str(), user.str(), update.node.str(), progressStatusName(update.status), update.outOfOrder,
        static_cast<long long>(update.at.physicalMs), static_cast<long long>(update.at.counter), update.at.actor,
        static_cast<long long>(receivedAtMs), stampedBy == StampedBy::server);
    const auto& row = result[0];
    ProgressWritten& did = written[index];
    if (!row["held_status"].is_null()) {
      ProgressMark held;
      held.status = parseProgressStatus(row["held_status"].as<std::string>()).value_or(ProgressStatus::none);
      held.at = roadmapStamp(row["held_hlc"].as<std::string>());
      held.outOfOrder = held.status == ProgressStatus::complete && row["held_word"].as<bool>();
      did.held = held;
    } else if (!row["inserted"].is_null() && row["inserted"].as<bool>()) {
      did.held = ProgressMark{};
    }
    if (!row["stamp_ms"].is_null())
      did.landed = ProgressMark{update.status,
                                Hlc{static_cast<std::uint64_t>(row["stamp_ms"].as<long long>()),
                                    static_cast<std::uint32_t>(row["stamp_counter"].as<long long>()), update.at.actor},
                                receivedAtMs, update.outOfOrder};
  }
  txn.commit();
  return written;
}

}

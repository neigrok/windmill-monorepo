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

void PgProgressRepository::setStatus(const TreeId& tree, const UserId& user, const NodeId& node,
                                     ProgressStatus status, const Hlc& at) {
  pqxx::work txn{pgThreadConnection(connString_)};

  if (status == ProgressStatus::none) {
    txn.exec_params("DELETE FROM node_progress WHERE tree_id = $1 AND user_id = $2 AND node_id = $3",
                    tree.str(), user.str(), node.str());
    txn.commit();
    return;
  }

  std::string label = status == ProgressStatus::complete ? "complete" : "active";
  txn.exec_params(
      "INSERT INTO node_progress (tree_id, user_id, node_id, status, hlc, updated_at) "
      "VALUES ($1, $2, $3, $4, $5, now()) "
      "ON CONFLICT (tree_id, user_id, node_id) DO UPDATE SET status = EXCLUDED.status, "
      "hlc = EXCLUDED.hlc, updated_at = now()",
      tree.str(), user.str(), node.str(), label, hlcText(at));
  txn.commit();
}

}

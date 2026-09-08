#include "products/roadmap/adapters/postgres/PgProgressRepository.h"

#include "test/PgTestPool.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <cstdlib>
#include <set>
#include <string>

// The per-user overlay against the real table: opt-in, runs only when WM_PG_TEST is set.
using namespace wm;

namespace {

const char* kNeedsPostgres = "WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7";
const TreeId kTree{std::string("pgtest-progress")};
const UserId kUser{std::string("pgtest-progress-user")};
constexpr std::uint64_t kNow = 1'700'000'000'000ull;

Hlc at(std::uint64_t ms) { return Hlc{ms, 0, "r_pg"}; }

void reset() {
  PgLease conn{*pgTestPool()};
  pqxx::work txn{*conn};
  txn.exec_params("DELETE FROM node_progress WHERE tree_id = $1", kTree.str());
  txn.commit();
}

}

// The marker's word lands under the status stamp: a stale write cannot take it off, a later mark
// without it does.
TEST(pg_progress_keeps_the_out_of_order_word_under_the_status_stamp) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgressRepository repo{pgTestPool()};
  const NodeId node{std::string("n")};

  CHECK(repo.setStatus(kTree, kUser, node, ProgressStatus::complete, true, at(10), kNow));
  Progress loaded = repo.load(kTree, kUser);
  CHECK_EQ(loaded.completed, (std::set<NodeId>{node}));
  CHECK_EQ(loaded.marks.at(node).at, at(10));
  CHECK_EQ(loaded.marks.at(node).markedAt, kNow);
  CHECK(loaded.marks.at(node).outOfOrder);

  CHECK_FALSE(repo.setStatus(kTree, kUser, node, ProgressStatus::complete, false, at(9), kNow + 1));
  CHECK(repo.load(kTree, kUser).marks.at(node).outOfOrder);

  CHECK(repo.setStatus(kTree, kUser, node, ProgressStatus::complete, false, at(11), kNow + 2));
  loaded = repo.load(kTree, kUser);
  CHECK_EQ(loaded.completed, (std::set<NodeId>{node}));
  CHECK_EQ(loaded.marks.at(node).at, at(11));
  CHECK_FALSE(loaded.marks.at(node).outOfOrder);

  CHECK(repo.setStatus(kTree, kUser, node, ProgressStatus::none, false, at(12), kNow + 3));
  loaded = repo.load(kTree, kUser);
  CHECK_EQ(loaded.cleared, (std::set<NodeId>{node}));
  CHECK_FALSE(loaded.marks.at(node).outOfOrder);
  reset();
}

TEST(pg_progress_batch_rolls_back_a_late_storage_failure_and_preserves_outcome_order) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgressRepository repo{pgTestPool()};
  bool failed = false;
  try {
    repo.setStatuses(kTree, kUser, {
        {NodeId{"a"}, ProgressStatus::complete, false, Hlc{20, 0, "good"}},
        {NodeId{"z"}, ProgressStatus::active, false, Hlc{20, 0, std::string(1, '\xff')}}}, kNow);
  } catch (const std::exception&) { failed = true; }
  CHECK(failed);
  CHECK(repo.load(kTree, kUser).marks.empty());
  CHECK(repo.setStatus(kTree, kUser, NodeId{"a"}, ProgressStatus::complete, false, at(50), kNow));
  const auto applied = repo.setStatuses(kTree, kUser, {
      {NodeId{"z"}, ProgressStatus::active, false, at(60)},
      {NodeId{"a"}, ProgressStatus::none, false, at(40)}}, kNow);
  CHECK_EQ(applied, (std::vector<bool>{true, false}));
  CHECK_EQ(repo.load(kTree, kUser).completed, (std::set<NodeId>{NodeId{"a"}}));
  CHECK_EQ(repo.load(kTree, kUser).inProgress, (std::set<NodeId>{NodeId{"z"}}));
  reset();
}

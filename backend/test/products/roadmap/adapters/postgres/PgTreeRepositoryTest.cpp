#include "products/roadmap/adapters/postgres/PgTreeRepository.h"

#include "platform/adapters/postgres/PgAuthRepository.h"
#include "products/roadmap/adapters/postgres/PgOpLog.h"
#include "products/roadmap/application/ForkService.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "test/PgTestPool.h"
#include "test/platform/Fakes.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <chrono>
#include <cstdlib>
#include <string>
#include <vector>

// A tree whose row is gone stays gone, whatever its live room still holds: opt-in, runs only when WM_PG_TEST is set.
using namespace wm;
using namespace wm::fake;

namespace {

const char* kNeedsPostgres = "WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7";
const TreeId kTree{std::string("t_pgtest_erased_room")};
const UserId kSam{std::string("5a5a0000-0000-4000-8000-0000000e05e5")};
const UserId kEve{std::string("e7e00000-0000-4000-8000-0000000e05e5")};

void reset() {
  PgLease conn{*pgTestPool()};
  pqxx::work txn{*conn};
  for (const char* table : {"tree_ops", "tree_nodes", "tree_edges", "tree_kinds", "node_progress", "trees"})
    txn.exec_params(std::string("DELETE FROM ") + table + (std::string(table) == "trees" ? " WHERE id = $1" : " WHERE tree_id = $1"),
                    kTree.str());
  txn.exec_params("DELETE FROM users WHERE id IN ($1::uuid, $2::uuid)", kSam.str(), kEve.str());
  txn.exec_params("INSERT INTO users (id, email) VALUES ($1::uuid, 'erased-room-sam@example.test'), "
                  "($2::uuid, 'erased-room-eve@example.test')",
                  kSam.str(), kEve.str());
  txn.commit();
}

long rowsOfTheTree() {
  PgLease conn{*pgTestPool()};
  pqxx::work txn{*conn};
  return txn.exec_params("SELECT (SELECT count(*) FROM trees WHERE id = $1) + (SELECT count(*) FROM tree_nodes WHERE tree_id = $1) "
                         "+ (SELECT count(*) FROM tree_ops WHERE tree_id = $1)",
                         kTree.str())[0][0].as<long>();
}

}

TEST(pg_an_erased_accounts_live_room_is_retired_so_its_tree_is_neither_served_nor_forked_nor_saved_back) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTreeRepository trees{pgTestPool()};
  PgOpLog log{pgTestPool()};
  FakeBus bus;
  RoomRegistry registry(trees, log, bus);
  std::vector<std::string> announced;
  registry.whenAccessChanges([&](const TreeId& tree) { announced.push_back(tree.str()); });
  trees.create(kTree, LooseGraph().exportState(), LegendState{}, "Sam's public tree", kSam);
  registry.setVisibility(kTree, Visibility::public_);
  registry.open(kTree)->applyCommand(createNode("a"), 10, kSam);  // a live room with an unsaved edit
  announced.clear();

  AccountErasure roadmap = roadmapAccountErasure();
  roadmap.committed = [&registry](const std::vector<std::string>& erased) { registry.retireErased(erased); };
  PgAuthRepository accounts{pgTestPool(), nullptr, {roadmap}};
  accounts.markUserDeleted(kSam, 1, 2);
  REQUIRE(accounts.eraseAccount(kSam, 2));

  CHECK_FALSE(registry.isOpen(kTree));
  CHECK_EQ(announced, std::vector<std::string>{kTree.str()});
  CHECK_FALSE(registry.accessOf(kTree).has_value());
  FakeTokens tokens;
  ForkService forks{registry, trees, tokens};
  CHECK(forks.fork(kTree, "", "", kEve).outcome == ForkService::Outcome::noSource);
  registry.sweep(std::chrono::steady_clock::duration::zero());
  CHECK_EQ(rowsOfTheTree(), 0L);
}

TEST(pg_a_room_whose_tree_row_was_deleted_under_it_saves_nothing_back_on_eviction) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTreeRepository trees{pgTestPool()};
  PgOpLog log{pgTestPool()};
  FakeBus bus;
  RoomRegistry registry(trees, log, bus);
  trees.create(kTree, LooseGraph().exportState(), LegendState{}, "Sam's tree", kSam);
  registry.open(kTree)->applyCommand(createNode("a"), 10, kSam);
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec_params("DELETE FROM trees WHERE id = $1", kTree.str());
    txn.commit();
  }

  registry.evict(kTree);

  CHECK_FALSE(registry.isOpen(kTree));
  CHECK_EQ(rowsOfTheTree(), 0L);
  CHECK_FALSE(trees.load(kTree).has_value());
}

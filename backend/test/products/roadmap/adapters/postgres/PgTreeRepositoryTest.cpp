#include "products/roadmap/adapters/postgres/PgTreeRepository.h"

#include "platform/adapters/postgres/PgAuthRepository.h"
#include "products/roadmap/adapters/postgres/PgOpLog.h"
#include "products/roadmap/application/ForkService.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/domain/Command.h"
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
const TreeId kFork{std::string("t_pgtest_guide_fork")};
const UserId kSam{std::string("5a5a0000-0000-4000-8000-0000000e05e5")};
const UserId kEve{std::string("e7e00000-0000-4000-8000-0000000e05e5")};

void reset() {
  PgLease conn{*pgTestPool()};
  pqxx::work txn{*conn};
  for (const TreeId& tree : {kTree, kFork})
    for (const char* table : {"tree_ops", "tree_nodes", "tree_edges", "tree_kinds", "node_progress", "trees"})
      txn.exec_params(std::string("DELETE FROM ") + table + (std::string(table) == "trees" ? " WHERE id = $1" : " WHERE tree_id = $1"),
                      tree.str());
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
  FakeClock clock;
  ForkService forks{registry, trees, tokens, clock};
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

TEST(pg_a_guide_survives_a_restart_and_a_stale_save_cannot_revert_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  std::string guide = "Rig first, then sail. ";  // past 5000 bytes, at the 5000-character cap
  while (codePointCount(guide) < kMaxGuideChars) guide += "\xF0\x9F\x98\x80";
  REQUIRE_EQ(codePointCount(guide), kMaxGuideChars);
  {
    PgTreeRepository trees{pgTestPool()};
    PgOpLog log{pgTestPool()};
    FakeBus bus;
    RoomRegistry registry(trees, log, bus);
    trees.create(kTree, LooseGraph().exportState(), LegendState{}, "Sam's tree", kSam);
    registry.open(kTree)->setGuide(guide, 1'700'000'000'000);
    registry.persist(kTree);
  }

  PgTreeRepository restarted{pgTestPool()};
  PgOpLog log{pgTestPool()};
  FakeBus bus;
  RoomRegistry registry(restarted, log, bus);
  const Lww<std::string> stored{guide, Hlc{1'700'000'000'000, 0, "srv"}};
  CHECK(registry.open(kTree)->guide() == stored);
  CHECK(log.since(kTree, 0).empty());

  const std::optional<StoredTree> before = restarted.load(kTree);
  REQUIRE(before.has_value());
  CHECK(restarted.save(kTree, GraphState{}, LegendState{}, before->title,
                       Lww<std::string>{"An older guide", Hlc{1'699'999'999'000, 0, "r_a"}}, before->head));
  CHECK(restarted.load(kTree)->guide == stored);
  CHECK(restarted.save(kTree, GraphState{}, LegendState{}, before->title,
                       Lww<std::string>{"", Hlc{1'700'000'000'000, 0, "zz"}}, before->head));
  CHECK(restarted.load(kTree)->guide == (Lww<std::string>{"", Hlc{1'700'000'000'000, 0, "zz"}}));
  CHECK_EQ(restarted.load(kTree)->title.value, std::string("Sam's tree"));
}

TEST(pg_a_fork_plants_the_title_and_guide_at_its_planting_stamp_for_the_new_owner) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTreeRepository trees{pgTestPool()};
  PgOpLog log{pgTestPool()};
  FakeBus bus;
  RoomRegistry registry(trees, log, bus);
  trees.create(kTree, LooseGraph().exportState(), LegendState{}, "Sam's tree", kSam);
  registry.setVisibility(kTree, Visibility::unlisted);
  registry.open(kTree)->setGuide("Rig first, then sail.", 1'700'000'000'000);
  FakeTokens tokens;
  FakeClock clock;
  ForkService forks{registry, trees, tokens, clock};

  const ForkService::Result forked = forks.fork(kTree, kFork.str(), "", kEve);

  CHECK(forked.outcome == ForkService::Outcome::forked);
  CHECK_EQ(forked.data.guide, std::string("Rig first, then sail."));
  const std::optional<StoredTree> copy = trees.load(kFork);
  REQUIRE(copy.has_value());
  const Hlc plantedAt{1'700'000'000'000, 1, "srv"};  // the source room's next stamp after its guide's
  CHECK(copy->guide == (Lww<std::string>{"Rig first, then sail.", plantedAt}));
  CHECK(copy->title == (Lww<std::string>{"Sam's tree", plantedAt}));
  CHECK(copy->owner == std::optional<UserId>(kEve));

  // A later rename of the fork is minted past the planting stamp, so the column takes it.
  registry.rename(kFork, "Eve's voyage", 1'700'000'000'000, copy->title.stamp);
  CHECK(trees.load(kFork)->title == (Lww<std::string>{"Eve's voyage", Hlc{1'700'000'000'000, 2, "srv"}}));
}

TEST(pg_a_save_onto_a_soft_deleted_tree_writes_nothing_and_answers_false) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTreeRepository trees{pgTestPool()};
  trees.create(kTree, LooseGraph().exportState(), LegendState{}, "Sam's tree", kSam);
  trees.softDelete(kTree);
  LooseGraph ghost;
  ghost.createNode(NodeId{"ghost"}, "Ghost", "", NodeColor::sky, std::nullopt, Hlc{1'700'000'000'000, 0, "r_a"});

  CHECK_FALSE(trees.save(kTree, ghost.exportState(), LegendState{},
                         Lww<std::string>{"Ghost title", Hlc{1'700'000'000'000, 0, "r_a"}},
                         Lww<std::string>{"Ghost guide", Hlc{1'700'000'000'000, 0, "r_a"}}, 7));

  PgLease conn{*pgTestPool()};
  pqxx::work txn{*conn};
  const pqxx::result row = txn.exec_params(
      "SELECT title, guide, head_seq, (SELECT count(*) FROM tree_nodes WHERE tree_id = $1) AS nodes "
      "FROM trees WHERE id = $1", kTree.str());
  REQUIRE_EQ(row.size(), std::size_t{1});
  CHECK_EQ(row[0]["title"].as<std::string>(), std::string("Sam's tree"));
  CHECK_EQ(row[0]["guide"].as<std::string>(), std::string(""));
  CHECK_EQ(row[0]["head_seq"].as<long long>(), 0LL);
  CHECK_EQ(row[0]["nodes"].as<long long>(), 0LL);
}

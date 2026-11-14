#include "products/roadmap/adapters/postgres/PgTreeRepository.h"

#include "platform/adapters/postgres/PgAuthRepository.h"
#include "platform/application/WriteObservation.h"
#include "products/roadmap/adapters/postgres/PgOpLog.h"
#include "products/roadmap/adapters/postgres/PgProgressRepository.h"
#include "products/roadmap/adapters/postgres/PgReminderRepository.h"
#include "products/roadmap/application/ActivityFeed.h"
#include "products/roadmap/application/ForkService.h"
#include "products/roadmap/application/NodeEdits.h"
#include "products/roadmap/application/OwnerProgress.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/application/TreeRegistry.h"
#include "products/roadmap/domain/Command.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "products/roadmap/domain/SubtreeInventory.h"
#include "test/PgTestPool.h"
#include "test/platform/Fakes.h"
#include "test/products/roadmap/Fakes.h"
#include "test/products/roadmap/adapters/mcp/ToolsHarness.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <functional>
#include <future>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <utility>
#include <variant>
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

TEST(pg_opens_survives_a_restart_with_its_stamp_and_only_a_later_write_of_it_changes_the_row) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  NodeStateEntry door;
  door.id = NodeId{"door"};
  door.label = "Door";
  door.createdAt = door.labelAt = Hlc{1'700'000'000'000, 0, "r_a"};
  door.opens = kFork;
  door.opensAt = Hlc{1'700'000'000'000, 1, "r_a"};
  {
    PgTreeRepository trees{pgTestPool()};
    PgOpLog log{pgTestPool()};
    FakeBus bus;
    RoomRegistry registry(trees, log, bus);
    trees.create(kTree, LooseGraph().exportState(), LegendState{}, "Sam's tree", kSam);
    Subgraph planted;
    planted.frameId = "f-door";
    planted.graph.nodes = {door};
    registry.open(kTree)->joinSubgraph(planted, kSam);
    REQUIRE(registry.persist(kTree) == Saved::saved);
  }

  PgTreeRepository restarted{pgTestPool()};
  PgOpLog log{pgTestPool()};
  FakeBus bus;
  RoomRegistry registry(restarted, log, bus);
  CHECK(restarted.load(kTree)->state == (GraphState{{door}, {}}));

  Subgraph renamed;  // from a browser that does not know the register: neither the value nor its stamp
  renamed.frameId = "f-rename";
  renamed.graph.nodes.emplace_back();
  renamed.graph.nodes[0].id = NodeId{"door"};
  renamed.graph.nodes[0].label = door.label = "Front door";
  renamed.graph.nodes[0].labelAt = door.labelAt = Hlc{1'700'000'000'000, 2, "r_b"};
  registry.open(kTree)->joinSubgraph(renamed, kSam);
  REQUIRE(registry.persist(kTree) == Saved::saved);
  CHECK(restarted.load(kTree)->state == (GraphState{{door}, {}}));

  Subgraph retargeted;
  retargeted.frameId = "f-retarget";
  retargeted.graph.nodes.emplace_back();
  retargeted.graph.nodes[0].id = NodeId{"door"};
  retargeted.graph.nodes[0].opens = door.opens = kTree;
  retargeted.graph.nodes[0].opensAt = door.opensAt = Hlc{1'700'000'000'000, 3, "r_b"};
  registry.open(kTree)->joinSubgraph(retargeted, kSam);
  REQUIRE(registry.persist(kTree) == Saved::saved);
  CHECK(restarted.load(kTree)->state == (GraphState{{door}, {}}));

  PgLease conn{*pgTestPool()};
  pqxx::work txn{*conn};
  const pqxx::result openers = txn.exec_params(
      "SELECT tree_id, node_id, opens, opens_hlc FROM tree_nodes WHERE opens IN ($1, $2) AND present AND opens <> ''",
      kTree.str(), kFork.str());
  REQUIRE_EQ(openers.size(), std::size_t{1});
  CHECK_EQ(openers[0]["tree_id"].as<std::string>(), kTree.str());
  CHECK_EQ(openers[0]["node_id"].as<std::string>(), std::string("door"));
  CHECK_EQ(openers[0]["opens"].as<std::string>(), kTree.str());
  CHECK_EQ(openers[0]["opens_hlc"].as<std::string>(), std::string("1700000000000:3:r_b"));
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

// The mark lives on the row, so neither a restart nor a save that carries the copied guide again
// clears it; only a guide the owner writes does, and that too survives a restart.
TEST(pg_a_forks_copied_guide_stays_inherited_until_its_owner_writes_one_across_restarts) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  {
    PgTreeRepository trees{pgTestPool()};
    PgOpLog log{pgTestPool()};
    FakeBus bus;
    RoomRegistry registry(trees, log, bus);
    trees.create(kTree, LooseGraph().exportState(), LegendState{}, "Sam's tree", kSam);
    registry.setVisibility(kTree, Visibility::unlisted);
    registry.open(kTree)->setGuide("Rig first, then sail.", 1'700'000'000'000);
    REQUIRE(registry.persist(kTree) == Saved::saved);
    FakeTokens tokens;
    FakeClock clock;
    ForkService forks{registry, trees, tokens, clock};
    REQUIRE(forks.fork(kTree, kFork.str(), "", kEve).outcome == ForkService::Outcome::forked);
    REQUIRE(registry.open(kFork)->guideInherited());
    registry.evict(kFork);  // saves the copied guide back under its own stamp
    CHECK(trees.load(kTree)->guideInherited == false);
  }
  {
    PgTreeRepository restarted{pgTestPool()};
    PgOpLog log{pgTestPool()};
    FakeBus bus;
    RoomRegistry registry(restarted, log, bus);
    CHECK(restarted.load(kFork)->guideInherited);
    TreeRoom& room = *registry.open(kFork);
    CHECK(room.guideInherited());
    room.setGuide("Sail first, rig on the way.", 1'700'000'001'000);
    CHECK_FALSE(room.guideInherited());
    REQUIRE(registry.persist(kFork) == Saved::saved);
  }
  PgTreeRepository again{pgTestPool()};
  const std::optional<StoredTree> owned = again.load(kFork);
  REQUIRE(owned.has_value());
  CHECK_EQ(owned->guide.value, std::string("Sail first, rig on the way."));
  CHECK_FALSE(owned->guideInherited);
}

TEST(pg_a_save_onto_a_soft_deleted_tree_writes_nothing_and_answers_false) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTreeRepository trees{pgTestPool()};
  trees.create(kTree, LooseGraph().exportState(), LegendState{}, "Sam's tree", kSam);
  trees.softDelete(kTree);
  LooseGraph ghost;
  ghost.createNode(NodeId{"ghost"}, "Ghost", "", NodeColor::sky, Hlc{1'700'000'000'000, 0, "r_a"});

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

// What a node's pointer may be judged at: only the owner's trees that stand, whatever the ids asked after, in one read.
TEST(pg_pointer_targets_answers_the_owners_standing_trees_alone_for_every_id_asked_in_one_call) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  const TreeId oddlyNamed{std::string("t_pgtest_opens,\"odd\" {id}")};
  const TreeId retired{std::string("t_pgtest_opens_retired")};
  const TreeId theirs{std::string("t_pgtest_opens_theirs")};
  const TreeId nobodys{std::string("t_pgtest_opens_nobodys")};
  const TreeId absent{std::string("t_pgtest_opens_absent")};
  const auto clear = [&] {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    for (const TreeId& tree : {oddlyNamed, retired, theirs, nobodys})
      txn.exec_params("DELETE FROM trees WHERE id = $1", tree.str());
    txn.commit();
  };
  clear();
  PgTreeRepository trees{pgTestPool()};
  trees.create(kTree, LooseGraph().exportState(), LegendState{}, "Sam's first", kSam);
  trees.create(oddlyNamed, LooseGraph().exportState(), LegendState{}, "Sam's \"second\", with commas", kSam);
  trees.create(retired, LooseGraph().exportState(), LegendState{}, "Sam's retired", kSam);
  trees.softDelete(retired);
  trees.create(theirs, LooseGraph().exportState(), LegendState{}, "Eve's", kEve);
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec_params("INSERT INTO trees (id, title, head_seq) VALUES ($1, 'Nobody''s', 0)", nobodys.str());
    txn.commit();
  }
  const std::set<TreeId> asked{kTree, oddlyNamed, retired, theirs, nobodys, absent};

  CHECK(trees.pointerTargets(kSam, asked) == (std::map<TreeId, OpenedTree>{{kTree, {}}, {oddlyNamed, {}}}));
  CHECK(trees.pointerTargets(kEve, asked) == (std::map<TreeId, OpenedTree>{{theirs, {}}}));
  CHECK(trees.pointerTargets(kSam, {theirs, nobodys, retired, absent}).empty());
  CHECK(trees.pointerTargets(kSam, {}).empty());
  clear();
}

// A deleted node's row keeps its pointer, so the create that reuses its id writes the empty one: the
// stored row opens nothing, across a restart.
TEST(pg_create_node_on_a_deleted_id_opens_nothing_after_a_restart) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTreeRepository trees{pgTestPool()};
  PgOpLog log{pgTestPool()};
  FakeBus bus;
  FakeProgressRepository progressRepo;
  FakeTokens tokens;
  test::StepClock clock;
  ProgressService progress{progressRepo, trees};
  trees.create(kTree, LooseGraph().exportState(), LegendState{}, "Main", kSam);
  trees.create(kFork, LooseGraph().exportState(), LegendState{}, "Deep dive", kSam);
  const auto storedPointer = [] {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    const pqxx::result rows = txn.exec_params(
        "SELECT node_id || ':' || opens || ':' || present::text AS held FROM tree_nodes WHERE tree_id = $1", kTree.str());
    std::vector<std::string> held;
    for (const auto& row : rows) held.push_back(row["held"].as<std::string>());
    return held;
  };
  const ToolCaller sam{kSam, ToolScope::everything()};
  Json::Value created = parse(R"({"label":"Sail trim"})");
  created["treeId"] = kTree.str();
  {
    RoomRegistry registry(trees, log, bus);
    NodeEdits edits{registry, progress, bus, clock};
    TreeRegistry treeRegistry{trees, progressRepo, tokens, Hlc{1, 0, "genesis"}, registry, edits, clock};
    RoadmapTools tools{registry, progress, clock, treeRegistry, edits, "https://app.example"};
    Json::Value pointed = created;
    pointed["opens"] = kFork.str();
    CHECK_FALSE(tools.callTool("create_node", pointed, sam).isError);
    Json::Value deleted = parse(R"({"nodeId":"sail-trim"})");
    deleted["treeId"] = kTree.str();
    CHECK_FALSE(tools.callTool("delete_node", deleted, sam).isError);
    registry.stop();
  }
  CHECK_EQ(storedPointer(), std::vector<std::string>{"sail-trim:" + kFork.str() + ":false"});

  RoomRegistry restarted(trees, log, bus);
  NodeEdits edits{restarted, progress, bus, clock};
  TreeRegistry treeRegistry{trees, progressRepo, tokens, Hlc{1, 0, "genesis"}, restarted, edits, clock};
  RoadmapTools tools{restarted, progress, clock, treeRegistry, edits, "https://app.example"};
  CHECK_FALSE(tools.callTool("create_node", created, sam).isError);
  Json::Value read = parse(R"({"fields":["id","opens"]})");
  read["treeId"] = kTree.str();
  CHECK_EQ(test::body(tools.callTool("get_tree", read, sam))["tree"]["nodes"], parse(R"([{"id":"sail-trim"}])"));
  CHECK_EQ(storedPointer(), std::vector<std::string>{"sail-trim::true"});
  restarted.stop();
}

// A deleted node's row takes the colour its kind's re-hue gives it and stays deleted, so across a restart the node an
// import brings back is under its kind.
TEST(pg_a_deleted_node_repainted_with_its_kind_comes_back_under_the_kind_after_a_restart) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTreeRepository trees{pgTestPool()};
  PgOpLog log{pgTestPool()};
  FakeBus bus;
  FakeProgressRepository progressRepo;
  FakeTokens tokens;
  test::StepClock clock;
  ProgressService progress{progressRepo, trees};
  trees.create(kTree, LooseGraph().exportState(), LegendState{}, "Main", kSam);
  const auto storedColours = [] {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    const pqxx::result rows = txn.exec_params(
        "SELECT node_id || ':' || color || ':' || present::text AS held FROM tree_nodes WHERE tree_id = $1 ORDER BY node_id",
        kTree.str());
    std::vector<std::string> held;
    for (const auto& row : rows) held.push_back(row["held"].as<std::string>());
    return held;
  };
  const ToolCaller sam{kSam, ToolScope::everything()};
  const auto arguments = [](const char* json) {
    Json::Value args = parse(json);
    args["treeId"] = kTree.str();
    return args;
  };
  {
    RoomRegistry registry(trees, log, bus);
    NodeEdits edits{registry, progress, bus, clock};
    TreeRegistry treeRegistry{trees, progressRepo, tokens, Hlc{1, 0, "genesis"}, registry, edits, clock};
    RoadmapTools tools{registry, progress, clock, treeRegistry, edits, "https://app.example"};
    CHECK_FALSE(tools.callTool("add_kind", arguments(R"({"id":"k","hue":"sky"})"), sam).isError);
    CHECK_FALSE(tools.callTool("import_subgraph", arguments(R"({"nodes":[{"id":"a","label":"A","kind":"k"},
      {"id":"b","label":"B","kind":"k"}]})"), sam).isError);
    CHECK_FALSE(tools.callTool("delete_node", arguments(R"({"nodeId":"b"})"), sam).isError);
    CHECK_FALSE(tools.callTool("update_kind", arguments(R"({"id":"k","hue":"plum"})"), sam).isError);
    registry.stop();
  }
  CHECK_EQ(storedColours(), (std::vector<std::string>{"a:plum:true", "b:plum:false"}));

  RoomRegistry restarted(trees, log, bus);
  NodeEdits edits{restarted, progress, bus, clock};
  TreeRegistry treeRegistry{trees, progressRepo, tokens, Hlc{1, 0, "genesis"}, restarted, edits, clock};
  RoadmapTools tools{restarted, progress, clock, treeRegistry, edits, "https://app.example"};
  CHECK_FALSE(tools.callTool("import_subgraph", arguments(R"({"nodes":[{"id":"b"}]})"), sam).isError);
  CHECK_EQ(test::body(tools.callTool("get_nodes", arguments(R"({"nodeIds":["a","b"],"fields":["id","color","kind"]})"), sam))["nodes"],
           parse(R"([{"id":"a","color":"plum","kind":"k"},{"id":"b","color":"plum","kind":"k"}])"));
  restarted.stop();
  CHECK_EQ(storedColours(), (std::vector<std::string>{"a:plum:true", "b:plum:true"}));
}

// A room opens as its stored snapshot whatever rows the log holds past it. Each case leaves the snapshot one row behind
// a write — an import that brings a deleted node back bare, an import that swaps two kinds' hues, a web client's frame
// that undoes a delete — by landing the write's row and dropping its room unsaved. The tree reopens holding exactly
// what the snapshot holds, with no field blanked and no kind moved, takes its next seq after the last row, and the
// feed still tells that row: a revive's by the name the node kept, though the snapshot holds it deleted.
TEST(pg_a_room_opens_as_its_snapshot_whatever_rows_the_log_holds_past_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  const auto bareRevive = [](TreeRoom& room) {
    Graft graft;
    NodeSpec gone;
    gone.id = NodeId{"gone"};
    graft.document.nodes = {gone};
    graft.omittedNodeRegisters[gone.id] = {NodeRegister::label, NodeRegister::icon, NodeRegister::color, NodeRegister::order,
                                           NodeRegister::status, NodeRegister::description, NodeRegister::links,
                                           NodeRegister::opens};
    graft.omittedPrerequisites = {gone.id};
    REQUIRE(room.importTree(graft, 12, kSam).has_value());
  };
  const auto hueSwap = [](TreeRoom& room) {
    Graft graft;
    graft.document.kinds = {{KindId{"apps"}, NodeColor::plum}, {KindId{"infra"}, NodeColor::sky}};
    for (const char* kind : {"apps", "infra"})
      graft.omittedKindRegisters[KindId{kind}] = {KindRegister::label, KindRegister::description};
    REQUIRE(room.importTree(graft, 12, kSam).has_value());
  };
  const auto undoneDelete = [](TreeRoom& room) {
    Subgraph frame;
    frame.treeId = kTree;
    frame.frameId = "undo-of-delete";
    frame.actor = "r_tab";
    frame.graph.nodes = {NodeStateEntry{.id = NodeId{"gone"}, .createdAt = Hlc{2'000'000'000'000, 0, "r_tab"}}};
    REQUIRE(room.joinSubgraph(frame, kSam).has_value());
  };
  for (const auto& [write, told] : std::vector<std::pair<std::function<void(TreeRoom&)>, std::string>>{
           {bareRevive, "added Gone"}, {hueSwap, "recolored a kind plum"}, {undoneDelete, "added Gone"}}) {
    reset();
    PgTreeRepository trees{pgTestPool()};
    PgOpLog log{pgTestPool()};
    FakeBus bus;
    trees.create(kTree, LooseGraph().exportState(), LegendState{}, "Main", kSam);
    Seq saved = 0;
    {
      RoomRegistry registry(trees, log, bus);
      TreeRoom& room = *registry.open(kTree);
      room.applyCommands({AddKind{KindId{"apps"}, NodeColor::sky, "Apps"}, AddKind{KindId{"infra"}, NodeColor::plum, "Infra"},
                          CreateNode{NodeId{"a"}, "A", "i", NodeColor::sky}, CreateNode{NodeId{"b"}, "B", "i", NodeColor::plum},
                          CreateNode{NodeId{"gone"}, "Gone", "i", NodeColor::sky}},
                         10, kSam);
      room.applyCommand(DeleteNode{NodeId{"gone"}}, 11, kSam);
      REQUIRE(registry.persist(kTree) == Saved::saved);
      saved = room.head();
      write(room);
      REQUIRE_EQ(room.pendingOps().size(), 1u);
      log.append(kTree, room.pendingOps().front());
      registry.retire(kTree);
      registry.stop();
    }
    const StoredTree snapshot = *trees.load(kTree);
    CHECK_EQ(snapshot.head, saved);

    RoomRegistry reopened(trees, log, bus);
    TreeRoom& room = *reopened.open(kTree);
    CHECK(room.exportState() == snapshot.state);
    CHECK(room.exportLegend() == snapshot.legend);
    CHECK_EQ(room.head(), saved + 1);
    CHECK_EQ(room.applyCommand(RenameNode{NodeId{"a"}, "A2"}, 20, kSam), saved + 2);
    CHECK(reopened.persist(kTree) == Saved::saved);
    std::vector<std::string> feed;
    for (const ActivityEvent& event : activityFeed(room.snapshot(), log.since(kTree, saved), 10)) feed.push_back(event.summary);
    CHECK_EQ(feed, (std::vector<std::string>{told, "renamed to A2"}));
    CHECK_EQ(trees.load(kTree)->head, saved + 2);
    reopened.stop();
  }
  reset();
}

// The statement behind OpenedTrees: a removed node's pointer leads nowhere, a loop ends, and only the owner's marks count.
TEST(pg_opened_from_answers_every_standing_tree_of_the_owners_the_pointers_lead_to_counted_under_the_owners_marks) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  const auto id = [](const std::string& name) { return TreeId{"t_pgtest_opened_" + name}; };
  const auto clear = [] {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    for (const char* table : {"tree_nodes", "tree_edges", "tree_kinds", "node_progress"})
      txn.exec(std::string("DELETE FROM ") + table + " WHERE tree_id LIKE 't\\_pgtest\\_opened\\_%'");
    txn.exec("DELETE FROM trees WHERE id LIKE 't\\_pgtest\\_opened\\_%'");
    txn.commit();
  };
  clear();
  PgTreeRepository trees{pgTestPool()};
  PgProgressRepository progress{pgTestPool()};
  const auto plant = [&](const std::string& name, const UserId& owner,
                         const std::vector<std::pair<std::string, std::string>>& nodes, const std::string& tombstoned = "") {
    TreeData data;
    data.id = id(name);
    for (const auto& [node, opens] : nodes) {
      NodeSpec spec;
      spec.id = NodeId{node};
      spec.label = node;
      if (!opens.empty()) spec.opens = id(opens);
      data.nodes.push_back(spec);
    }
    LooseGraph graph(data, Hlc{1'700'000'000'000, 0, "r_a"});
    if (!tombstoned.empty()) graph.deleteNode(NodeId{tombstoned}, Hlc{1'700'000'000'001, 0, "r_a"});
    trees.create(id(name), graph.exportState(), LegendState{}, "Tree " + name, owner);
  };
  const auto mark = [&](const std::string& tree, const UserId& user, const std::string& node) {
    progress.setStatuses(id(tree), user, {{NodeId{node}, ProgressStatus::complete, false, Hlc{1'700'000'000'002, 0, "r_a"}}}, StampedBy::replica, 1'700'000'000'002);
  };
  plant("a", kSam, {{"plain-sam", ""}, {"plain-eve", ""}, {"plain", ""}, {"to-b", "b"}, {"to-b-again", "b"},
                    {"to-b-eve", "b"}, {"to-retired", "retired"}, {"to-theirs", "theirs"}, {"to-absent", "absent"},
                    {"removed", "hidden"}}, "removed");
  plant("b", kSam, {{"back", "a"}, {"plain", ""}});
  plant("empty", kSam, {});
  plant("hidden", kSam, {{"h", ""}});
  plant("retired", kSam, {{"r", ""}});
  trees.softDelete(id("retired"));
  plant("theirs", kEve, {{"x", ""}});
  for (int k = 0; k < 12; ++k) plant("ring" + std::to_string(k), kSam, {{"n", "ring" + std::to_string((k + 1) % 12)}});
  mark("a", kSam, "plain-sam");
  mark("a", kEve, "plain-eve");
  mark("a", kSam, "to-b");
  mark("a", kEve, "to-b-eve");
  mark("a", kSam, "to-absent");
  mark("a", kSam, "removed");
  mark("theirs", kSam, "x");

  const LatestMark marked{Hlc{1'700'000'000'002, 0, "r_a"}, 1'700'000'000'002};
  OpenedTree a;
  a.title = "Tree a";
  a.total = 9;
  a.marked = 1;
  a.latest = marked;
  a.pointers = {{id("absent"), {1, 1, marked}}, {id("b"), {3, 1, marked}}, {id("retired"), {1, 0}}, {id("theirs"), {1, 0}}};
  OpenedTree b;
  b.title = "Tree b";
  b.total = 2;
  b.pointers = {{id("a"), {1, 0}}};
  OpenedTree empty;
  empty.title = "Tree empty";
  CHECK(trees.openedFrom(kSam, {id("a"), id("empty"), id("retired"), id("theirs"), id("absent")}) ==
        (std::map<TreeId, OpenedTree>{{id("a"), a}, {id("b"), b}, {id("empty"), empty}}));

  OpenedTree theirs;
  theirs.title = "Tree theirs";
  theirs.total = 1;
  CHECK(trees.openedFrom(kEve, {id("a"), id("theirs")}) == (std::map<TreeId, OpenedTree>{{id("theirs"), theirs}}));
  CHECK(trees.openedFrom(kSam, {}) == (std::map<TreeId, OpenedTree>{}));

  OpenedTree link;
  link.total = 1;
  std::map<TreeId, OpenedTree> ring;
  for (int k = 0; k < 12; ++k) {
    link.title = "Tree ring" + std::to_string(k);
    link.pointers = {{id("ring" + std::to_string((k + 1) % 12)), {1, 0}}};
    ring.emplace(id("ring" + std::to_string(k)), link);
  }
  CHECK(trees.openedFrom(kSam, {id("ring7")}) == ring);

  // The latest mark is the greatest stamp among the marks that say complete, the actor breaking a tie, with that
  // mark's own receipt instant: a later clear, another reader's mark and a later receipt of an older stamp are not it.
  // A mark stored with no stamp, as an empty one or as the unset "0:0:", counts toward completion and never toward when.
  plant("stamps", kSam, {{"first", ""}, {"counter", ""}, {"actor", ""}, {"cleared", ""}, {"eve", ""}, {"unmarked", ""},
                         {"no-stamp", ""}, {"unset-stamp", ""}});
  plant("unstamped", kSam, {{"only", ""}});
  progress.setStatuses(id("stamps"), kSam, {{NodeId{"first"}, ProgressStatus::complete, false, Hlc{1'700'000'000'010, 0, "r_z"}}}, StampedBy::replica, 1'700'000'000'090);
  progress.setStatuses(id("stamps"), kSam, {{NodeId{"counter"}, ProgressStatus::complete, false, Hlc{1'700'000'000'010, 2, "r_a"}}}, StampedBy::replica, 1'700'000'000'020);
  progress.setStatuses(id("stamps"), kSam, {{NodeId{"actor"}, ProgressStatus::complete, false, Hlc{1'700'000'000'010, 2, "r_b"}}}, StampedBy::replica, 1'700'000'000'015);
  progress.setStatuses(id("stamps"), kSam, {{NodeId{"cleared"}, ProgressStatus::none, false, Hlc{1'700'000'000'050, 0, "r_a"}}}, StampedBy::replica, 1'700'000'000'050);
  progress.setStatuses(id("stamps"), kEve, {{NodeId{"eve"}, ProgressStatus::complete, false, Hlc{1'700'000'000'060, 0, "r_e"}}}, StampedBy::replica, 1'700'000'000'060);
  for (const char* node : {"no-stamp", "unset-stamp"})
    progress.setStatuses(id("stamps"), kSam, {{NodeId{node}, ProgressStatus::complete, false, Hlc{}}}, StampedBy::replica, 1'700'000'000'999);
  progress.setStatuses(id("unstamped"), kSam, {{NodeId{"only"}, ProgressStatus::complete, false, Hlc{}}}, StampedBy::replica, 1'700'000'000'999);
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("UPDATE node_progress SET hlc = '' WHERE node_id IN ('no-stamp', 'only') AND tree_id LIKE 't\\_pgtest\\_opened\\_%'");
    txn.commit();
  }
  OpenedTree stamps;
  stamps.title = "Tree stamps";
  stamps.total = 8;
  stamps.marked = 5;
  stamps.latest = LatestMark{Hlc{1'700'000'000'010, 2, "r_b"}, 1'700'000'000'015};
  OpenedTree unstamped;
  unstamped.title = "Tree unstamped";
  unstamped.total = 1;
  unstamped.marked = 1;
  CHECK(trees.openedFrom(kSam, {id("stamps"), id("unstamped")}) ==
        (std::map<TreeId, OpenedTree>{{id("stamps"), stamps}, {id("unstamped"), unstamped}}));
  clear();
}

// The whole path over the real repositories: the owner's mark refused and judged, a second reader's recorded, and
// the owner's marks as a reader is shown them, off the budgeted statement.
TEST(pg_a_node_follows_the_tree_it_opens_takes_no_mark_from_its_owner_and_the_registry_list_counts_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTreeRepository trees{pgTestPool()};
  PgProgressRepository progressRepo{pgTestPool()};
  PgOpLog log{pgTestPool()};
  FakeBus bus;
  FakeTokens tokens;
  test::StepClock clock;
  ProgressService progress{progressRepo, trees};
  OwnerProgress ownerProgress{progressRepo, trees, clock};
  RoomRegistry registry(trees, log, bus);
  NodeEdits edits{registry, progress, bus, clock};
  TreeRegistry treeRegistry{trees, progressRepo, tokens, Hlc{1, 0, "genesis"}, registry, edits, clock};
  RoadmapTools tools{registry, progress, clock, treeRegistry, edits, "https://app.example"};
  trees.create(kTree, LooseGraph().exportState(), LegendState{}, "Main", kSam);
  trees.create(kFork, LooseGraph().exportState(), LegendState{}, "Deep dive", kSam);
  const auto shown = [&] {
    const std::vector<OwnersTrees> owners{{kSam, {{kTree, registry.open(kTree)->stampedPointers()}}}};
    return ownerProgress.shownToReaders(owners, kReaderFollowBudget, "rest").progress.at(kTree).completed;
  };
  const auto call = [&](const TreeId& tree, const UserId& user, const char* tool, const std::string& arguments) {
    Json::Value args = parse(arguments);
    args["treeId"] = tree.str();
    return tools.callTool(tool, args, ToolCaller{user, ToolScope::everything()});
  };
  const auto counts = [&] {
    std::map<std::string, std::string> doneOfTotal;
    for (const TreeSummary& row : treeRegistry.list(kSam))
      doneOfTotal[row.id.str()] = std::to_string(row.stats.done) + "/" + std::to_string(row.stats.total);
    return doneOfTotal;
  };
  CHECK_FALSE(call(kFork, kSam, "create_node", R"({"id":"s","label":"S"})").isError);
  CHECK_FALSE(call(kTree, kSam, "import_subgraph",
                   R"({"nodes":[{"id":"idea","label":"Idea"},{"id":"next","label":"Next","prerequisites":["idea"]}]})").isError);
  CHECK_FALSE(call(kTree, kSam, "update_nodes", R"({"updates":[{"nodeId":"idea","status":"complete"}]})").isError);
  CHECK_FALSE(call(kTree, kSam, "update_nodes", R"({"updates":[{"nodeId":"idea","opens":")" + kFork.str() + R"("}]})").isError);
  registry.setVisibility(kTree, Visibility::public_);
  registry.setVisibility(kFork, Visibility::public_);
  CHECK_FALSE(call(kFork, kEve, "update_nodes", R"({"updates":[{"nodeId":"s","status":"complete"}]})").isError);

  Json::Value open = parse(R"([{"id":"idea","status":"complete","state":"available","opens":{"title":"Deep dive","state":"open"}},
                               {"id":"next","status":"none","state":"locked"}])");
  open[0]["opens"]["treeId"] = kFork.str();
  CHECK_EQ(test::body(call(kTree, kSam, "get_tree", R"({"fields":["id","status","state","opens"]})"))["tree"]["nodes"], open);
  CHECK(counts() == (std::map<std::string, std::string>{{kTree.str(), "0/2"}, {kFork.str(), "0/1"}}));
  const ToolResult refused = call(kTree, kSam, "update_nodes", R"({"updates":[{"nodeId":"idea","status":"none"}]})");
  CHECK_FALSE(refused.isError);
  CHECK_EQ(test::body(refused)["progress"], parse(R"([{"nodeId":"idea","refused":"\"idea\" opens a tree: it is complete when that tree is and takes no mark of its own — mark the steps of the tree it opens"}])"));
  CHECK_EQ(test::body(call(kTree, kSam, "update_nodes", R"({"updates":[{"nodeId":"next","status":"complete"}]})"))["progress"],
           parse(R"([{"nodeId":"next","status":"complete","prerequisitesMet":false}])"));
  CHECK_EQ(test::body(call(kTree, kSam, "get_tree", R"({"fields":["id","status","state","opens"]})"))["tree"]["nodes"][0], open[0]);
  CHECK(shown() == std::set<NodeId>{NodeId{"next"}});

  CHECK_FALSE(call(kFork, kSam, "update_nodes", R"({"updates":[{"nodeId":"s","status":"complete"}]})").isError);

  Json::Value complete = parse(R"([{"id":"idea","status":"complete","state":"complete","opens":{"title":"Deep dive","state":"complete"}},
                                   {"id":"next","status":"complete","state":"complete"}])");
  complete[0]["opens"]["treeId"] = kFork.str();
  CHECK_EQ(test::body(call(kTree, kSam, "update_nodes", R"({"updates":[{"nodeId":"next","status":"complete"}]})"))["progress"],
           parse(R"([{"nodeId":"next","status":"complete","prerequisitesMet":true,"unchanged":true}])"));
  CHECK_EQ(test::body(call(kTree, kSam, "get_tree", R"({"fields":["id","status","state","opens"]})"))["tree"]["nodes"], complete);
  CHECK_EQ(test::body(call(kTree, kEve, "get_tree", R"({"fields":["id","status","state","opens"]})"))["tree"]["nodes"],
           parse(R"([{"id":"idea","status":"none","state":"available"},{"id":"next","status":"none","state":"locked"}])"));
  CHECK(counts() == (std::map<std::string, std::string>{{kTree.str(), "2/2"}, {kFork.str(), "1/1"}}));
  CHECK(shown() == (std::set<NodeId>{NodeId{"idea"}, NodeId{"next"}}));
  CHECK_EQ(test::body(call(kTree, kEve, "update_nodes", R"({"updates":[{"nodeId":"idea","status":"complete"}]})"))["progress"],
           parse(R"([{"nodeId":"idea","status":"complete","prerequisitesMet":true}])"));
  CHECK_EQ(test::body(call(kTree, kEve, "get_tree", R"({"fields":["id","status","state","opens"]})"))["tree"]["nodes"],
           parse(R"([{"id":"idea","status":"complete","state":"complete"},{"id":"next","status":"none","state":"available"}])"));
  registry.stop();
}

// Following a tree reads its owner's marks on it and no one else's, whichever index on node_progress the planner
// takes: other accounts marking the same nodes, and the owner's marks on other trees, add nothing it reads.
TEST(pg_opened_from_reads_the_owners_marks_on_a_reached_tree_alone_through_either_index) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  const auto clear = [] {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("DELETE FROM node_progress WHERE tree_id LIKE 't\\_pgtest\\_cost\\_%'");
    txn.exec("DELETE FROM tree_nodes WHERE tree_id LIKE 't\\_pgtest\\_cost\\_%'");
    txn.exec("DELETE FROM trees WHERE id LIKE 't\\_pgtest\\_cost\\_%'");
    txn.commit();
  };
  clear();
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec_params("INSERT INTO trees (id, title, owner_id, head_seq) VALUES ('t_pgtest_cost_read', 'Read', $1::uuid, 0), "
                    "('t_pgtest_cost_twin', 'Twin', $1::uuid, 0)",
                    kSam.str());
    txn.exec("INSERT INTO tree_nodes (tree_id, node_id, created_hlc, present) "
             "SELECT t, 'n' || lpad(n::text, 4, '0'), '1:0:r_a', true "
             "FROM unnest(ARRAY['t_pgtest_cost_read', 't_pgtest_cost_twin']) t, generate_series(1, 300) n");
    txn.exec_params("INSERT INTO node_progress (tree_id, user_id, node_id, status, hlc, stamp_ms, stamp_counter) "
                    "SELECT t, $1, 'n' || lpad(n::text, 4, '0'), 'complete', (1000 + n) || ':0:r_a', 1000 + n, 0 "
                    "FROM unnest(ARRAY['t_pgtest_cost_read', 't_pgtest_cost_twin']) t, generate_series(1, 300) n",
                    kSam.str());
    // Twenty other accounts mark every node of the tree read, and the owner marks thousands of nodes elsewhere.
    txn.exec("INSERT INTO node_progress (tree_id, user_id, node_id, status, hlc, stamp_ms, stamp_counter) "
             "SELECT 't_pgtest_cost_read', 'cccc0000-0000-4000-8000-0000000000' || lpad(u::text, 2, '0'), "
             "'n' || lpad(n::text, 4, '0'), 'complete', '9000:0:r_x', 9000, 0 FROM generate_series(1, 20) u, generate_series(1, 300) n");
    txn.exec_params("INSERT INTO node_progress (tree_id, user_id, node_id, status, hlc, stamp_ms, stamp_counter) "
                    "SELECT 't_pgtest_cost_elsewhere_' || t, $1, 'n' || lpad(n::text, 4, '0'), 'complete', '9000:0:r_a', 9000, 0 "
                    "FROM generate_series(1, 20) t, generate_series(1, 300) n",
                    kSam.str());
    txn.exec("ANALYZE node_progress");
    txn.commit();
  }
  // What the statement does to node_progress, following one tree, with sequential scans off and, with
  // `withoutPrimaryKey`, with the primary key gone for the read, so the planner takes the other index: the blocks it
  // reads, and whether every scan of the table fixes both the tree and the reader in its index condition.
  struct Read {
    double blocks = 0;
    bool keyedByTreeAndReader = true;
  };
  const auto follow = [&](pqxx::work& txn, const char* tree) {
    const pqxx::result explained = txn.exec_params(
        std::string("EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ") + PgTreeRepository::openedFromStatement(),
        kSam.str(), std::string("[\"") + tree + "\"]");
    Read read;
    std::vector<Json::Value> nodes{parse(explained[0][0].as<std::string>())[0]["Plan"]};
    while (!nodes.empty()) {
      const Json::Value node = nodes.back();
      nodes.pop_back();
      for (const Json::Value& child : node["Plans"]) nodes.push_back(child);
      const bool onTheMarks = node.get("Relation Name", "").asString() == "node_progress" ||
                              node.get("Index Name", "").asString().rfind("node_progress", 0) == 0;
      if (!onTheMarks) continue;
      if (node.isMember("Relation Name"))
        read.blocks += node["Shared Hit Blocks"].asDouble() + node["Shared Read Blocks"].asDouble();
      if (node["Node Type"].asString() == "Bitmap Heap Scan") continue;  // its child index scan carries the condition
      const std::string condition = node.get("Index Cond", "").asString();
      read.keyedByTreeAndReader = read.keyedByTreeAndReader && condition.find("(tree_id = ") != std::string::npos &&
                                  condition.find("(user_id = ") != std::string::npos;
    }
    return read;
  };
  for (const bool withoutPrimaryKey : {false, true}) {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("SET LOCAL enable_seqscan = off");
    if (withoutPrimaryKey) txn.exec("ALTER TABLE node_progress DROP CONSTRAINT node_progress_pkey");
    const Read marked = follow(txn, "t_pgtest_cost_read");
    const Read unmarked = follow(txn, "t_pgtest_cost_twin");
    txn.abort();
    CHECK(marked.keyedByTreeAndReader);
    CHECK(unmarked.keyedByTreeAndReader);
    CHECK(marked.blocks > 0);
    CHECK(marked.blocks <= unmarked.blocks + 2);
  }
  const std::map<TreeId, OpenedTree> followed = PgTreeRepository{pgTestPool()}.openedFrom(kSam, {TreeId{std::string("t_pgtest_cost_read")}});
  REQUIRE_EQ(followed.size(), 1u);
  CHECK_EQ(followed.begin()->second.marked, 300);
  clear();
}

// The follow an edit makes for its receipt is given a budget of its own. A statement that runs past it is abandoned
// at the budget, not at the pool's limit, and the connection it borrowed goes back under the pool's own limit.
TEST(pg_opened_from_given_a_budget_gives_up_at_it_and_returns_the_connection_under_the_pools_limit) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTreeRepository trees{pgTestPool()};
  trees.create(kTree, LooseGraph().exportState(), LegendState{}, "Main", kSam);
  OpenedTree main;
  main.title = "Main";
  const std::map<TreeId, OpenedTree> read{{kTree, main}};
  CHECK(trees.openedFrom(kSam, {kTree}, std::chrono::milliseconds{750}) == read);

  bool timedOut = false;
  const auto asked = std::chrono::steady_clock::now();
  {
    PgLease blocker{*pgTestPool()};
    pqxx::work held{*blocker};
    held.exec("LOCK TABLE tree_nodes IN ACCESS EXCLUSIVE MODE");
    try {
      trees.openedFrom(kSam, {kTree}, std::chrono::milliseconds{100});
    } catch (const FollowTimedOut&) {
      timedOut = true;
    }
  }
  CHECK(timedOut);
  CHECK(std::chrono::steady_clock::now() - asked < std::chrono::seconds{3});

  CHECK(trees.openedFrom(kSam, {kTree}) == read);
  PgLease first{*pgTestPool()};
  PgLease second{*pgTestPool()};
  for (PgLease* lease : {&first, &second}) {
    pqxx::work txn{**lease};
    CHECK_EQ(txn.exec("SHOW statement_timeout")[0][0].as<std::string>(), std::string("5s"));
  }
}

// The whole path over the real repositories: the edit that closes a loop of trees says so, each tree on the loop is
// told its own way back, a pointer no tree answers dangles, a reader of the public tree is answered the graph alone,
// and removing a tree on the loop takes the step that opened it, so the loop goes and the dangling pointer stays.
TEST(pg_get_diagnostics_tells_the_owner_a_loop_of_trees_and_a_dangling_pointer_and_the_edit_that_closes_the_loop_says_so) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTreeRepository trees{pgTestPool()};
  PgProgressRepository progressRepo{pgTestPool()};
  PgOpLog log{pgTestPool()};
  FakeBus bus;
  FakeTokens tokens;
  test::StepClock clock;
  ProgressService progress{progressRepo, trees};
  RoomRegistry registry(trees, log, bus);
  NodeEdits edits{registry, progress, bus, clock};
  TreeRegistry treeRegistry{trees, progressRepo, tokens, Hlc{1, 0, "genesis"}, registry, edits, clock};
  RoadmapTools tools{registry, progress, clock, treeRegistry, edits, "https://app.example"};
  trees.create(kTree, LooseGraph().exportState(), LegendState{}, "Main", kSam);
  trees.create(kFork, LooseGraph().exportState(), LegendState{}, "Deep dive", kSam);
  const auto call = [&](const TreeId& tree, const UserId& user, const char* tool, const std::string& arguments) {
    Json::Value args = parse(arguments);
    args["treeId"] = tree.str();
    return tools.callTool(tool, args, ToolCaller{user, ToolScope::everything()});
  };
  const auto onTheWay = [](const TreeId& tree, const char* title) {
    Json::Value on(Json::objectValue);
    on["treeId"] = tree.str();
    on["title"] = title;
    return on;
  };

  CHECK_EQ(test::body(call(kFork, kSam, "create_node", R"({"id":"back","label":"Back","icon":"b","opens":")" + kTree.str() + R"("})")),
           parse(R"({"applied":true,"seq":1,"id":"back","diagnosticsClean":true,"introducedDiagnostics":[]})"));
  const Json::Value closed = test::body(call(
      kTree, kSam, "import_subgraph",
      R"({"nodes":[{"id":"down","label":"Down","icon":"d","opens":")" + kFork.str() + R"("},{"id":"gone","label":"Gone","icon":"g"}]})"));
  CHECK_EQ(closed["introducedDiagnostics"],
           parse(R"(["loop of trees from \"down\" through \")" + kFork.str() + R"(\" -> \")" + kTree.str() + R"(\""])"));
  CHECK(closed["diagnosticsClean"].asBool());
  AnnotateNode planted{NodeId{"gone"}};
  planted.opens = TreeId{"t_pgtest_never_planted"};
  registry.open(kTree)->applyCommand(planted, clock.nowMs(), kSam);
  CHECK(registry.persist(kTree) == Saved::saved);

  Json::Value main = parse(R"({"cycles":[],"dangling":[],"selfEdges":[],"smells":[{"kind":"empty-legend"}],"maskedWork":[],
      "treeLoops":[{"node":"down","path":[]}],"danglingPointers":[{"node":"gone","treeId":"t_pgtest_never_planted"}]})");
  main["treeLoops"][0]["path"].append(onTheWay(kFork, "Deep dive"));
  main["treeLoops"][0]["path"].append(onTheWay(kTree, "Main"));
  CHECK_EQ(test::body(call(kTree, kSam, "get_diagnostics", "{}")), main);
  Json::Value sub = parse(R"({"cycles":[],"dangling":[],"selfEdges":[],"smells":[{"kind":"empty-legend"}],"maskedWork":[],
      "treeLoops":[{"node":"back","path":[]}],"danglingPointers":[]})");
  sub["treeLoops"][0]["path"].append(onTheWay(kTree, "Main"));
  sub["treeLoops"][0]["path"].append(onTheWay(kFork, "Deep dive"));
  CHECK_EQ(test::body(call(kFork, kSam, "get_diagnostics", "{}")), sub);

  registry.setVisibility(kTree, Visibility::public_);
  CHECK_EQ(test::message(call(kTree, kEve, "get_diagnostics", "{}")),
           std::string(R"({"cycles":[],"dangling":[],"maskedWork":[],"selfEdges":[],"smells":[{"kind":"empty-legend"}]})"));

  Cascade tookDown;
  tookDown.removed[kTree] = {NodeId{"down"}};
  CHECK(treeRegistry.remove(kFork, kSam) == (std::variant<Cascade, TreeRegistry::RemovalRefusal, NotARoot>{tookDown}));
  CHECK_EQ(test::body(call(kTree, kSam, "get_diagnostics", "{}")),
           parse(R"({"cycles":[],"dangling":[],"selfEdges":[],"smells":[{"kind":"empty-legend"}],"maskedWork":[],"treeLoops":[],
               "danglingPointers":[{"node":"gone","treeId":"t_pgtest_never_planted"}]})"));
  registry.stop();
}

// The statement behind `guides`: of the owner's standing trees whose present pointers lead down to a tree, each at
// its shortest distance, within eight pointers and never the tree itself, the nearest eight that carry a guide.
TEST(pg_guided_trees_above_answers_the_nearest_eight_guided_trees_of_the_owners_that_lead_down_to_a_tree_within_eight_pointers) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  const auto id = [](const std::string& name) { return TreeId{"t_pgtest_above_" + name}; };
  const auto clear = [] {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    for (const char* table : {"tree_nodes", "tree_edges", "tree_kinds"})
      txn.exec(std::string("DELETE FROM ") + table + " WHERE tree_id LIKE 't\\_pgtest\\_above\\_%'");
    txn.exec("DELETE FROM trees WHERE id LIKE 't\\_pgtest\\_above\\_%'");
    txn.commit();
  };
  clear();
  PgTreeRepository trees{pgTestPool()};
  const auto plant = [&](const std::string& name, const UserId& owner, const std::string& guide,
                         const std::vector<std::string>& opens, bool guideInherited = false) {
    TreeData data;
    data.id = id(name);
    for (const std::string& opened : opens) {
      NodeSpec pointer;
      pointer.id = NodeId{"to-" + opened};
      pointer.label = opened;
      pointer.opens = id(opened);
      data.nodes.push_back(pointer);
    }
    trees.create(id(name), LooseGraph(data, Hlc{1'700'000'000'000, 0, "r_a"}).exportState(), LegendState{}, "Tree " + name,
                 owner);
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec_params("UPDATE trees SET guide = $2, guide_inherited = $3 WHERE id = $1", id(name).str(), guide, guideInherited);
    txn.commit();
  };
  plant("leaf", kSam, "Leaf.", {"top", "leaf"});
  plant("mid", kSam, "Mid.", {"leaf"});
  plant("both", kSam, "Both ways.", {"leaf", "mid"});
  plant("top", kSam, "Top.", {"both", "mid"});
  plant("inherited", kSam, "Its author's.", {"leaf"}, true);
  plant("silent", kSam, "", {"leaf"});
  plant("removed", kSam, "Removed.", {"leaf"});
  trees.softDelete(id("removed"));
  plant("beyond", kSam, "Reached only through the removed tree.", {"removed"});
  plant("theirs", kEve, "Eve's.", {"leaf"});
  plant("tombstoned", kSam, "Its pointer was deleted.", {"leaf"});
  {
    const std::optional<StoredTree> stored = trees.load(id("tombstoned"));
    REQUIRE(stored.has_value());
    LooseGraph graph(stored->state);
    graph.deleteNode(NodeId{"to-leaf"}, Hlc{1'700'000'000'001, 0, "r_a"});
    REQUIRE(trees.save(id("tombstoned"), graph.exportState(), LegendState{}, stored->title, stored->guide, stored->head));
  }
  plant("up1", kSam, "", {"leaf"});
  for (int level = 2; level <= 9; ++level)
    plant("up" + std::to_string(level), kSam, level >= 8 ? "Up " + std::to_string(level) + "." : "",
          {"up" + std::to_string(level - 1)});

  CHECK(trees.guidedTreesAbove(kSam, id("leaf")) ==
        (std::map<TreeId, TreeAbove>{{id("mid"), {1, "Tree mid", "Mid.", false}},
                                     {id("both"), {1, "Tree both", "Both ways.", false}},
                                     {id("top"), {2, "Tree top", "Top.", false}},
                                     {id("inherited"), {1, "Tree inherited", "Its author's.", true}},
                                     {id("up8"), {8, "Tree up8", "Up 8.", false}}}));
  CHECK(trees.guidedTreesAbove(kSam, id("top")) ==
        (std::map<TreeId, TreeAbove>{{id("leaf"), {1, "Tree leaf", "Leaf.", false}},
                                     {id("mid"), {2, "Tree mid", "Mid.", false}},
                                     {id("both"), {2, "Tree both", "Both ways.", false}},
                                     {id("inherited"), {2, "Tree inherited", "Its author's.", true}}}));

  // Ten trees open the hub: one carries no guide, and of the nine that do the cap keeps the eight smaller ids as
  // bytes order them, an upper-case letter before every lower-case one whatever the database's collation.
  plant("hub", kSam, "", {});
  plant("cap_0silent", kSam, "", {"hub"});
  for (const char* name : {"cap_Z", "cap_a", "cap_b", "cap_c", "cap_d", "cap_e", "cap_f", "cap_g", "cap_h"})
    plant(name, kSam, "Guide.", {"hub"});
  plant("cap_far", kSam, "Guide.", {"cap_Z"});
  std::map<TreeId, TreeAbove> aboveHub;
  for (const char* name : {"cap_Z", "cap_a", "cap_b", "cap_c", "cap_d", "cap_e", "cap_f", "cap_g"})
    aboveHub.emplace(id(name), TreeAbove{1, std::string("Tree ") + name, "Guide.", false});
  CHECK(trees.guidedTreesAbove(kSam, id("hub")) == aboveHub);

  CHECK(trees.guidedTreesAbove(kEve, id("leaf")) == (std::map<TreeId, TreeAbove>{}));
  CHECK(trees.guidedTreesAbove(kEve, id("theirs")) == (std::map<TreeId, TreeAbove>{}));
  CHECK(trees.guidedTreesAbove(kSam, id("removed")) == (std::map<TreeId, TreeAbove>{}));
  CHECK(trees.guidedTreesAbove(kSam, id("absent")) == (std::map<TreeId, TreeAbove>{}));
  clear();
}

// The socket and PUT admit any pointer text, so anyone who knows a tree's id can point at it: the walk is keyed on
// the owner's own trees, so what another account plants is neither answered nor makes the statement read more.
TEST(pg_a_strangers_flood_of_pointers_at_a_tree_changes_no_answer_and_the_walk_still_reads_no_more_than_the_owners_rows) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  const auto clear = [] {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("DELETE FROM tree_nodes WHERE tree_id LIKE 't\\_pgtest\\_flood\\_%'");
    txn.exec("DELETE FROM trees WHERE id LIKE 't\\_pgtest\\_flood\\_%'");
    txn.commit();
  };
  clear();
  PgTreeRepository trees{pgTestPool()};
  const TreeId leaf{std::string("t_pgtest_flood_leaf")};
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec_params("INSERT INTO trees (id, title, owner_id, head_seq, guide) VALUES "
                    "('t_pgtest_flood_leaf', 'Leaf', $1::uuid, 0, 'Leaf.'), ('t_pgtest_flood_mid', 'Mid', $1::uuid, 0, 'Mid.'), "
                    "('t_pgtest_flood_top', 'Top', $1::uuid, 0, 'Top.')",
                    kSam.str());
    txn.exec("INSERT INTO tree_nodes (tree_id, node_id, created_hlc, opens, opens_hlc, present) "
             "SELECT t.id, 'n' || n, '1:0:r_a', CASE WHEN n = 1 THEN t.opens ELSE '' END, '1:0:r_a', true "
             "FROM (VALUES ('t_pgtest_flood_leaf', ''), ('t_pgtest_flood_mid', 't_pgtest_flood_leaf'), "
             "             ('t_pgtest_flood_top', 't_pgtest_flood_mid')) AS t(id, opens), generate_series(1, 20) n");
    txn.commit();
  }
  // What each table gave the statement, filtered rows included, with sequential scans off: a table of a few pages
  // is rightly read whole, which would count every row in it.
  const auto rowsRead = [&] {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("SET LOCAL enable_seqscan = off");
    const pqxx::result explained =
        txn.exec_params(std::string("EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) ") + PgTreeRepository::guidedTreesAboveStatement(),
                        kSam.str(), leaf.str(), kMaxLevelsAbove, static_cast<int>(kMaxGuides));
    std::map<std::string, double> read;
    std::vector<Json::Value> nodes{parse(explained[0][0].as<std::string>())[0]["Plan"]};
    while (!nodes.empty()) {
      const Json::Value node = nodes.back();
      nodes.pop_back();
      for (const Json::Value& child : node["Plans"]) nodes.push_back(child);
      if (!node.isMember("Relation Name")) continue;
      read[node["Relation Name"].asString()] +=
          node["Actual Loops"].asDouble() * (node["Actual Rows"].asDouble() + node["Rows Removed by Filter"].asDouble() +
                                             node["Rows Removed by Index Recheck"].asDouble());
    }
    return read;
  };
  const std::map<TreeId, TreeAbove> above{{TreeId{std::string("t_pgtest_flood_mid")}, {1, "Mid", "Mid.", false}},
                                          {TreeId{std::string("t_pgtest_flood_top")}, {2, "Top", "Top.", false}}};
  // Whichever index the planner takes, the statement reads no more than Sam's own rows: his three trees and the two
  // above again for their guides, and at most the sixty nodes they hold.
  const auto withinTheOwnersRows = [&] {
    const std::map<std::string, double> read = rowsRead();
    return read.size() == 2 && read.count("trees") && read.count("tree_nodes") && read.at("trees") <= 5 &&
           read.at("tree_nodes") <= 60;
  };
  CHECK(trees.guidedTreesAbove(kSam, leaf) == above);
  CHECK(withinTheOwnersRows());

  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec_params("INSERT INTO trees (id, title, owner_id, head_seq, guide) "
                    "SELECT 't_pgtest_flood_eve' || g, 'Flood', $1::uuid, 0, 'Not above.' FROM generate_series(1, 4) g",
                    kEve.str());
    txn.exec("INSERT INTO tree_nodes (tree_id, node_id, created_hlc, opens, opens_hlc, present) "
             "SELECT 't_pgtest_flood_eve' || g, 'n' || n, '1:0:r_e', 't_pgtest_flood_leaf', '1:0:r_e', true "
             "FROM generate_series(1, 4) g, generate_series(1, 500) n");
    txn.commit();
  }

  CHECK(trees.guidedTreesAbove(kSam, leaf) == above);
  CHECK(withinTheOwnersRows());
  clear();
}

// The statement a removal asks: the owner's other standing trees with a present step whose pointer leads to the tree, and
// nothing for a tree a pointer is not valid at — someone else's, one that does not stand, or a subtree. A step that owns a
// subtree opens that one alone. It is keyed on the owner's trees, so the pointers another account plants at the tree are
// neither answered nor read, and each tree's steps are read through tree_nodes_pointers_idx.
TEST(pg_trees_opening_answers_the_owners_other_trees_whose_present_steps_open_a_tree_and_reads_no_one_elses_pointers) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  const auto id = [](const std::string& name) { return TreeId{"t_pgtest_opening_" + name}; };
  const auto clear = [] {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("DELETE FROM tree_nodes WHERE tree_id LIKE 't\\_pgtest\\_opening\\_%'");
    txn.exec("DELETE FROM trees WHERE id LIKE 't\\_pgtest\\_opening\\_%'");
    txn.commit();
  };
  clear();
  PgTreeRepository trees{pgTestPool()};
  const auto plant = [&](const std::string& name, const UserId& owner, const std::vector<std::string>& opens) {
    TreeData data;
    data.id = id(name);
    for (std::size_t i = 0; i < opens.size(); ++i) {
      NodeSpec step;
      step.id = NodeId{"s" + std::to_string(i)};
      step.label = "Step";
      if (!opens[i].empty()) step.opens = id(opens[i]);
      data.nodes.push_back(step);
    }
    trees.create(id(name), LooseGraph(data, Hlc{1'700'000'000'000, 0, "r_a"}).exportState(), LegendState{},
                 "Tree " + name, owner);
  };
  plant("target", kSam, {"target", ""});
  plant("one", kSam, {"target"});
  plant("two", kSam, {"", "target", "target"});
  plant("plain", kSam, {"", "one"});
  plant("removed", kSam, {"target"});
  trees.softDelete(id("removed"));
  plant("tombstoned", kSam, {"target"});
  {
    const std::optional<StoredTree> stored = trees.load(id("tombstoned"));
    REQUIRE(stored.has_value());
    LooseGraph graph(stored->state);
    graph.deleteNode(NodeId{"s0"}, Hlc{1'700'000'000'001, 0, "r_a"});
    REQUIRE(trees.save(id("tombstoned"), graph.exportState(), LegendState{}, stored->title, stored->guide, stored->head));
  }
  plant("theirs", kEve, {"target"});
  plant("eves", kEve, {});
  plant("owning", kSam, {"target", "owning_sub"});
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec_params("INSERT INTO trees (id, head_seq, parent_tree, parent_step) VALUES ($1, 0, $2, 's0')",
                    id("owning_sub").str(), id("owning").str());
    txn.commit();
  }

  const std::vector<TreeId> openers{id("one"), id("two")};
  CHECK(trees.treesOpening(kSam, id("target")) == openers);
  CHECK(trees.treesOpening(kEve, id("target")) == std::vector<TreeId>{});
  CHECK(trees.treesOpening(kSam, id("eves")) == std::vector<TreeId>{});
  CHECK(trees.treesOpening(kSam, id("absent")) == std::vector<TreeId>{});
  CHECK(trees.treesOpening(kSam, id("owning_sub")) == std::vector<TreeId>{});

  // What each table gave the statement, filtered rows included, with sequential scans off so a table of a few pages
  // is not rightly read whole; and every index it read tree_nodes through.
  struct Read {
    std::map<std::string, double> rows;
    std::set<std::string> nodeIndexes;
  };
  const auto explain = [&] {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("SET LOCAL enable_seqscan = off");
    const pqxx::result explained =
        txn.exec_params(std::string("EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) ") + PgTreeRepository::treesOpeningStatement(),
                        kSam.str(), id("target").str());
    Read read;
    std::vector<Json::Value> nodes{parse(explained[0][0].as<std::string>())[0]["Plan"]};
    while (!nodes.empty()) {
      const Json::Value node = nodes.back();
      nodes.pop_back();
      for (const Json::Value& child : node["Plans"]) nodes.push_back(child);
      if (!node.isMember("Relation Name")) continue;
      read.rows[node["Relation Name"].asString()] +=
          node["Actual Loops"].asDouble() * (node["Actual Rows"].asDouble() + node["Rows Removed by Filter"].asDouble() +
                                             node["Rows Removed by Index Recheck"].asDouble());
      if (node["Relation Name"].asString() == "tree_nodes") read.nodeIndexes.insert(node["Index Name"].asString());
    }
    return read;
  };
  const auto ownersTrees = [&] {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    return txn.exec_params("SELECT count(*) FROM trees WHERE owner_id = $1::uuid", kSam.str())[0][0].as<double>();
  };
  // Sam's rows alone: at most one step of each of his trees, read through tree_nodes_pointers_idx.
  const Read before = explain();
  REQUIRE(before.rows.size() == 2 && before.rows.count("trees") && before.rows.count("tree_nodes"));
  CHECK(before.rows.at("tree_nodes") <= ownersTrees());
  CHECK(before.nodeIndexes == std::set<std::string>{"tree_nodes_pointers_idx"});

  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec_params("INSERT INTO trees (id, title, owner_id, head_seq) "
                    "SELECT 't_pgtest_opening_flood' || g, 'Flood', $1::uuid, 0 FROM generate_series(1, 4) g",
                    kEve.str());
    txn.exec("INSERT INTO tree_nodes (tree_id, node_id, created_hlc, opens, opens_hlc, present) "
             "SELECT 't_pgtest_opening_flood' || g, 'n' || n, '1:0:r_e', 't_pgtest_opening_target', '1:0:r_e', true "
             "FROM generate_series(1, 4) g, generate_series(1, 500) n");
    txn.commit();
  }
  CHECK(trees.treesOpening(kSam, id("target")) == openers);
  const Read after = explain();
  CHECK(after.rows == before.rows);
  CHECK(after.nodeIndexes == before.nodeIndexes);
  trees.softDelete(id("target"));
  CHECK(trees.treesOpening(kSam, id("target")) == std::vector<TreeId>{});
  clear();
}

// Removing a tree over the real repositories: the step of the owner's other tree that opened it is tombstoned with the
// edge it dangled and the owner's mark it held, the step behind it is free, and the stored rows say so after a restart.
TEST(pg_removing_a_tree_takes_the_step_that_opens_it_with_its_edge_and_mark_and_the_rows_keep_it_gone) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTreeRepository trees{pgTestPool()};
  PgProgressRepository progressRepo{pgTestPool()};
  PgOpLog log{pgTestPool()};
  FakeBus bus;
  FakeTokens tokens;
  test::StepClock clock;
  ProgressService progress{progressRepo, trees};
  RoomRegistry registry(trees, log, bus);
  NodeEdits edits{registry, progress, bus, clock};
  TreeRegistry treeRegistry{trees, progressRepo, tokens, Hlc{1, 0, "genesis"}, registry, edits, clock};
  RoadmapTools tools{registry, progress, clock, treeRegistry, edits, "https://app.example"};
  trees.create(kTree, LooseGraph().exportState(), LegendState{}, "Main", kSam);
  trees.create(kFork, LooseGraph().exportState(), LegendState{}, "Deep dive", kSam);
  const auto call = [&](const char* tool, const std::string& arguments) {
    Json::Value args = parse(arguments);
    args["treeId"] = kTree.str();
    return tools.callTool(tool, args, ToolCaller{kSam, ToolScope::everything()});
  };
  // The mark lands before the pointer, which is the one way a step that opens a tree holds a mark of its owner's.
  CHECK_FALSE(call("import_subgraph", R"({"nodes":[{"id":"go","label":"Go"},{"id":"after","label":"After","prerequisites":["go"]}],
                                         "progress":[{"nodeId":"go","status":"complete"}]})").isError);
  CHECK_FALSE(call("update_nodes", R"({"updates":[{"nodeId":"go","opens":")" + kFork.str() + R"("}]})").isError);

  Cascade tookGo;
  tookGo.removed[kTree] = {NodeId{"go"}};
  CHECK(treeRegistry.remove(kFork, kSam) == (std::variant<Cascade, TreeRegistry::RemovalRefusal, NotARoot>{tookGo}));
  registry.stop();

  PgLease conn{*pgTestPool()};
  pqxx::work txn{*conn};
  const auto column = [&](const std::string& sql) {
    std::vector<std::string> held;
    for (const auto& row : txn.exec_params(sql, kTree.str())) held.push_back(row[0].as<std::string>());
    return held;
  };
  CHECK(column("SELECT node_id || ':' || present::text FROM tree_nodes WHERE tree_id = $1 ORDER BY node_id") ==
        (std::vector<std::string>{"after:true", "go:false"}));
  CHECK(column("SELECT from_id || '>' || to_id || ':' || (removed_hlc NOT IN ('', '0:0:'))::text FROM tree_edges WHERE tree_id = $1") ==
        std::vector<std::string>{"go>after:true"});
  CHECK(column("SELECT node_id || ':' || status FROM node_progress WHERE tree_id = $1") == std::vector<std::string>{"go:none"});
  txn.commit();
  RoomRegistry restarted(trees, log, bus);
  ProgressService restartedProgress{progressRepo, trees};
  NodeEdits restartedEdits{restarted, restartedProgress, bus, clock};
  TreeRegistry restartedRegistry{trees, progressRepo, tokens, Hlc{1, 0, "genesis"}, restarted, restartedEdits, clock};
  RoadmapTools restartedTools{restarted, restartedProgress, clock, restartedRegistry, restartedEdits, "https://app.example"};
  Json::Value read = parse(R"({"fields":["id","state","prerequisites"]})");
  read["treeId"] = kTree.str();
  CHECK_EQ(test::body(restartedTools.callTool("get_tree", read, ToolCaller{kSam, ToolScope::everything()}))["tree"]["nodes"],
           parse(R"([{"id":"after","state":"available","prerequisites":[]}])"));
  restarted.stop();
}

// A tree whose lattice lives only in its document blob, written while nodes still stored a position, loads without one
// and backfills its row.
TEST(pg_a_document_blob_holding_a_position_loads_without_it_and_backfills_its_row) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTreeRepository trees{pgTestPool()};
  trees.create(kTree, LooseGraph().exportState(), LegendState{}, "Sam's tree", kSam);
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec_params("UPDATE trees SET document = $2::jsonb WHERE id = $1", kTree.str(),
                    std::string(R"({"nodes":[{"id":"hull","createdAt":"1:0:srv","label":"Hull","labelAt":"1:0:srv",)"
                                R"("position":{"x":3,"y":4},"positionAt":"2:0:srv"}],"edges":[]})"));
    txn.commit();
  }

  const std::optional<StoredTree> loaded = trees.load(kTree);
  REQUIRE(loaded.has_value());
  CHECK(loaded->state == (GraphState{{NodeStateEntry{.id = NodeId{"hull"}, .createdAt = Hlc{1, 0, "srv"},
                                                     .label = "Hull", .labelAt = Hlc{1, 0, "srv"}}},
                                     {}}));

  PgLease conn{*pgTestPool()};
  pqxx::work txn{*conn};
  std::vector<std::string> rows;
  for (const auto& row : txn.exec_params("SELECT node_id, label, created_hlc, present FROM tree_nodes WHERE tree_id = $1",
                                         kTree.str()))
    rows.push_back(row[0].as<std::string>() + " " + row[1].as<std::string>() + " " + row[2].as<std::string>() + " " +
                   row[3].as<std::string>());
  CHECK_EQ(rows, (std::vector<std::string>{"hull Hull 1:0:srv t"}));
}

namespace {

using SubtreeAnswer = std::variant<SubtreeCreation, SubtreeRefusal, Admission>;

const TreeId kParent{std::string("t_5ab0000000000001")};
const TreeId kOther{std::string("t_5ab0000000000002")};
const TreeId kBeas{std::string("t_5ab0000000000003")};
const TreeId kGone{std::string("t_5ab0000000000004")};
const TreeId kChild{std::string("t_5ab00000000000c1")};
const TreeId kGrandchild{std::string("t_5ab00000000000c2")};
const UserId kAda{std::string("5ab00000-0000-4000-8000-0000000000ad")};
const UserId kBea{std::string("5ab00000-0000-4000-8000-0000000000be")};

// Every row the subtree cases write, minted children included, which sit under their parents' roots; the faults and
// pauses they plant; and their two accounts, which no other case erases.
void resetSubtrees() {
  PgLease conn{*pgTestPool()};
  pqxx::work txn{*conn};
  txn.exec("DROP TRIGGER IF EXISTS pgtest_subtree_fault ON trees");
  txn.exec("DROP FUNCTION IF EXISTS pgtest_subtree_fault()");
  const std::string ours = "(SELECT id FROM trees WHERE id LIKE 't\\_5ab%' OR root_tree LIKE 't\\_5ab%' "
                           "OR owner_id IN ('" + kAda.str() + "'::uuid, '" + kBea.str() + "'::uuid))";
  for (const char* table : {"tree_ops", "tree_nodes", "tree_edges", "tree_kinds", "node_progress"})
    txn.exec(std::string("DELETE FROM ") + table + " WHERE tree_id IN " + ours);
  txn.exec("DELETE FROM trees WHERE id IN " + ours);
  txn.exec_params("DELETE FROM users WHERE id IN ($1::uuid, $2::uuid)", kAda.str(), kBea.str());
  txn.exec_params("INSERT INTO users (id, email) VALUES ($1::uuid, 'subtree-ada@example.test'), "
                  "($2::uuid, 'subtree-bea@example.test')",
                  kAda.str(), kBea.str());
  txn.commit();
}

void runSql(const std::string& statement) {
  PgLease conn{*pgTestPool()};
  pqxx::work txn{*conn};
  txn.exec(statement);
  txn.commit();
}

// A fault, or a pause of `seconds`, planted in every transaction that writes a row of trees matching `when`, so a second
// writer runs in a window that is otherwise a few milliseconds wide.
void plantOn(const std::string& event, const std::string& when, const std::string& body) {
  runSql("CREATE OR REPLACE FUNCTION pgtest_subtree_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN " + body +
         " END $$");
  runSql("CREATE TRIGGER pgtest_subtree_fault " + event + " ON trees FOR EACH ROW WHEN (" + when +
         ") EXECUTE FUNCTION pgtest_subtree_fault()");
}
void pauseOn(const std::string& event, const std::string& when) {
  plantOn("AFTER " + event, when, "PERFORM pg_sleep(1); RETURN NULL;");
}
void unplant() {
  runSql("DROP TRIGGER IF EXISTS pgtest_subtree_fault ON trees");
  runSql("DROP FUNCTION IF EXISTS pgtest_subtree_fault()");
}

// The real repository with two seams a case can set: a call made once after a tree's row is read, and a commit whose
// answer is lost though it landed.
struct SeamedTrees : PgTreeRepository {
  using PgTreeRepository::PgTreeRepository;
  std::function<void(const TreeId&)> afterLoad;
  bool commitAnswerLost = false;
  std::optional<StoredTree> load(const TreeId& tree) override {
    std::optional<StoredTree> stored = PgTreeRepository::load(tree);
    if (std::function<void(const TreeId&)> once = std::exchange(afterLoad, nullptr)) once(tree);
    return stored;
  }
  std::variant<Subtree, SubtreeConflict> createSubtree(const TreeId& child, const OwningStep& parent,
                                                       const LegendState& legend, Seq parentSeq) override {
    std::variant<Subtree, SubtreeConflict> stored = PgTreeRepository::createSubtree(child, parent, legend, parentSeq);
    if (std::exchange(commitAnswerLost, false)) throw pqxx::in_doubt_error("the commit's answer was lost");
    return stored;
  }
};

// One server process's roadmap write path over Postgres, as main.cpp composes it, minting ids from `mintFrom` on.
struct Forest {
  SeamedTrees trees{pgTestPool()};
  PgProgressRepository progressRepo{pgTestPool()};
  PgOpLog log{pgTestPool()};
  FakeBus bus;
  FakeTokens tokens;
  test::StepClock clock;
  ProgressService progress{progressRepo, trees};
  RoomRegistry rooms{trees, log, bus};
  NodeEdits edits{rooms, progress, bus, clock};
  TreeRegistry registry{trees, progressRepo, tokens, Hlc{1, 0, "genesis"}, rooms, edits, clock};
  explicit Forest(int mintFrom = 9000) { tokens.counter = mintFrom; }

  // A tree of `owner`'s holding `steps`, each opening the tree paired with it when one is named, saved.
  void plant(const TreeId& tree, const UserId& owner, const std::vector<std::pair<const char*, const char*>>& steps) {
    trees.create(tree, LooseGraph().exportState(), LegendState{}, "Planted", owner);
    edit(tree, owner, steps);
  }
  void edit(const TreeId& tree, const UserId& owner, const std::vector<std::pair<const char*, const char*>>& steps) {
    std::vector<Command> commands;
    for (const auto& [step, opens] : steps)
      commands.push_back(CreateNode{nid(step), step, "icon", NodeColor::sky, {}, {}, {},
                                    opens ? std::optional<TreeId>(TreeId{std::string(opens)}) : std::nullopt});
    std::lock_guard<std::mutex> strand(rooms.strandFor(tree));
    rooms.open(tree)->applyCommands(commands, clock.nowMs(), owner);
    REQUIRE(rooms.persist(tree) == Saved::saved);
  }
  SubtreeAnswer create(const TreeId& parent, const char* step, const std::optional<TreeId>& proposed = std::nullopt) {
    return registry.createSubtree(parent, nid(step), kAda, {proposed, std::nullopt});
  }
};

std::string placeOf(const TreeId& tree) {
  PgLease conn{*pgTestPool()};
  pqxx::work txn{*conn};
  const pqxx::result rows = txn.exec_params(
      "SELECT coalesce(parent_tree, '-') || ' ' || coalesce(parent_step, '-') || ' ' || root_tree || ' ' || depth || ' ' "
      "|| coalesce(owner_id::text, '-') || ' ' || visibility || ' [' || title || '] ' || head_seq FROM trees WHERE id = $1",
      tree.str());
  return rows.empty() ? "" : rows[0][0].as<std::string>();
}

long childrenOf(const TreeId& parent) {
  PgLease conn{*pgTestPool()};
  pqxx::work txn{*conn};
  return txn.exec_params("SELECT count(*) FROM trees WHERE parent_tree = $1", parent.str())[0][0].as<long>();
}

Seq storedHead(const TreeId& tree) {
  PgLease conn{*pgTestPool()};
  pqxx::work txn{*conn};
  return static_cast<Seq>(txn.exec_params("SELECT head_seq FROM trees WHERE id = $1", tree.str())[0][0].as<long long>());
}

std::string kindsOf(const TreeId& tree) {
  PgLease conn{*pgTestPool()};
  pqxx::work txn{*conn};
  return txn.exec_params("SELECT coalesce(string_agg(kind_id || ':' || hue || ':' || label, ',' ORDER BY rank), '') "
                         "FROM tree_kinds WHERE tree_id = $1",
                         tree.str())[0][0].as<std::string>();
}

// The subtree creates' write lines and every Issue the cases' writes leave while it is in scope, from any thread.
struct WriteLines : FailureReporter {
  std::mutex mutex;
  std::vector<std::string> lines;
  std::vector<std::string> reports;
  WriteLines() {
    installWriteReporter(std::shared_ptr<FailureReporter>(this, [](FailureReporter*) {}));
    installWriteSink([this](const WriteCompletion& line) {
      if (line.operation != "roadmap.subtree.create") return;
      std::lock_guard<std::mutex> lock(mutex);
      lines.push_back(line.operation + " " + line.door + " " + line.outcome);
    });
  }
  ~WriteLines() override {
    installWriteSink({});
    installWriteReporter(nullptr);
  }
  void report(const std::string&, const std::string&, const std::string&) override {}
  void reportWrite(const std::string& operation, const std::string&, const std::string&, const std::string& outcome,
                   const std::string&, const std::string&) override {
    std::lock_guard<std::mutex> lock(mutex);
    reports.push_back(operation + " " + outcome);
  }
  std::vector<std::string> sortedLines() {
    std::lock_guard<std::mutex> lock(mutex);
    std::vector<std::string> sorted = lines;
    std::sort(sorted.begin(), sorted.end());
    return sorted;
  }
};

bool strangerReads(RoomRegistry& rooms, const TreeId& tree) {
  const std::optional<TreeAccess> access = rooms.accessOf(tree);
  return access && canRead(kBea, access->owner, access->visibility);
}

}

TEST(pg_a_subtree_takes_its_place_from_its_parents_row_and_a_retry_after_a_restart_writes_nothing_more) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  Forest forest;
  forest.plant(kParent, kAda, {{"rig", nullptr}});
  REQUIRE(forest.registry.setVisibility(kParent, kAda, Visibility::unlisted) ==
          (std::variant<TreeRegistry::VisibilityChange, NotARoot>{TreeRegistry::VisibilityChange::changed}));
  const Subtree child{kChild, kParent, OwningStep{kParent, nid("rig")}, 1, 0};

  CHECK(forest.create(kParent, "rig", kChild) == (SubtreeAnswer{SubtreeCreation{true, child, 2}}));
  CHECK_EQ(placeOf(kChild), kParent.str() + " rig " + kParent.str() + " 1 " + kAda.str() + " private [] 0");
  CHECK_EQ(placeOf(kParent), "- - " + kParent.str() + " 0 " + kAda.str() + " unlisted [Planted] 2");
  CHECK_EQ(kindsOf(kChild), std::string("build:terracotta:Build,learn:olive:Learn,milestone:gold:Milestone"));
  CHECK(forest.bus.subtreeBroadcasts == (std::vector<FakeBus::SubtreeBroadcast>{{kParent.str(), 2, nid("rig"), child}}));

  // A grandchild sits under the same root, one deeper.
  forest.edit(kChild, kAda, {{"knot", nullptr}});
  CHECK(forest.create(kChild, "knot", kGrandchild) ==
        (SubtreeAnswer{SubtreeCreation{true, Subtree{kGrandchild, kParent, OwningStep{kChild, nid("knot")}, 2, 0}, 2}}));
  CHECK_EQ(placeOf(kGrandchild), kChild.str() + " knot " + kParent.str() + " 2 " + kAda.str() + " private [] 0");

  // The reply was lost and the server restarted: the same call answers the child the row holds, its own head with it.
  Forest restarted;
  CHECK(restarted.create(kParent, "rig", kChild) ==
        (SubtreeAnswer{SubtreeCreation{false, Subtree{kChild, kParent, OwningStep{kParent, nid("rig")}, 1, 2}, 2}}));
  CHECK_EQ(childrenOf(kParent), 1L);
  CHECK_EQ(storedHead(kParent), Seq{2});
  CHECK(restarted.bus.subtreeBroadcasts.empty());
}

// A subtree create writes no op row: it moves the parent's stored head in the transaction that stores the child. So a
// room that opens from its snapshot alone holds it whole. After a restart the parent stands at the create's seq, with no
// row of the log past its snapshot and none at that seq, and its next write takes the seq after and lands its row there.
TEST(pg_a_parent_reopened_from_its_snapshot_stands_at_its_subtree_creates_seq_and_writes_at_the_next) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  {
    Forest forest;
    forest.plant(kParent, kAda, {{"rig", nullptr}});
    CHECK(forest.create(kParent, "rig", kChild) ==
          (SubtreeAnswer{SubtreeCreation{true, Subtree{kChild, kParent, OwningStep{kParent, nid("rig")}, 1, 0}, 2}}));
  }
  PgOpLog log{pgTestPool()};
  CHECK_EQ(storedHead(kParent), Seq{2});
  CHECK(log.past(kParent, storedHead(kParent)) == LogPast{});
  std::vector<Seq> rows;
  for (const AppliedOp& op : log.since(kParent, 0)) rows.push_back(op.seq);
  CHECK_EQ(rows, (std::vector<Seq>{1}));

  Forest restarted;
  {
    std::lock_guard<std::mutex> strand(restarted.rooms.strandFor(kParent));
    CHECK_EQ(restarted.rooms.open(kParent)->head(), Seq{2});
  }
  restarted.edit(kParent, kAda, {{"mast", nullptr}});
  CHECK_EQ(storedHead(kParent), Seq{3});
  rows.clear();
  for (const AppliedOp& op : log.since(kParent, 0)) rows.push_back(op.seq);
  CHECK_EQ(rows, (std::vector<Seq>{1, 3}));
  CHECK_EQ(childrenOf(kParent), 1L);
}

TEST(pg_a_subtree_is_born_with_the_kinds_it_is_sent_in_the_creates_transaction) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  Forest forest;
  forest.plant(kParent, kAda, {{"rig", nullptr}});
  const std::vector<Kind> kinds{Kind{KindId{"drill"}, NodeColor::gold, "Drill", ""},
                                Kind{KindId{"read"}, NodeColor::sky, "Read", ""}};
  REQUIRE(std::holds_alternative<SubtreeCreation>(
      forest.registry.createSubtree(kParent, nid("rig"), kAda, {kChild, kinds})));
  CHECK_EQ(kindsOf(kChild), std::string("drill:gold:Drill,read:sky:Read"));
  forest.rooms.sweep(std::chrono::steady_clock::duration::zero());
  std::lock_guard<std::mutex> strand(forest.rooms.strandFor(kChild));
  REQUIRE(forest.rooms.open(kChild) != nullptr);
  CHECK_EQ(forest.rooms.open(kChild)->kinds().size(), 2u);
}

TEST(pg_two_creates_on_one_step_at_once_store_one_row_and_tell_one_event) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  for (int round = 0; round < 10; ++round) {
    resetSubtrees();
    Forest forest;
    forest.plant(kParent, kAda, {{"rig", nullptr}});
    std::promise<void> start;
    const std::shared_future<void> go = start.get_future().share();
    const auto create = [&forest, go] {
      go.wait();
      return forest.create(kParent, "rig");
    };
    std::future<SubtreeAnswer> first = std::async(std::launch::async, create);
    std::future<SubtreeAnswer> second = std::async(std::launch::async, create);
    start.set_value();
    const SubtreeAnswer a = first.get();
    const SubtreeAnswer b = second.get();

    REQUIRE(std::holds_alternative<SubtreeCreation>(a) && std::holds_alternative<SubtreeCreation>(b));
    CHECK(std::get<SubtreeCreation>(a).created != std::get<SubtreeCreation>(b).created);
    CHECK(std::get<SubtreeCreation>(a).subtree == std::get<SubtreeCreation>(b).subtree);
    CHECK_EQ(childrenOf(kParent), 1L);
    CHECK_EQ(forest.bus.subtreeBroadcasts.size(), 1u);
  }
}

// Two server processes, each with its own strands, on one step: the one whose insert waits on the other's answers the
// other's child, with nothing written and no failure.
TEST(pg_two_processes_creating_under_one_step_answer_one_child_and_neither_fails) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  WriteLines door;
  Forest first(9500);
  Forest second(9600);
  first.plant(kParent, kAda, {{"rig", nullptr}});
  {
    std::lock_guard<std::mutex> strand(second.rooms.strandFor(kParent));
    REQUIRE(second.rooms.open(kParent) != nullptr);  // the second process's room, at the head before the create
  }
  pauseOn("INSERT", "new.parent_tree = '" + kParent.str() + "'");
  std::future<SubtreeAnswer> winning = std::async(std::launch::async, [&first] { return first.create(kParent, "rig"); });
  std::this_thread::sleep_for(std::chrono::milliseconds(300));
  const SubtreeAnswer losing = second.create(kParent, "rig");
  const SubtreeAnswer won = winning.get();
  unplant();

  const Subtree child{TreeId{"t_d9501"}, kParent, OwningStep{kParent, nid("rig")}, 1, 0};
  CHECK(won == (SubtreeAnswer{SubtreeCreation{true, child, 2}}));
  CHECK(losing == (SubtreeAnswer{SubtreeCreation{false, child, 2}}));
  CHECK_EQ(childrenOf(kParent), 1L);
  CHECK_EQ(storedHead(kParent), Seq{2});
  CHECK(door.sortedLines() == (std::vector<std::string>{"roadmap.subtree.create internal ok",
                                                         "roadmap.subtree.create internal unchanged"}));
  CHECK(door.reports.empty());
}

// One process, two parents on different strands, one proposed id: the create whose insert waits on the other's mints.
TEST(pg_a_proposed_id_another_create_takes_meanwhile_is_replaced_by_a_minted_one) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  WriteLines door;
  Forest forest(9700);
  forest.plant(kParent, kAda, {{"rig", nullptr}});
  forest.plant(kOther, kAda, {{"rig", nullptr}});
  REQUIRE(&forest.rooms.strandFor(kParent) != &forest.rooms.strandFor(kOther));
  pauseOn("INSERT", "new.parent_tree = '" + kParent.str() + "'");
  std::future<SubtreeAnswer> first =
      std::async(std::launch::async, [&forest] { return forest.create(kParent, "rig", kChild); });
  std::this_thread::sleep_for(std::chrono::milliseconds(300));
  const SubtreeAnswer second = forest.create(kOther, "rig", kChild);
  CHECK(first.get() == (SubtreeAnswer{SubtreeCreation{true, Subtree{kChild, kParent, OwningStep{kParent, nid("rig")}, 1, 0}, 2}}));
  unplant();

  CHECK(second ==
        (SubtreeAnswer{SubtreeCreation{true, Subtree{TreeId{"t_d9701"}, kOther, OwningStep{kOther, nid("rig")}, 1, 0}, 2}}));
  CHECK(door.sortedLines() == (std::vector<std::string>{"roadmap.subtree.create internal ok",
                                                         "roadmap.subtree.create internal ok"}));
  CHECK(door.reports.empty());
}

TEST(pg_a_proposed_id_another_accounts_tree_or_a_deleted_tree_holds_is_replaced_by_a_minted_one) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  Forest forest;
  forest.plant(kParent, kAda, {{"rig", nullptr}, {"sail", nullptr}});
  forest.plant(kBeas, kBea, {});
  forest.plant(kGone, kAda, {});
  forest.trees.softDelete(kGone);

  const auto idOf = [&forest](const char* step, const TreeId& proposed) {
    return std::get<SubtreeCreation>(forest.create(kParent, step, proposed)).subtree.id.str();
  };
  CHECK_EQ(idOf("rig", kBeas), std::string("t_d9001"));
  CHECK_EQ(idOf("sail", kGone), std::string("t_d9002"));
  CHECK_EQ(placeOf(kBeas), "- - " + kBeas.str() + " 0 " + kBea.str() + " private [Planted] 0");
}

// The pointer is judged in the same read as the rest of the site: valid only at a standing tree of the parent's owner.
TEST(pg_a_step_whose_pointer_opens_a_standing_tree_of_its_owner_is_refused_and_one_whose_pointer_leads_nowhere_is_not) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  Forest forest;
  forest.plant(kOther, kAda, {});
  forest.plant(kBeas, kBea, {});
  forest.plant(kGone, kAda, {});
  forest.trees.softDelete(kGone);
  forest.plant(kParent, kAda, {{"valid", "t_5ab0000000000002"}, {"foreign", "t_5ab0000000000003"},
                               {"deleted", "t_5ab0000000000004"}, {"absent", "t_5ab0000000000009"}});

  CHECK(forest.create(kParent, "valid") == SubtreeAnswer{SubtreeRefusal::stepOpensATree});
  for (const char* step : {"foreign", "deleted", "absent"})
    CHECK(std::get<SubtreeCreation>(forest.create(kParent, step)).created);
  CHECK_EQ(childrenOf(kParent), 3L);
}

// The store holds the place whatever writes it: an insert naming a parent is given that parent's root, owner and depth,
// whatever else it names, and is refused under a parent that does not stand or that sits at the cap.
TEST(pg_the_store_gives_an_inserted_subtree_its_place_and_refuses_a_parent_gone_or_at_the_cap) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  Forest forest;
  forest.plant(kParent, kAda, {});
  forest.plant(kOther, kBea, {});
  REQUIRE(forest.registry.setVisibility(kOther, kBea, Visibility::public_) ==
          (std::variant<TreeRegistry::VisibilityChange, NotARoot>{TreeRegistry::VisibilityChange::changed}));
  runSql("INSERT INTO trees (id, owner_id, visibility, parent_tree, parent_step, root_tree, depth) VALUES ('" +
         kChild.str() + "', '" + kBea.str() + "', 'public', '" + kParent.str() + "', 'rig', '" + kOther.str() + "', 99)");
  CHECK_EQ(placeOf(kChild), kParent.str() + " rig " + kParent.str() + " 1 " + kAda.str() + " private [] 0");

  const auto refusedWith = [](const std::string& statement) -> std::string {
    try {
      runSql(statement);
    } catch (const pqxx::foreign_key_violation&) {
      return "foreign key";
    } catch (const pqxx::check_violation&) {
      return "check";
    }
    return "stored";
  };
  const auto under = [](const std::string& id, const TreeId& parent, const char* step) {
    return "INSERT INTO trees (id, parent_tree, parent_step) VALUES ('" + id + "', '" + parent.str() + "', '" + step + "')";
  };
  CHECK_EQ(refusedWith(under("t_5ab00000000000d1", TreeId{"t_5ab00000000000ff"}, "x")), std::string("foreign key"));
  forest.trees.softDelete(kOther);
  CHECK_EQ(refusedWith(under("t_5ab00000000000d2", kOther, "x")), std::string("foreign key"));

  // A chain to the cap: the parent at depth 8 takes no subtree.
  TreeId above = kParent;
  for (int depth = 1; depth <= kMaxTreeDepth; ++depth) {
    const std::string id = "t_5ab00000000000e" + std::to_string(depth);
    REQUIRE_EQ(refusedWith(under(id, above, "x")), std::string("stored"));
    above = TreeId{id};
  }
  CHECK_EQ(placeOf(above), "t_5ab00000000000e7 x " + kParent.str() + " 8 " + kAda.str() + " private [] 0");
  CHECK_EQ(refusedWith(under("t_5ab00000000000f9", above, "x")), std::string("check"));
}

TEST(pg_a_trees_parent_step_root_and_depth_refuse_every_update_and_its_other_columns_do_not) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  Forest forest;
  forest.plant(kParent, kAda, {{"rig", nullptr}});
  forest.plant(kOther, kAda, {});
  forest.create(kParent, "rig", kChild);
  const std::string before = placeOf(kChild);

  for (const std::string& assignment : {std::string("parent_tree = '") + kOther.str() + "'", std::string("parent_tree = NULL"),
                                        std::string("parent_step = 'sail'"), std::string("root_tree = '") + kOther.str() + "'",
                                        std::string("depth = 0")}) {
    bool refused = false;
    try {
      runSql("UPDATE trees SET " + assignment + " WHERE id = '" + kChild.str() + "'");
    } catch (const pqxx::integrity_constraint_violation&) {
      refused = true;
    }
    CHECK(refused);
  }
  bool rootRefused = false;
  try {
    runSql("UPDATE trees SET root_tree = '" + kChild.str() + "' WHERE id = '" + kParent.str() + "'");
  } catch (const pqxx::integrity_constraint_violation&) {
    rootRefused = true;
  }
  CHECK(rootRefused);
  CHECK_EQ(placeOf(kChild), before);

  runSql("UPDATE trees SET title = 'Rigging', depth = depth WHERE id = '" + kChild.str() + "'");
  CHECK_EQ(placeOf(kChild), kParent.str() + " rig " + kParent.str() + " 1 " + kAda.str() + " private [Rigging] 0");
}

TEST(pg_one_subtree_per_step_holds_under_a_direct_insert_that_bypasses_the_room) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  Forest forest;
  forest.plant(kParent, kAda, {{"rig", nullptr}});
  forest.create(kParent, "rig", kChild);

  bool refused = false;
  try {
    runSql("INSERT INTO trees (id, parent_tree, parent_step) VALUES ('" + kGrandchild.str() + "', '" + kParent.str() +
           "', 'rig')");
  } catch (const pqxx::unique_violation&) {
    refused = true;
  }
  CHECK(refused);
  CHECK_EQ(childrenOf(kParent), 1L);
  CHECK_EQ(placeOf(kGrandchild), std::string(""));
}

// The child and the parent's seq are one transaction: a fault after the child's insert, at the parent's head, takes the
// child back with it, and a fault on the insert writes nothing. Neither tells anyone, and a retry then creates it.
TEST(pg_a_create_that_fails_after_the_insert_or_on_it_leaves_no_row_no_seq_and_no_event) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  Forest forest;
  forest.plant(kParent, kAda, {{"rig", nullptr}});
  for (const std::string& event : {std::string("BEFORE UPDATE OF head_seq"), std::string("BEFORE INSERT")}) {
    plantOn(event, event == "BEFORE INSERT" ? "new.parent_tree = '" + kParent.str() + "'" : "new.id = '" + kParent.str() + "'",
            "RAISE EXCEPTION 'a planted fault';");
    bool threw = false;
    try {
      forest.create(kParent, "rig", kChild);
    } catch (const pqxx::sql_error&) {
      threw = true;
    }
    unplant();
    CHECK(threw);
    CHECK_EQ(placeOf(kChild), std::string(""));
    CHECK_EQ(storedHead(kParent), Seq{1});
    CHECK_EQ(forest.rooms.open(kParent)->head(), Seq{1});
    CHECK(forest.bus.subtreeBroadcasts.empty());
  }

  CHECK(forest.create(kParent, "rig", kChild) ==
        (SubtreeAnswer{SubtreeCreation{true, Subtree{kChild, kParent, OwningStep{kParent, nid("rig")}, 1, 0}, 2}}));
}

// A commit whose answer was lost though it landed: the retry answers a seq at or past the child's, and the parent's next
// write takes the seq after it, never the child's.
TEST(pg_a_retry_after_a_lost_commit_answer_answers_a_seq_past_the_childs_and_the_next_write_takes_the_one_after) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  Forest forest;
  forest.plant(kParent, kAda, {{"rig", nullptr}});
  forest.trees.commitAnswerLost = true;
  bool threw = false;
  try {
    forest.create(kParent, "rig", kChild);
  } catch (const pqxx::in_doubt_error&) {
    threw = true;
  }
  CHECK(threw);
  CHECK_EQ(storedHead(kParent), Seq{2});

  CHECK(forest.create(kParent, "rig", kChild) ==
        (SubtreeAnswer{SubtreeCreation{false, Subtree{kChild, kParent, OwningStep{kParent, nid("rig")}, 1, 0}, 2}}));
  forest.edit(kParent, kAda, {{"after", nullptr}});
  CHECK_EQ(storedHead(kParent), Seq{3});
}

// An erasure of the owner's account racing a create: the create holds the account as create and fork hold it, so the
// erasure waits for the child and takes it too.
TEST(pg_an_account_erasure_racing_a_subtree_create_takes_the_child_with_the_account) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  Forest forest;
  forest.plant(kParent, kAda, {{"rig", nullptr}});
  PgAuthRepository accounts{pgTestPool(), nullptr, {roadmapAccountErasure()}};
  accounts.markUserDeleted(kAda, 1, 2);
  pauseOn("UPDATE OF head_seq", "new.id = '" + kParent.str() + "' AND new.head_seq <> old.head_seq");
  std::future<SubtreeAnswer> creating =
      std::async(std::launch::async, [&forest] { return forest.create(kParent, "rig", kChild); });
  std::this_thread::sleep_for(std::chrono::milliseconds(300));
  CHECK(accounts.eraseAccount(kAda, 2));
  CHECK(std::get<SubtreeCreation>(creating.get()).created);
  unplant();

  CHECK_EQ(placeOf(kChild), std::string(""));
  CHECK_EQ(placeOf(kParent), std::string(""));
}

// The tree's removal takes its strand too: the child is made and then the tree removed, or the tree is removed and the
// create refused. Never a child stored under a tree already gone.
TEST(pg_a_create_racing_the_removal_of_its_parent_lands_in_one_order_or_the_other) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  for (int round = 0; round < 10; ++round) {
    resetSubtrees();
    Forest forest;
    forest.plant(kParent, kAda, {{"rig", nullptr}});
    std::promise<void> start;
    const std::shared_future<void> go = start.get_future().share();
    std::future<SubtreeAnswer> creating = std::async(std::launch::async, [&forest, go] {
      go.wait();
      return forest.create(kParent, "rig", kChild);
    });
    std::future<std::variant<Cascade, TreeRegistry::RemovalRefusal, NotARoot>> removing =
        std::async(std::launch::async, [&forest, go] {
          go.wait();
          return forest.registry.remove(kParent, kAda);
        });
    start.set_value();
    const SubtreeAnswer answer = creating.get();
    CHECK(removing.get() == (std::variant<Cascade, TreeRegistry::RemovalRefusal, NotARoot>{Cascade{}}));

    CHECK_FALSE(forest.trees.loadAccess(kParent).has_value());
    CHECK_FALSE(forest.rooms.accessOf(kChild).has_value());
    if (answer == SubtreeAnswer{SubtreeRefusal::noSuchTree}) {
      CHECK_EQ(placeOf(kChild), std::string(""));
      CHECK(forest.bus.subtreeBroadcasts.empty());
      continue;
    }
    CHECK(answer == (SubtreeAnswer{SubtreeCreation{true, Subtree{kChild, kParent, OwningStep{kParent, nid("rig")}, 1, 0}, 2}}));
    CHECK_EQ(childrenOf(kParent), 1L);
    CHECK_EQ(forest.bus.subtreeBroadcasts.size(), 1u);
  }
}

// A parent removed or erased after the site was read, as an erasure outside the room can: neither row is written.
TEST(pg_a_subtree_under_a_parent_that_no_longer_stands_is_not_stored_and_moves_no_seq) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  Forest forest;
  forest.plant(kParent, kAda, {{"rig", nullptr}});
  forest.trees.softDelete(kParent);
  const auto stored = [&forest] {
    return forest.trees.createSubtree(kChild, OwningStep{kParent, nid("rig")}, LegendState{}, 2);
  };

  CHECK(stored() == (std::variant<Subtree, SubtreeConflict>{SubtreeConflict::parentGone}));
  CHECK_EQ(placeOf(kChild), std::string(""));
  CHECK_EQ(storedHead(kParent), Seq{1});
  runSql("DELETE FROM trees WHERE id = '" + kParent.str() + "'");
  CHECK(stored() == (std::variant<Subtree, SubtreeConflict>{SubtreeConflict::parentGone}));
  CHECK_EQ(placeOf(kChild), std::string(""));
}

// A subtree is read by its root's row: the root's visibility admits its readers, a change aimed at the subtree alone is
// refused and writes nothing, and the root's removal takes it out of reach, closed or live.
TEST(pg_a_subtree_admits_whom_its_root_admits_and_no_one_once_its_root_is_removed) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  Forest forest;
  forest.plant(kParent, kAda, {{"rig", nullptr}, {"sail", nullptr}});
  forest.create(kParent, "rig", kChild);
  forest.create(kParent, "sail", kGrandchild);
  REQUIRE(forest.registry.setVisibility(kParent, kAda, Visibility::public_) ==
          (std::variant<TreeRegistry::VisibilityChange, NotARoot>{TreeRegistry::VisibilityChange::changed}));
  forest.rooms.sweep(std::chrono::steady_clock::duration::zero());
  CHECK(strangerReads(forest.rooms, kChild));  // closed: the root's row

  CHECK(forest.registry.setVisibility(kChild, kAda, Visibility::private_) ==
        (std::variant<TreeRegistry::VisibilityChange, NotARoot>{NotARoot{OwningStep{kParent, nid("rig")}, kParent}}));
  forest.trees.setVisibility(kChild, Visibility::public_);
  CHECK_EQ(placeOf(kChild), kParent.str() + " rig " + kParent.str() + " 1 " + kAda.str() + " private [] 0");

  TreeRoom* live = nullptr;
  {
    std::lock_guard<std::mutex> strand(forest.rooms.strandFor(kChild));
    live = forest.rooms.open(kChild);
  }
  REQUIRE(live != nullptr);
  CHECK(forest.registry.remove(kParent, kAda) == (std::variant<Cascade, TreeRegistry::RemovalRefusal, NotARoot>{Cascade{}}));
  CHECK_FALSE(forest.rooms.accessOf(kChild).has_value());       // live
  CHECK_FALSE(forest.rooms.accessOf(kGrandchild).has_value());  // closed
  CHECK_FALSE(live->readableBy(kAda));
  CHECK_FALSE(forest.trees.load(kGrandchild).has_value());
}

// A subtree's room opened while its root turns private: the room's access is read under the root's lock, which the
// change holds, so it never answers the visibility the root left.
TEST(pg_a_subtree_room_opened_across_its_roots_visibility_change_takes_the_new_one) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  Forest forest;
  forest.plant(kParent, kAda, {{"rig", nullptr}});
  REQUIRE(forest.registry.setVisibility(kParent, kAda, Visibility::public_) ==
          (std::variant<TreeRegistry::VisibilityChange, NotARoot>{TreeRegistry::VisibilityChange::changed}));
  REQUIRE(std::get<SubtreeCreation>(forest.create(kParent, "rig", kChild)).created);
  forest.rooms.sweep(std::chrono::steady_clock::duration::zero());
  REQUIRE(&forest.rooms.strandFor(kParent) != &forest.rooms.strandFor(kChild));

  forest.trees.afterLoad = [&forest](const TreeId& loaded) {
    if (loaded != kChild) return;
    std::async(std::launch::async, [&forest] {
      return forest.registry.setVisibility(kParent, kAda, Visibility::private_);
    }).get();
  };
  {
    std::lock_guard<std::mutex> strand(forest.rooms.strandFor(kChild));
    REQUIRE(forest.rooms.open(kChild) != nullptr);
  }
  CHECK_FALSE(strangerReads(forest.rooms, kChild));
  CHECK(forest.rooms.accessOf(kChild)->visibility == Visibility::private_);
}

// A grandchild created under a subtree on its own strand while the root turns private: it is read by the root, so the
// stranger the root now refuses is refused it too.
TEST(pg_a_grandchild_created_across_its_roots_visibility_change_is_read_by_the_roots_new_one) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  Forest forest;
  forest.plant(kParent, kAda, {{"rig", nullptr}});
  REQUIRE(forest.registry.setVisibility(kParent, kAda, Visibility::public_) ==
          (std::variant<TreeRegistry::VisibilityChange, NotARoot>{TreeRegistry::VisibilityChange::changed}));
  REQUIRE(std::get<SubtreeCreation>(forest.create(kParent, "rig", kChild)).created);
  forest.edit(kChild, kAda, {{"knot", nullptr}});
  REQUIRE(&forest.rooms.strandFor(kParent) != &forest.rooms.strandFor(kChild));
  pauseOn("INSERT", "new.parent_tree = '" + kChild.str() + "'");
  std::future<SubtreeAnswer> creating =
      std::async(std::launch::async, [&forest] { return forest.create(kChild, "knot", kGrandchild); });
  std::this_thread::sleep_for(std::chrono::milliseconds(300));
  REQUIRE(forest.registry.setVisibility(kParent, kAda, Visibility::private_) ==
          (std::variant<TreeRegistry::VisibilityChange, NotARoot>{TreeRegistry::VisibilityChange::changed}));
  CHECK(std::get<SubtreeCreation>(creating.get()).created);
  unplant();

  CHECK_FALSE(strangerReads(forest.rooms, kGrandchild));
  forest.rooms.sweep(std::chrono::steady_clock::duration::zero());
  CHECK_FALSE(strangerReads(forest.rooms, kGrandchild));
}

// An older image inserts a tree naming none of the place's columns; the row is a root all the same.
TEST(pg_a_row_inserted_without_a_parent_is_its_own_root_at_depth_zero) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  runSql("INSERT INTO trees (id, title, head_seq, owner_id) VALUES ('" + kOther.str() + "', 'Older image', 0, '" +
         kAda.str() + "')");
  runSql("INSERT INTO trees (id, owner_id, root_tree, depth) VALUES ('" + kGone.str() + "', '" + kAda.str() + "', '" +
         kParent.str() + "', 3)");
  CHECK_EQ(placeOf(kOther), "- - " + kOther.str() + " 0 " + kAda.str() + " private [Older image] 0");
  CHECK_EQ(placeOf(kGone), "- - " + kGone.str() + " 0 " + kAda.str() + " private [] 0");
}

// The read the subtree inventory counts: every account's standing trees, each with how many of its present steps open
// each tree and whether that tree is the account's deleted one or someone else's, account after account across pages.
TEST(pg_each_accounts_trees_reads_every_accounts_standing_trees_with_their_present_steps_pointers_once_per_account) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  const UserId mine{std::string("1a1a0000-0000-4000-8000-00000000a11a")};
  const UserId theirs{std::string("2b2b0000-0000-4000-8000-00000000b22b")};
  const UserId many{std::string("3c3c0000-0000-4000-8000-00000000c33c")};
  const std::string missing = "t_00000000000000e9";
  const auto clear = [] {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("DELETE FROM tree_nodes WHERE tree_id LIKE 't\\_pginv\\_%'");
    txn.exec("DELETE FROM trees WHERE id LIKE 't\\_pginv\\_%'");
    txn.commit();
  };
  clear();
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    REQUIRE(txn.exec_params("SELECT 1 FROM trees WHERE id = $1", missing).empty());
    const auto plant = [&](const std::string& tree, const UserId& owner, bool deleted) {
      txn.exec_params("INSERT INTO trees (id, title, owner_id, deleted_at) "
                      "VALUES ($1, 'Tree ' || $1, $2::uuid, CASE WHEN $3 THEN now() END)",
                      tree, owner.str(), deleted);
    };
    const auto step = [&](const std::string& tree, const std::string& node, const std::string& opens, bool present) {
      txn.exec_params("INSERT INTO tree_nodes (tree_id, node_id, created_hlc, label, opens, opens_hlc, present) "
                      "VALUES ($1, $2, '1:0:r_a', 'Step', $3, '1:0:r_a', $4)",
                      tree, node, opens, present);
    };
    plant("t_pginv_root", mine, false);
    plant("t_pginv_child", mine, false);
    plant("t_pginv_bare", mine, false);
    plant("t_pginv_gone", mine, true);
    plant("t_pginv_theirs", theirs, false);
    plant("t_pginv_theirs_gone", theirs, true);
    step("t_pginv_root", "twice-1", "t_pginv_child", true);
    step("t_pginv_root", "twice-2", "t_pginv_child", true);
    step("t_pginv_root", "at-deleted", "t_pginv_gone", true);
    step("t_pginv_root", "at-theirs", "t_pginv_theirs", true);
    step("t_pginv_root", "at-their-deleted", "t_pginv_theirs_gone", true);
    step("t_pginv_root", "free-text", "piano lessons", true);
    step("t_pginv_root", "at-missing", missing, true);
    step("t_pginv_root", "deleted-step", "t_pginv_bare", false);
    step("t_pginv_root", "plain", "", true);
    step("t_pginv_child", "itself", "t_pginv_child", true);
    step("t_pginv_gone", "from-a-deleted-tree", "t_pginv_bare", true);
    step("t_pginv_theirs", "at-mine", "t_pginv_root", true);
    txn.exec("INSERT INTO trees (id, title, owner_id) VALUES ('t_pginv_nobody', 'Nobody''s tree', NULL)");
    step("t_pginv_nobody", "at-mine", "t_pginv_root", true);
    txn.exec_params("INSERT INTO trees (id, title, owner_id) "
                    "SELECT 't_pginv_many_' || g, 'Many', $1::uuid FROM generate_series(1, 1500) g",
                    many.str());
    txn.commit();
  }

  PgTreeRepository trees{pgTestPool()};
  std::map<UserId, AccountTrees> read;
  std::vector<UserId> visited;
  bool nobodysTreeRead = false;
  trees.eachAccountsTrees([&](const UserId& owner, const AccountTrees& account) {
    visited.push_back(owner);
    if (account.standing.count(TreeId{"t_pginv_nobody"})) nobodysTreeRead = true;
    if (owner == mine || owner == theirs || owner == many) read.emplace(owner, account);
  });

  const auto id = [](const std::string& tree) { return TreeId{tree}; };
  const AccountTrees expectedMine{
      .standing = {{id("t_pginv_root"),
                    {{id("t_pginv_child"), 2},
                     {id("t_pginv_gone"), 1},
                     {id("t_pginv_theirs"), 1},
                     {id("t_pginv_theirs_gone"), 1},
                     {id("piano lessons"), 1},
                     {id(missing), 1}}},
                   {id("t_pginv_child"), {{id("t_pginv_child"), 1}}},
                   {id("t_pginv_bare"), {}}},
      .deleted = {id("t_pginv_gone")},
      .foreign = {id("t_pginv_theirs"), id("t_pginv_theirs_gone")}};
  const AccountTrees expectedTheirs{.standing = {{id("t_pginv_theirs"), {{id("t_pginv_root"), 1}}}},
                                    .foreign = {id("t_pginv_root")}};
  REQUIRE_EQ(read.size(), 3u);
  CHECK(read.at(mine) == expectedMine);
  CHECK(read.at(theirs) == expectedTheirs);
  CHECK_EQ(read.at(many).standing.size(), 1500u);
  CHECK(std::set<UserId>(visited.begin(), visited.end()).size() == visited.size());
  CHECK_FALSE(nobodysTreeRead);

  // The answer the fakes give: two roots, the tree opened twice and by itself on a loop of one that two steps enter, and
  // a step per way a pointer can fail.
  SubtreeInventory counted;
  counted.trees = 4;
  counted.roots = 2;
  counted.cycles = {
      .trees = 1, .selfPointers = 1, .alsoMultiOpened = 1, .loops = {.one = 1}, .byEntries = {.twoOrMore = 1}};
  counted.depthIfResolved = {.deepest = 1, .one = 1};
  counted.dangling = {.missing = 1, .deleted = 1, .foreign = 2, .notATreeId = 1};
  counted.accounts = {.withPointers = 1, .needingChoice = 1};
  CHECK(inventory(read.at(mine)) == counted);

  // Each tree's pointers are read by its key on tree_nodes_pointers_idx, with sequential scans off so a table of a few
  // pages is not rightly read whole. A scan names the index it reads, a bitmap heap scan the index scans under it.
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec("SET LOCAL enable_seqscan = off");
    const pqxx::result explained =
        txn.exec(std::string("EXPLAIN (FORMAT JSON) ") + PgTreeRepository::accountsTreesStatement());
    std::set<std::string> nodeReads;
    std::vector<std::pair<Json::Value, bool>> nodes{{parse(explained[0][0].as<std::string>())[0]["Plan"], false}};
    while (!nodes.empty()) {
      const auto [node, underNodes] = nodes.back();
      nodes.pop_back();
      const bool readsNodes = node["Relation Name"].asString() == "tree_nodes";
      if (readsNodes || underNodes) nodeReads.insert(node.get("Index Name", node["Node Type"]).asString());
      for (const Json::Value& child : node["Plans"])
        nodes.push_back({child, readsNodes && node["Node Type"].asString() == "Bitmap Heap Scan"});
    }
    nodeReads.erase("Bitmap Heap Scan");
    CHECK(nodeReads == std::set<std::string>{"tree_nodes_pointers_idx"});
  }
  clear();
}

// A subtree is read through its parents: its name is its owning step's label, its way down runs from its root with each
// tree on it named the same way, and it stands only while its root does. The owner's list holds it with the step it
// hangs from, that step opening it; the gallery lists its root alone, the step opening it under no stamp.
TEST(pg_a_grandchild_is_named_and_placed_through_its_parents_and_listed_beside_its_root_for_its_owner_alone) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  Forest forest;
  forest.plant(kParent, kAda, {{"sail", nullptr}, {"coast", nullptr}});
  REQUIRE(std::holds_alternative<SubtreeCreation>(forest.create(kParent, "sail", kChild)));
  forest.edit(kChild, kAda, {{"rig", nullptr}, {"knot", nullptr}});
  REQUIRE(std::holds_alternative<SubtreeCreation>(forest.create(kChild, "rig", kGrandchild)));
  REQUIRE(forest.registry.rename(kChild, kAda, "Learn to sail") == TreeRegistry::Renaming::renamed);
  PgTreeRepository trees{pgTestPool()};

  std::optional<Place> place = trees.placeOf(kGrandchild);
  REQUIRE(place.has_value());
  CHECK(place->titleAt.isSet());
  place->titleAt = Hlc{};
  CHECK(*place == (Place{"rig", Hlc{}, kParent, OwningStep{kChild, nid("rig")},
                         {PathStep{kParent, nid("sail"), "Planted"}, PathStep{kChild, nid("rig"), "Learn to sail"}}, 2}));
  CHECK(trees.placeOf(kParent) == (std::optional<Place>(Place{"Planted", Hlc{}, kParent, std::nullopt, {}, 0})));
  CHECK(trees.loadAccess(kGrandchild)->access.parent() == (std::optional<OwningStep>(OwningStep{kChild, nid("rig")})));
  const std::optional<StoredTree> child = trees.load(kChild);
  REQUIRE(child.has_value());
  CHECK(child->path == (std::vector<OwningStep>{OwningStep{kParent, nid("sail")}}));
  CHECK(child->subtrees == (std::map<NodeId, TreeId>{{nid("rig"), kGrandchild}}));

  std::map<TreeId, OwnedTree> owned;
  for (OwnedTree& tree : trees.listOwnedBy(kAda)) owned.emplace(tree.data.id, std::move(tree));
  REQUIRE_EQ(owned.size(), 3u);
  CHECK_FALSE(owned[kParent].parent.has_value());
  CHECK(owned[kChild].parent == (std::optional<OwningStep>(OwningStep{kParent, nid("sail")})));
  CHECK(owned[kGrandchild].parent == (std::optional<OwningStep>(OwningStep{kChild, nid("rig")})));
  std::map<NodeId, TreeId> opened;
  for (const NodeSpec& node : owned[kParent].data.nodes) opened.emplace(node.id, node.opens);
  CHECK(opened == (std::map<NodeId, TreeId>{{nid("coast"), TreeId{}}, {nid("sail"), kChild}}));

  REQUIRE(forest.registry.setVisibility(kParent, kAda, Visibility::public_) ==
          (std::variant<TreeRegistry::VisibilityChange, NotARoot>{TreeRegistry::VisibilityChange::changed}));
  std::vector<ListedTree> listed;
  for (ListedTree& tree : trees.listPublic())
    if (tree.owner == kAda) listed.push_back(std::move(tree));
  REQUIRE_EQ(listed.size(), 1u);
  CHECK(listed[0].data.id == kParent);
  CHECK(listed[0].pointers == (std::map<NodeId, StampedPointer>{{nid("sail"), {kChild, Hlc{}}}}));

  REQUIRE(std::holds_alternative<Cascade>(forest.registry.remove(kParent, kAda)));
  CHECK_FALSE(trees.placeOf(kGrandchild).has_value());
}

// The owner's walk follows each step into the subtree it owns, whatever the step's pointer holds: the step is done once
// every step below it is, however deep, and open again when a leaf below reopens; an empty subtree is unfinished.
// Reminder readiness judges the account the same way, and answers its roots alone.
TEST(pg_the_owners_walk_follows_each_step_into_the_subtree_it_owns_whatever_its_pointer_holds) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  Forest forest;
  forest.plant(kOther, kAda, {{"far", nullptr}});
  forest.plant(kParent, kAda, {{"sail", nullptr}, {"empty", nullptr}});
  REQUIRE(std::holds_alternative<SubtreeCreation>(forest.create(kParent, "sail", kChild)));
  const SubtreeAnswer emptied = forest.create(kParent, "empty");
  REQUIRE(std::holds_alternative<SubtreeCreation>(emptied));
  const TreeId empty = std::get<SubtreeCreation>(emptied).subtree.id;
  forest.edit(kChild, kAda, {{"rig", nullptr}, {"knot", nullptr}});
  REQUIRE(std::holds_alternative<SubtreeCreation>(forest.create(kChild, "rig", kGrandchild)));
  forest.edit(kGrandchild, kAda, {{"bowline", nullptr}});
  {
    std::lock_guard<std::mutex> strand(forest.rooms.strandFor(kParent));
    forest.rooms.open(kParent)->applyCommand(AnnotateNode{nid("sail"), {}, {}, {}, {}, kOther}, forest.clock.nowMs(), kAda);
    REQUIRE(forest.rooms.persist(kParent) == Saved::saved);
  }
  const auto markAs = [&](const TreeId& tree, const char* step, ProgressStatus status) {
    const std::uint64_t ms = forest.clock.nowMs();
    forest.progressRepo.setStatuses(tree, kAda, {{nid(step), status, false, Hlc{ms, 0, "r_a"}}}, StampedBy::replica, ms);
  };
  markAs(kGrandchild, "bowline", ProgressStatus::complete);
  markAs(kChild, "knot", ProgressStatus::complete);
  PgTreeRepository trees{pgTestPool()};
  const auto openingOf = [&](const TreeId& tree) { return OpenedTrees(trees.openedFrom(kAda, {tree})).opening(tree); };

  CHECK(openingOf(kChild) == (Opening{kChild, false, "sail", true, 2, 2}));
  CHECK(openingOf(empty) == (Opening{empty, false, "empty", false, 0, 0}));
  TreeData parent;
  {
    std::lock_guard<std::mutex> strand(forest.rooms.strandFor(kParent));
    parent = forest.rooms.open(kParent)->snapshot();
  }
  CHECK(OpenedTrees(trees.openedFrom(kAda, treesOpenedBy(parent))).openings(parent) ==
        (std::map<NodeId, Opening>{{nid("empty"), {empty, false, "empty", false, 0, 0}},
                                   {nid("sail"), {kChild, false, "sail", true, 2, 2}}}));
  std::map<TreeId, std::string> readiness;
  for (const TreeReadiness& tree : PgReminderRepository{pgTestPool()}.readinessFor(kAda))
    readiness[tree.id] = tree.title + " " + std::to_string(tree.done) + "/" + std::to_string(tree.total);
  CHECK(readiness == (std::map<TreeId, std::string>{{kOther, "Planted 0/1"}, {kParent, "Planted 1/2"}}));

  markAs(kGrandchild, "bowline", ProgressStatus::none);
  CHECK(openingOf(kChild) == (Opening{kChild, false, "sail", false, 1, 2}));
}

// A subtree's guides above it are its ancestors', up its parents, farthest first, and a root's are the trees whose steps
// point at it: a pointer at a subtree makes nothing above it, and a step that owns a subtree points nowhere else.
TEST(pg_the_trees_above_a_subtree_are_its_ancestors_and_a_root_keeps_the_trees_that_point_at_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  Forest forest;
  forest.plant(kParent, kAda, {{"sail", nullptr}});
  REQUIRE(std::holds_alternative<SubtreeCreation>(forest.create(kParent, "sail", kChild)));
  forest.edit(kChild, kAda, {{"rig", nullptr}});
  REQUIRE(std::holds_alternative<SubtreeCreation>(forest.create(kChild, "rig", kGrandchild)));
  forest.plant(kOther, kAda, {{"to-parent", kParent.str().c_str()}, {"to-child", kChild.str().c_str()}});
  {
    std::lock_guard<std::mutex> strand(forest.rooms.strandFor(kParent));
    forest.rooms.open(kParent)->applyCommand(AnnotateNode{nid("sail"), {}, {}, {}, {}, kOther}, forest.clock.nowMs(), kAda);
    REQUIRE(forest.rooms.persist(kParent) == Saved::saved);
  }
  for (const auto& [tree, guide] : std::vector<std::pair<TreeId, const char*>>{
           {kOther, "Other."}, {kParent, "Parent."}, {kChild, "Child."}, {kGrandchild, "Grandchild."}})
    REQUIRE(std::holds_alternative<TreeRegistry::Described>(forest.registry.setGuide(tree, kAda, guide)));
  PgTreeRepository trees{pgTestPool()};

  CHECK(trees.guidedTreesAbove(kAda, kGrandchild) ==
        (std::map<TreeId, TreeAbove>{{kChild, {1, "sail", "Child.", false}},
                                     {kParent, {2, "Planted", "Parent.", false}},
                                     {kOther, {3, "Planted", "Other.", false}}}));
  CHECK(trees.guidedTreesAbove(kAda, kChild) ==
        (std::map<TreeId, TreeAbove>{{kParent, {1, "Planted", "Parent.", false}}, {kOther, {2, "Planted", "Other.", false}}}));
  CHECK(trees.guidedTreesAbove(kAda, kParent) == (std::map<TreeId, TreeAbove>{{kOther, {1, "Planted", "Other.", false}}}));
  CHECK(trees.guidedTreesAbove(kAda, kOther).empty());
}

// A subtree stands only while its root does, in the owner's list as in every other read: once its root is removed it is
// no tree of theirs to judge, and a pointer at it leads nowhere, as the walk a tree read makes says.
TEST(pg_the_owners_list_leaves_out_the_subtree_of_a_removed_root) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  Forest forest;
  forest.plant(kParent, kAda, {{"sail", nullptr}});
  REQUIRE(std::holds_alternative<SubtreeCreation>(forest.create(kParent, "sail", kChild)));
  forest.plant(kOther, kAda, {{"to-child", kChild.str().c_str()}});
  PgTreeRepository trees{pgTestPool()};
  const auto listed = [&] {
    std::set<TreeId> ids;
    for (const OwnedTree& tree : trees.listOwnedBy(kAda)) ids.insert(tree.data.id);
    return ids;
  };
  CHECK(listed() == (std::set<TreeId>{kParent, kChild, kOther}));

  REQUIRE(std::holds_alternative<Cascade>(forest.registry.remove(kParent, kAda)));
  CHECK(listed() == (std::set<TreeId>{kOther}));
  CHECK(trees.openedFrom(kAda, {kChild}).empty());
}

// A deleted owning step hides its branch from every read of the stored rows that judges standing — the access, the
// owner's list, the walk of what a tree opens, the guides above — at any depth, while the hidden trees keep their rows,
// their content and their place; the root's absent owning steps and its branch's size say the same. Its revive shows
// the branch again, and
// nothing retires a subtree's row by its id.
TEST(pg_a_deleted_owning_step_hides_its_branch_from_every_stored_read_and_its_revive_shows_it_again) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  Forest forest;
  forest.plant(kParent, kAda, {{"sail", nullptr}, {"coast", nullptr}});
  REQUIRE(std::holds_alternative<SubtreeCreation>(forest.create(kParent, "sail", kChild)));
  forest.edit(kChild, kAda, {{"rig", nullptr}, {"knot", nullptr}});
  REQUIRE(std::holds_alternative<SubtreeCreation>(forest.create(kChild, "rig", kGrandchild)));
  forest.edit(kGrandchild, kAda, {{"bowline", nullptr}});
  PgTreeRepository trees{pgTestPool()};
  const auto standing = [&] {
    std::set<TreeId> ids;
    for (const OwnedTree& tree : trees.listOwnedBy(kAda)) ids.insert(tree.data.id);
    return ids;
  };
  const auto setStep = [&](const TreeId& tree, const char* step, bool present, std::set<TreeId> branches) {
    std::lock_guard<std::mutex> strand(forest.rooms.strandFor(tree));
    TreeRoom* room = forest.rooms.open(tree);
    if (present) room->applyCommand(CreateNode{nid(step), step, "icon", NodeColor::sky}, forest.clock.nowMs(), kAda);
    else room->applyCommands({DeleteNode{nid(step)}}, forest.clock.nowMs(), kAda, branches);
    REQUIRE(forest.rooms.persist(tree) == Saved::saved);
  };
  CHECK(trees.branchSizes({kParent, kChild}) ==
        (std::map<TreeId, BranchSize>{{kParent, BranchSize{2, 5}}, {kChild, BranchSize{1, 3}}}));
  CHECK(trees.loadAccess(kGrandchild)->stands);

  setStep(kParent, "sail", false, {kChild});
  for (const TreeId& hidden : {kChild, kGrandchild}) {
    const std::optional<StoredAccess> access = trees.loadAccess(hidden);
    REQUIRE(access.has_value());
    CHECK_FALSE(access->stands);
    CHECK(trees.placeOf(hidden).has_value());  // where it sits is content: whether it stands is the gate's
    CHECK(trees.load(hidden).has_value());
  }
  CHECK(trees.loadAccess(kGrandchild)->access.path ==
        (std::vector<OwningStep>{OwningStep{kParent, nid("sail")}, OwningStep{kChild, nid("rig")}}));
  CHECK(standing() == (std::set<TreeId>{kParent}));
  CHECK(trees.openedFrom(kAda, {kChild, kGrandchild}).empty());
  CHECK(trees.guidedTreesAbove(kAda, kGrandchild).empty());
  CHECK(trees.absentStepsUnder(kParent) == (std::set<OwningStep>{OwningStep{kParent, nid("sail")}}));
  CHECK(trees.branchSizes({kParent}) == (std::map<TreeId, BranchSize>{{kParent, BranchSize{0, 1}}}));

  setStep(kChild, "rig", false, {kGrandchild});
  setStep(kParent, "sail", true, {});
  CHECK(standing() == (std::set<TreeId>{kParent, kChild}));
  CHECK(trees.loadAccess(kChild)->stands);
  CHECK_FALSE(trees.loadAccess(kGrandchild)->stands);
  CHECK(trees.absentStepsUnder(kParent) == (std::set<OwningStep>{OwningStep{kChild, nid("rig")}}));

  setStep(kChild, "rig", true, {});
  CHECK(standing() == (std::set<TreeId>{kParent, kChild, kGrandchild}));
  CHECK(trees.placeOf(kGrandchild).has_value());
  CHECK(trees.absentStepsUnder(kParent).empty());
  trees.softDelete(kChild);
  CHECK(trees.loadAccess(kChild).has_value());
}

// "Every owning step on the path is present" is one walk up a subtree's parents: at depth 8 it reads the 9 rows of trees
// on the way through trees_pkey, the root's last, and the 8 owning steps through tree_nodes_pkey, and nothing else.
TEST(pg_the_branch_condition_walks_a_depth_eight_path_by_primary_keys_alone) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  Forest forest;
  forest.plant(kParent, kAda, {{"down", nullptr}});
  TreeId above = kParent;
  for (int depth = 1; depth <= kMaxTreeDepth; ++depth) {
    const TreeId below{"t_5ab00000000000d" + std::to_string(depth)};
    REQUIRE(std::holds_alternative<SubtreeCreation>(forest.create(above, "down", below)));
    if (depth < kMaxTreeDepth) forest.edit(below, kAda, {{"down", nullptr}});
    above = below;
  }
  PgLease conn{*pgTestPool()};
  pqxx::work txn{*conn};
  txn.exec("SET LOCAL enable_seqscan = off");
  const pqxx::result explained = txn.exec_params(
      "EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) SELECT t.id FROM trees t WHERE t.id = $1 AND t.deleted_at IS NULL AND " +
          branchStandsCondition("t"),
      above.str());
  std::map<std::string, double> probes;  // index name → how many times it was probed, over every loop
  std::set<std::string> read;             // every table the plan reads
  bool sequential = false;
  std::vector<Json::Value> nodes{parse(explained[0][0].as<std::string>())[0]["Plan"]};
  while (!nodes.empty()) {
    const Json::Value node = nodes.back();
    nodes.pop_back();
    for (const Json::Value& child : node["Plans"]) nodes.push_back(child);
    if (node["Actual Loops"].asDouble() == 0) continue;  // a plan's alternative it never ran
    // A lookup by key reads as an Index Scan, or as a Bitmap Heap Scan over a Bitmap Index Scan, whichever is priced
    // lower; the index and its probes are the same.
    if (node.isMember("Index Name")) probes[node["Index Name"].asString()] += node["Actual Loops"].asDouble();
    if (node.isMember("Relation Name")) read.insert(node["Relation Name"].asString());
    sequential = sequential || node["Node Type"].asString() == "Seq Scan";
  }
  CHECK_FALSE(sequential);
  CHECK(read == (std::set<std::string>{"trees", "tree_nodes"}));
  CHECK_EQ(probes.size(), 2u);
  CHECK_EQ(probes["trees_pkey"], 1.0 + kMaxTreeDepth + 1);  // the tree, then its 8 parents and the root's no-parent
  CHECK_EQ(probes["tree_nodes_pkey"], static_cast<double>(kMaxTreeDepth));
  CHECK_EQ(parse(explained[0][0].as<std::string>())[0]["Plan"]["Actual Rows"].asInt(), 1);
}

// A fork's copies land in one transaction: a copy whose id is taken stores none of them.
TEST(pg_a_fork_stores_every_copy_of_a_branch_or_none) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  Forest forest;
  forest.plant(kOther, kAda, {{"taken", nullptr}});
  LooseGraph steps;
  steps.createNode(nid("sail"), "Sail", "icon", NodeColor::sky, Hlc{5, 0, "srv"});
  const auto copy = [&](const char* id, std::optional<OwningStep> parent) {
    return TreeCopy{TreeId{std::string(id)}, kParent, std::move(parent), steps.exportState(), LegendState{},
                    Lww<std::string>{"Copy", Hlc{5, 0, "srv"}}, Lww<std::string>{"", Hlc{5, 0, "srv"}}, false};
  };
  const TreeId root{"t_5ab00000000000f0"};
  bool refused = false;
  try {
    forest.trees.fork({copy("t_5ab00000000000f0", std::nullopt), copy("t_5ab0000000000002", OwningStep{root, nid("sail")})},
                      kBea);
  } catch (const DuplicateTree&) {
    refused = true;
  }
  CHECK(refused);
  CHECK_EQ(placeOf(root), std::string(""));

  forest.trees.fork({copy("t_5ab00000000000f0", std::nullopt), copy("t_5ab00000000000f1", OwningStep{root, nid("sail")})},
                    kBea);
  CHECK_EQ(placeOf(TreeId{"t_5ab00000000000f1"}),
           root.str() + " sail " + root.str() + " 1 " + kBea.str() + " private [Copy] 0");
  CHECK(forest.trees.loadAccess(TreeId{"t_5ab00000000000f1"})->stands);
}

// A tree's place is both its parent and its step, or neither: the store refuses a subtree that names no step, and a step
// that names no parent, whatever inserts it, so no row can stand under a tree without the step that owns it.
TEST(pg_the_store_refuses_a_subtree_with_no_step_and_a_step_with_no_parent) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  Forest forest;
  forest.plant(kParent, kAda, {{"sail", nullptr}});
  const auto refused = [](const std::string& insert) {
    try {
      runSql(insert);
    } catch (const pqxx::sql_error& error) {
      return std::string(error.sqlstate());
    }
    return std::string("stored");
  };
  CHECK_EQ(refused("INSERT INTO trees (id, parent_tree) VALUES ('" + kChild.str() + "', '" + kParent.str() + "')"),
           std::string("23502"));
  CHECK_EQ(refused("INSERT INTO trees (id, parent_step, owner_id) VALUES ('" + kChild.str() + "', 'sail', '" +
                   kAda.str() + "'::uuid)"),
           std::string("23502"));
  CHECK_EQ(placeOf(kChild), std::string(""));
  PgTreeRepository trees{pgTestPool()};
  CHECK(trees.absentStepsUnder(kParent).empty());
  CHECK(trees.load(kParent).has_value());
}

// A tree's access is one statement however deep it sits: at depth 8 it walks the 9 rows of trees above it and the tree's
// own by trees_pkey and the 8 owning steps by tree_nodes_pkey, and nothing else, so a closed subtree's access costs one
// round trip, as an absent id's does.
TEST(pg_a_subtrees_access_is_one_statement_of_primary_key_probes) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  resetSubtrees();
  Forest forest;
  forest.plant(kParent, kAda, {{"down", nullptr}});
  TreeId above = kParent;
  std::vector<OwningStep> path;
  for (int depth = 1; depth <= kMaxTreeDepth; ++depth) {
    const TreeId below{"t_5ab00000000000d" + std::to_string(depth)};
    REQUIRE(std::holds_alternative<SubtreeCreation>(forest.create(above, "down", below)));
    if (depth < kMaxTreeDepth) forest.edit(below, kAda, {{"down", nullptr}});
    path.push_back(OwningStep{above, nid("down")});
    above = below;
  }
  PgTreeRepository trees{pgTestPool()};
  CHECK(trees.loadAccess(above) == (std::optional<StoredAccess>(StoredAccess{
                                       TreeAccess{kAda, Visibility::private_, kParent, path}, true})));
  CHECK(trees.loadAccess(kParent) ==
        (std::optional<StoredAccess>(StoredAccess{TreeAccess{kAda, Visibility::private_, kParent, {}}, true})));
  CHECK_FALSE(trees.loadAccess(TreeId{"t_5ab00000000000ff"}).has_value());

  PgLease conn{*pgTestPool()};
  pqxx::work txn{*conn};
  txn.exec("SET LOCAL enable_seqscan = off");
  const pqxx::result explained = txn.exec_params(
      std::string("EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) ") + PgTreeRepository::accessStatement(), above.str());
  std::map<std::string, double> probes;
  bool sequential = false;
  std::vector<Json::Value> nodes{parse(explained[0][0].as<std::string>())[0]["Plan"]};
  while (!nodes.empty()) {
    const Json::Value node = nodes.back();
    nodes.pop_back();
    for (const Json::Value& child : node["Plans"]) nodes.push_back(child);
    if (node["Actual Loops"].asDouble() == 0) continue;  // a plan's alternative it never ran
    if (node.isMember("Index Name")) probes[node["Index Name"].asString()] += node["Actual Loops"].asDouble();
    sequential = sequential || node["Node Type"].asString() == "Seq Scan";
  }
  CHECK_FALSE(sequential);
  CHECK_EQ(probes.size(), 2u);
  CHECK_EQ(probes["trees_pkey"], 1.0 + kMaxTreeDepth + 1);  // the tree, then its 8 parents and the root's no-parent
  CHECK_EQ(probes["tree_nodes_pkey"], static_cast<double>(kMaxTreeDepth));
  CHECK_EQ(parse(explained[0][0].as<std::string>())[0]["Plan"]["Actual Rows"].asInt(), kMaxTreeDepth + 1);
}

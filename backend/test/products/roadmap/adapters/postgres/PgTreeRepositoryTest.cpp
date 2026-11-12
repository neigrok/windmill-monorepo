#include "products/roadmap/adapters/postgres/PgTreeRepository.h"

#include "platform/adapters/postgres/PgAuthRepository.h"
#include "products/roadmap/adapters/postgres/PgOpLog.h"
#include "products/roadmap/adapters/postgres/PgProgressRepository.h"
#include "products/roadmap/application/ForkService.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/domain/Command.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "test/PgTestPool.h"
#include "test/platform/Fakes.h"
#include "test/products/roadmap/Fakes.h"
#include "test/products/roadmap/adapters/mcp/ToolsHarness.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <chrono>
#include <cstdlib>
#include <map>
#include <set>
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
    REQUIRE(registry.persist(kTree));
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
  REQUIRE(registry.persist(kTree));
  CHECK(restarted.load(kTree)->state == (GraphState{{door}, {}}));

  Subgraph retargeted;
  retargeted.frameId = "f-retarget";
  retargeted.graph.nodes.emplace_back();
  retargeted.graph.nodes[0].id = NodeId{"door"};
  retargeted.graph.nodes[0].opens = door.opens = kTree;
  retargeted.graph.nodes[0].opensAt = door.opensAt = Hlc{1'700'000'000'000, 3, "r_b"};
  registry.open(kTree)->joinSubgraph(retargeted, kSam);
  REQUIRE(registry.persist(kTree));
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
    REQUIRE(registry.persist(kTree));
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
    REQUIRE(registry.persist(kFork));
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

// What a node may open and what a read may name: only the owner's trees that stand, whatever the ids
// asked after, in one read.
TEST(pg_titles_owned_by_answers_the_owners_standing_trees_alone_for_every_id_asked_in_one_call) {
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

  CHECK_EQ(trees.titlesOwnedBy(kSam, asked),
           (std::map<TreeId, std::string>{{kTree, "Sam's first"}, {oddlyNamed, "Sam's \"second\", with commas"}}));
  CHECK_EQ(trees.titlesOwnedBy(kEve, asked), (std::map<TreeId, std::string>{{theirs, "Eve's"}}));
  CHECK_EQ(trees.titlesOwnedBy(kSam, {theirs, nobodys, retired, absent}), (std::map<TreeId, std::string>{}));
  CHECK_EQ(trees.titlesOwnedBy(kSam, {}), (std::map<TreeId, std::string>{}));
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
    TreeRegistry treeRegistry{trees, progressRepo, tokens, Hlc{1, 0, "genesis"}, registry, clock};
    RoadmapTools tools{registry, progress, clock, treeRegistry, bus, "https://app.example"};
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
  TreeRegistry treeRegistry{trees, progressRepo, tokens, Hlc{1, 0, "genesis"}, restarted, clock};
  RoadmapTools tools{restarted, progress, clock, treeRegistry, bus, "https://app.example"};
  CHECK_FALSE(tools.callTool("create_node", created, sam).isError);
  Json::Value read = parse(R"({"fields":["id","opens"]})");
  read["treeId"] = kTree.str();
  CHECK_EQ(test::body(tools.callTool("get_tree", read, sam))["tree"]["nodes"], parse(R"([{"id":"sail-trim"}])"));
  CHECK_EQ(storedPointer(), std::vector<std::string>{"sail-trim::true"});
  restarted.stop();
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
    progress.setStatus(id(tree), user, NodeId{node}, ProgressStatus::complete, false, Hlc{1'700'000'000'002, 0, "r_a"},
                       1'700'000'000'002);
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

  OpenedTree a;
  a.title = "Tree a";
  a.total = 9;
  a.marked = 1;
  a.pointers = {{id("absent"), {1, 1}}, {id("b"), {3, 1}}, {id("retired"), {1, 0}}, {id("theirs"), {1, 0}}};
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
  RoomRegistry registry(trees, log, bus);
  TreeRegistry treeRegistry{trees, progressRepo, tokens, Hlc{1, 0, "genesis"}, registry, clock};
  RoadmapTools tools{registry, progress, clock, treeRegistry, bus, "https://app.example"};
  trees.create(kTree, LooseGraph().exportState(), LegendState{}, "Main", kSam);
  trees.create(kFork, LooseGraph().exportState(), LegendState{}, "Deep dive", kSam);
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
  CHECK_FALSE(call(kTree, kSam, "set_progress", R"({"nodeId":"idea","status":"complete"})").isError);
  CHECK_FALSE(call(kTree, kSam, "annotate_node", R"({"nodeId":"idea","opens":")" + kFork.str() + R"("})").isError);
  registry.setVisibility(kTree, Visibility::public_);
  registry.setVisibility(kFork, Visibility::public_);
  CHECK_FALSE(call(kFork, kEve, "set_progress", R"({"nodeId":"s","status":"complete"})").isError);

  Json::Value open = parse(R"([{"id":"idea","status":"complete","state":"available","opens":{"title":"Deep dive","state":"open"}},
                               {"id":"next","status":"none","state":"locked"}])");
  open[0]["opens"]["treeId"] = kFork.str();
  CHECK_EQ(test::body(call(kTree, kSam, "get_tree", R"({"fields":["id","status","state","opens"]})"))["tree"]["nodes"], open);
  CHECK(counts() == (std::map<std::string, std::string>{{kTree.str(), "0/2"}, {kFork.str(), "0/1"}}));
  const ToolResult refused = call(kTree, kSam, "set_progress", R"({"nodeId":"idea","status":"none"})");
  CHECK(refused.isError);
  CHECK_EQ(test::message(refused), std::string("set_progress: \"idea\" opens a tree: it is complete when that tree is and takes "
                                                "no mark of its own — mark the steps of the tree it opens"));
  CHECK_EQ(test::body(call(kTree, kSam, "set_progress", R"({"nodeId":"next","status":"complete"})")),
           parse(R"({"nodeId":"next","status":"complete","prerequisitesMet":false})"));
  CHECK_EQ(test::body(call(kTree, kSam, "get_tree", R"({"fields":["id","status","state","opens"]})"))["tree"]["nodes"][0], open[0]);
  const std::map<UserId, std::map<TreeId, std::map<NodeId, TreeId>>> shared{{kSam, {{kTree, registry.open(kTree)->pointers()}}}};
  CHECK(progress.shownToReaders(shared, "rest").at(kTree).completed == std::set<NodeId>{NodeId{"next"}});

  CHECK_FALSE(call(kFork, kSam, "set_progress", R"({"nodeId":"s","status":"complete"})").isError);

  Json::Value complete = parse(R"([{"id":"idea","status":"complete","state":"complete","opens":{"title":"Deep dive","state":"complete"}},
                                   {"id":"next","status":"complete","state":"complete"}])");
  complete[0]["opens"]["treeId"] = kFork.str();
  CHECK_EQ(test::body(call(kTree, kSam, "set_progress", R"({"nodeId":"next","status":"complete"})")),
           parse(R"({"nodeId":"next","status":"complete","prerequisitesMet":true})"));
  CHECK_EQ(test::body(call(kTree, kSam, "get_tree", R"({"fields":["id","status","state","opens"]})"))["tree"]["nodes"], complete);
  CHECK_EQ(test::body(call(kTree, kEve, "get_tree", R"({"fields":["id","status","state","opens"]})"))["tree"]["nodes"],
           parse(R"([{"id":"idea","status":"none","state":"available"},{"id":"next","status":"none","state":"locked"}])"));
  CHECK(counts() == (std::map<std::string, std::string>{{kTree.str(), "2/2"}, {kFork.str(), "1/1"}}));
  CHECK(progress.shownToReaders(shared, "rest").at(kTree).completed == (std::set<NodeId>{NodeId{"idea"}, NodeId{"next"}}));
  CHECK_EQ(test::body(call(kTree, kEve, "set_progress", R"({"nodeId":"idea","status":"complete"})")),
           parse(R"({"nodeId":"idea","status":"complete","prerequisitesMet":true})"));
  CHECK_EQ(test::body(call(kTree, kEve, "get_tree", R"({"fields":["id","status","state","opens"]})"))["tree"]["nodes"],
           parse(R"([{"id":"idea","status":"complete","state":"complete"},{"id":"next","status":"none","state":"available"}])"));
  registry.stop();
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
// told its own way back, a pointer no tree answers dangles, a removed tree turns the loop into a dangling pointer,
// and a reader of the public tree is answered the graph alone.
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
  TreeRegistry treeRegistry{trees, progressRepo, tokens, Hlc{1, 0, "genesis"}, registry, clock};
  RoadmapTools tools{registry, progress, clock, treeRegistry, bus, "https://app.example"};
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
  CHECK(registry.persist(kTree));

  Json::Value main = parse(R"({"cycles":[],"dangling":[],"selfEdges":[],"smells":[],"maskedWork":[],
      "treeLoops":[{"node":"down","path":[]}],"danglingPointers":[{"node":"gone","treeId":"t_pgtest_never_planted"}]})");
  main["treeLoops"][0]["path"].append(onTheWay(kFork, "Deep dive"));
  main["treeLoops"][0]["path"].append(onTheWay(kTree, "Main"));
  CHECK_EQ(test::body(call(kTree, kSam, "get_diagnostics", "{}")), main);
  Json::Value sub = parse(R"({"cycles":[],"dangling":[],"selfEdges":[],"smells":[],"maskedWork":[],
      "treeLoops":[{"node":"back","path":[]}],"danglingPointers":[]})");
  sub["treeLoops"][0]["path"].append(onTheWay(kTree, "Main"));
  sub["treeLoops"][0]["path"].append(onTheWay(kFork, "Deep dive"));
  CHECK_EQ(test::body(call(kFork, kSam, "get_diagnostics", "{}")), sub);

  registry.setVisibility(kTree, Visibility::public_);
  CHECK_EQ(test::message(call(kTree, kEve, "get_diagnostics", "{}")),
           std::string(R"({"cycles":[],"dangling":[],"maskedWork":[],"selfEdges":[],"smells":[]})"));

  CHECK(treeRegistry.remove(kFork, kSam) == TreeRegistry::Removal::deleted);
  Json::Value orphaned = parse(R"({"cycles":[],"dangling":[],"selfEdges":[],"smells":[],"maskedWork":[],"treeLoops":[],
      "danglingPointers":[{"node":"down"},{"node":"gone","treeId":"t_pgtest_never_planted"}]})");
  orphaned["danglingPointers"][0]["treeId"] = kFork.str();
  CHECK_EQ(test::body(call(kTree, kSam, "get_diagnostics", "{}")), orphaned);
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

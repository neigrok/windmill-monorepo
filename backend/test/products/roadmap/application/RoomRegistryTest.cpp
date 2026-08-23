#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

#include <chrono>
#include <optional>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::fake;

namespace {

StoredTree oneNodeTree() {
  LooseGraph graph;
  graph.createNode(nid("seed"), "Seed", "icon", NodeColor::sky, std::nullopt, at(1));
  return StoredTree{graph.exportState(), LegendState{}, {"Seeded", {}}, 7};
}

std::size_t nodeCount(const GraphState& state) {
  return LooseGraph(state).presentNodeIds().size();
}

// A repository that fails the way a real one does under an outage, not by returning "no such tree".
struct FailingTreeRepository : FakeTreeRepository {
  std::optional<StoredTree> load(const TreeId&) override {
    throw std::runtime_error("connect host=db.internal: FATAL");
  }
};

}

TEST(registry_opens_room_from_repository) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus);

  TreeRoom& room = *registry.open(tid());
  CHECK(registry.isOpen(tid()));
  CHECK_EQ(room.head(), static_cast<Seq>(7));
  CHECK_EQ(room.snapshot().nodes.size(), 1u);
  CHECK_EQ(registry.open(tid()), &room);  // second open reuses the same room
}

TEST(registry_open_unknown_tree_returns_null) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  RoomRegistry registry(repo, log, bus);

  // Absence is a nullptr the caller answers, not a throw; open() throws only on a genuine repository failure.
  CHECK_EQ(registry.open(tid("ghost")), static_cast<TreeRoom*>(nullptr));
  CHECK_FALSE(registry.isOpen(tid("ghost")));  // a missed open materializes no room
}

TEST(registry_open_propagates_a_repository_failure_rather_than_nulling_it) {
  FailingTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  RoomRegistry registry(repo, log, bus);

  // A repository outage must throw rather than be flattened into the nullptr that means "no such tree".
  bool threw = false;
  try {
    registry.open(tid("t"));
  } catch (const std::exception&) {
    threw = true;
  }
  CHECK(threw);
}

TEST(registry_replays_op_log_tail_on_open) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = StoredTree{GraphState{}, LegendState{}, {"Empty", {}}, 0};  // snapshot is empty at head 0
  log.byTree["t"] = {
    AppliedOp{1, "o1", createNode("a"), at(1), uid()},
    AppliedOp{2, "o2", createNode("b"), at(2), uid()},
    AppliedOp{3, "o3", AddEdge{nid("a"), nid("b")}, at(3), uid()},
  };
  RoomRegistry registry(repo, log, bus);

  TreeRoom& room = *registry.open(tid());
  CHECK_EQ(room.head(), static_cast<Seq>(3));      // head advanced to the log tail
  CHECK_EQ(room.snapshot().nodes.size(), 2u);      // state rebuilt from replay
}

TEST(registry_persist_snapshots_full_state_without_evicting) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus);

  TreeRoom& room = *registry.open(tid());
  room.applyCommand(createNode("added"), 10, uid());
  registry.persist(tid());

  CHECK(registry.isOpen(tid()));                       // still live
  CHECK_EQ(repo.byId["t"].head, static_cast<Seq>(8));  // snapshot advanced
  CHECK_EQ(nodeCount(repo.byId["t"].state), 2u);
}

TEST(registry_persist_saves_only_the_dirty_slice_and_never_clobbers_the_rest) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();  // "seed" already stored
  RoomRegistry registry(repo, log, bus);

  TreeRoom& room = *registry.open(tid());
  room.applyCommand(createNode("added"), 10, uid());
  registry.persist(tid());
  CHECK_EQ(repo.savedNodeCounts.back(), 1u);       // the slice carried only "added"
  CHECK_EQ(nodeCount(repo.byId["t"].state), 2u);   // upsert kept "seed" alongside it

  registry.persist(tid());                         // nothing dirtied since
  CHECK_EQ(repo.savedNodeCounts.back(), 0u);       // an empty slice — just title/head
  CHECK_EQ(nodeCount(repo.byId["t"].state), 2u);

  room.applyCommand(RenameNode{nid("added"), "Renamed"}, 11, uid());
  registry.persist(tid());
  CHECK_EQ(repo.savedNodeCounts.back(), 1u);       // only the renamed node again
}

TEST(registry_never_gives_an_unowned_tree_an_owner) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();  // unowned
  RoomRegistry registry(repo, log, bus);

  TreeRoom& room = *registry.open(tid());
  CHECK_FALSE(room.owner().has_value());

  room.applyCommand(createNode("added"), 10, UserId{"alice"});
  registry.persist(tid());

  CHECK_FALSE(room.owner().has_value());            // the live room's cache is still empty
  CHECK_FALSE(repo.byId["t"].owner.has_value());    // and so is the row
  CHECK_EQ(nodeCount(repo.byId["t"].state), 2u);    // the write itself did land
}

TEST(registry_set_visibility_flips_the_live_room_and_the_row) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  repo.byId["t"].visibility = Visibility::private_;
  RoomRegistry registry(repo, log, bus);

  TreeRoom& room = *registry.open(tid());
  CHECK(room.visibility() == Visibility::private_);

  registry.setVisibility(tid(), Visibility::unlisted);
  CHECK(room.visibility() == Visibility::unlisted);              // the live room reads shared at once
  CHECK(repo.byId["t"].visibility == Visibility::unlisted);      // and it is durable
}

TEST(registry_evict_persists_and_closes) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus);

  TreeRoom& room = *registry.open(tid());
  room.applyCommand(createNode("added"), 10, uid());
  registry.evict(tid());

  CHECK_FALSE(registry.isOpen(tid()));
  CHECK_EQ(repo.byId["t"].head, static_cast<Seq>(8));
  CHECK_EQ(nodeCount(repo.byId["t"].state), 2u);
}

TEST(registry_access_of_answers_without_materializing_a_room) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  repo.byId["t"].owner = UserId{"alice"};
  repo.byId["t"].visibility = Visibility::unlisted;
  RoomRegistry registry(repo, log, bus);

  std::optional<TreeAccess> access = registry.accessOf(tid());
  REQUIRE(access.has_value());
  CHECK(access->owner == std::optional<UserId>(UserId{"alice"}));
  CHECK(access->visibility == Visibility::unlisted);
  CHECK_FALSE(registry.isOpen(tid()));       // the decisive property: nothing was loaded
  CHECK_EQ(registry.openRooms(), std::size_t{0});

  CHECK_FALSE(registry.accessOf(tid("ghost")).has_value());  // absence answers absence
  CHECK_FALSE(registry.isOpen(tid("ghost")));
}

TEST(registry_access_of_reads_the_live_room_before_the_row) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  repo.byId["t"].visibility = Visibility::private_;
  RoomRegistry registry(repo, log, bus);

  registry.open(tid())->setVisibility(Visibility::public_);  // live only; the column still says private
  REQUIRE(registry.accessOf(tid()).has_value());
  CHECK(registry.accessOf(tid())->visibility == Visibility::public_);
}

TEST(registry_sweep_persists_and_closes_an_idle_room) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus);

  registry.open(tid())->applyCommand(createNode("added"), 10, uid());
  registry.sweep(std::chrono::seconds{0});  // everything is idle when nothing may sit at all

  CHECK_FALSE(registry.isOpen(tid()));
  CHECK_EQ(registry.openRooms(), std::size_t{0});
  CHECK_EQ(repo.byId["t"].head, static_cast<Seq>(8));   // the edit was persisted, not dropped
  CHECK_EQ(nodeCount(repo.byId["t"].state), 2u);
}

TEST(registry_sweep_keeps_a_room_that_was_just_touched) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus);

  registry.open(tid());
  registry.sweep(std::chrono::hours{1});
  CHECK(registry.isOpen(tid()));
  CHECK_EQ(registry.openRooms(), std::size_t{1});
}

// Idleness alone is not a bound: the cap is what makes rooms_ finite — least-recently-touched go first.
TEST(registry_sweep_caps_how_many_rooms_stay_open) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  RoomRegistry registry(repo, log, bus);

  for (int i = 0; i < 300; ++i) {
    std::string id = "t" + std::string(3 - std::to_string(i).size(), '0') + std::to_string(i);
    repo.byId[id] = oneNodeTree();
    registry.open(tid(id.c_str()));  // opened in id order, so id order is touch order
  }
  CHECK_EQ(registry.openRooms(), std::size_t{300});

  registry.sweep(std::chrono::hours{1});  // nothing is idle — only the cap can close anything
  CHECK_EQ(registry.openRooms(), std::size_t{256});
  CHECK_FALSE(registry.isOpen(tid("t000")));  // the oldest went
  CHECK(registry.isOpen(tid("t299")));        // the newest stayed
}

TEST(registry_set_visibility_announces_the_change) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus);

  std::vector<std::string> announced;
  registry.whenAccessChanges([&](const TreeId& id) { announced.push_back(id.str()); });
  registry.setVisibility(tid(), Visibility::private_);

  CHECK_EQ(announced.size(), 1u);
  CHECK_EQ(announced.front(), std::string("t"));
}

// A retirement drops the room WITHOUT persisting it, and announces so readers are re-decided.
TEST(registry_retire_drops_the_room_unsaved_and_announces_it) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus);

  std::vector<std::string> announced;
  registry.whenAccessChanges([&](const TreeId& id) { announced.push_back(id.str()); });

  registry.open(tid())->applyCommand(createNode("added"), 10, uid());
  registry.retire(tid());

  CHECK_FALSE(registry.isOpen(tid()));
  CHECK_EQ(registry.openRooms(), std::size_t{0});
  CHECK_EQ(repo.byId["t"].head, static_cast<Seq>(7));  // NOT persisted, unlike evict
  CHECK_EQ(nodeCount(repo.byId["t"].state), 1u);
  CHECK_EQ(announced.size(), 1u);
  CHECK_EQ(announced.front(), std::string("t"));
}

TEST(registry_access_of_stops_speaking_for_a_tree_once_its_room_is_retired) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  repo.byId["t"].visibility = Visibility::public_;
  RoomRegistry registry(repo, log, bus);

  registry.open(tid());
  repo.byId.erase("t");  // the row is gone, exactly as a soft delete makes it to load/loadAccess
  REQUIRE(registry.accessOf(tid()).has_value());  // the resident room still answers for it

  registry.retire(tid());
  CHECK_FALSE(registry.accessOf(tid()).has_value());
  CHECK_EQ(registry.open(tid()), static_cast<TreeRoom*>(nullptr));  // and nothing reloads it
}

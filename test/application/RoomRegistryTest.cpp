#include "application/RoomRegistry.h"
#include "domain/LooseGraph.h"
#include "test/application/Fakes.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::fake;

namespace {

StoredTree oneNodeTree() {
  LooseGraph graph;
  graph.createNode(nid("seed"), "Seed", "icon", NodeColor::sky, std::nullopt, at(1));
  return StoredTree{graph.exportState(), LegendState{}, "Seeded", 7};
}

std::size_t nodeCount(const GraphState& state) {
  return LooseGraph(state).presentNodeIds().size();
}

}

TEST(registry_opens_room_from_repository) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus);

  TreeRoom& room = registry.open(tid());
  CHECK(registry.isOpen(tid()));
  CHECK_EQ(room.head(), static_cast<Seq>(7));
  CHECK_EQ(room.snapshot().nodes.size(), 1u);
  CHECK_EQ(&registry.open(tid()), &room);  // second open reuses the same room
}

TEST(registry_open_unknown_tree_throws) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  RoomRegistry registry(repo, log, bus);

  bool threw = false;
  try {
    registry.open(tid("ghost"));
  } catch (const std::runtime_error&) {
    threw = true;
  }
  CHECK(threw);
}

TEST(registry_replays_op_log_tail_on_open) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = StoredTree{GraphState{}, LegendState{}, "Empty", 0};  // snapshot is empty at head 0
  log.byTree["t"] = {
    AppliedOp{1, "o1", createNode("a"), at(1), uid()},
    AppliedOp{2, "o2", createNode("b"), at(2), uid()},
    AppliedOp{3, "o3", AddEdge{nid("a"), nid("b")}, at(3), uid()},
  };
  RoomRegistry registry(repo, log, bus);

  TreeRoom& room = registry.open(tid());
  CHECK_EQ(room.head(), static_cast<Seq>(3));      // head advanced to the log tail
  CHECK_EQ(room.snapshot().nodes.size(), 2u);      // state rebuilt from replay
}

TEST(registry_persist_snapshots_full_state_without_evicting) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus);

  TreeRoom& room = registry.open(tid());
  room.applyCommand(createNode("added"), 10, uid());
  registry.persist(tid());

  CHECK(registry.isOpen(tid()));                       // still live
  CHECK_EQ(repo.byId["t"].head, static_cast<Seq>(8));  // snapshot advanced
  CHECK_EQ(nodeCount(repo.byId["t"].state), 2u);
}

TEST(registry_claim_sets_owner_once_and_is_durable) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();  // unowned
  RoomRegistry registry(repo, log, bus);

  TreeRoom& room = registry.open(tid());
  CHECK_FALSE(room.owner().has_value());

  registry.claim(tid(), UserId{"alice"});
  CHECK(room.owner().has_value());
  CHECK_EQ(*room.owner(), UserId{"alice"});           // the live room's cache is updated
  CHECK(repo.byId["t"].owner.has_value());
  CHECK_EQ(*repo.byId["t"].owner, UserId{"alice"});   // and it is persisted

  registry.claim(tid(), UserId{"bob"});               // a second claim never overrides an owner
  CHECK_EQ(*room.owner(), UserId{"alice"});
  CHECK_EQ(*repo.byId["t"].owner, UserId{"alice"});
}

TEST(registry_evict_persists_and_closes) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus);

  TreeRoom& room = registry.open(tid());
  room.applyCommand(createNode("added"), 10, uid());
  registry.evict(tid());

  CHECK_FALSE(registry.isOpen(tid()));
  CHECK_EQ(repo.byId["t"].head, static_cast<Seq>(8));
  CHECK_EQ(nodeCount(repo.byId["t"].state), 2u);
}

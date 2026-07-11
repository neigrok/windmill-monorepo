#include "application/RoomRegistry.h"
#include "test/application/Fakes.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::fake;

namespace {

StoredTree oneNodeTree() {
  TreeData data;
  data.id = tid();
  data.title = "Seeded";
  NodeSpec node;
  node.id = nid("seed");
  node.label = "Seed";
  node.icon = "icon";
  node.color = NodeColor::sky;
  data.nodes = {node};
  return StoredTree{data, 7};
}

}

TEST(registry_opens_room_from_repository) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus, at(1));

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
  RoomRegistry registry(repo, log, bus, at(1));

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
  TreeData empty;
  empty.id = tid();
  empty.title = "Empty";
  repo.byId["t"] = StoredTree{empty, 0};  // snapshot is empty at head 0
  log.byTree["t"] = {
    AppliedOp{1, "o1", createNode("a"), at(1), uid()},
    AppliedOp{2, "o2", createNode("b"), at(2), uid()},
    AppliedOp{3, "o3", AddEdge{nid("a"), nid("b")}, at(3), uid()},
  };
  RoomRegistry registry(repo, log, bus, at(0));

  TreeRoom& room = registry.open(tid());
  CHECK_EQ(room.head(), static_cast<Seq>(3));      // head advanced to the log tail
  CHECK_EQ(room.snapshot().nodes.size(), 2u);      // state rebuilt from replay
}

TEST(registry_evict_persists_and_closes) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus, at(1));

  TreeRoom& room = registry.open(tid());
  room.submit(Incoming{"c1", createNode("added"), at(10), uid()});
  registry.evict(tid());

  CHECK_FALSE(registry.isOpen(tid()));
  CHECK_EQ(repo.byId["t"].head, static_cast<Seq>(8));
  CHECK_EQ(repo.byId["t"].data.nodes.size(), 2u);
}

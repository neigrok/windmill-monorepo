#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "test/application/Fakes.h"
#include "test/testing.h"

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

  // Absence is a nullptr the caller answers, not a throw it must catch — so "no such tree" is
  // distinguishable from a genuine repository failure, which is the only thing open() still throws.
  CHECK_EQ(registry.open(tid("ghost")), static_cast<TreeRoom*>(nullptr));
  CHECK_FALSE(registry.isOpen(tid("ghost")));  // a missed open materializes no room
}

TEST(registry_open_propagates_a_repository_failure_rather_than_nulling_it) {
  FailingTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  RoomRegistry registry(repo, log, bus);

  // A repository outage is NOT a benign absence: it must throw (for a handler to log + genericize),
  // never be flattened into the nullptr that means "no such tree" — the two are the whole point.
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

// The registry has no seam that fills in an owner, and writing through a room no longer creates
// one. An unowned tree is nobody's to write, so a row that reaches the registry ownerless — the
// seeded demo, a legacy orphan — leaves it ownerless however much is written through it.
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

// The seam that survived claim's removal, and the reason it exists: a share must reach the LIVE
// room, or the freshly-shared tree keeps 404-ing until it is evicted and reloaded.
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

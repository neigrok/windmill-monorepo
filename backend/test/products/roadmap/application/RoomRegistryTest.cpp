#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/domain/Graft.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

#include <trantor/utils/Logger.h>

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <typeinfo>
#include <vector>

using namespace wm;
using namespace wm::fake;

namespace {

StoredTree oneNodeTree() {
  LooseGraph graph;
  graph.createNode(nid("seed"), "Seed", "icon", NodeColor::sky, at(1));
  return StoredTree{graph.exportState(), LegendState{}, {"Seeded", {}}, 7};
}

std::size_t nodeCount(const GraphState& state) {
  return LooseGraph(state).presentNodeIds().size();
}

// What a registry leaves for an operator: its write lines, its failure reports and its log lines, each as one string.
struct Told : FailureReporter {
  std::vector<std::string> lines;
  std::vector<std::string> reports;
  std::vector<std::string> logged;
  trantor::Logger::LogLevel level = trantor::Logger::logLevel();
  Told() {
    installWriteSink([this](const WriteCompletion& line) {
      lines.push_back(line.operation + " " + line.product + " " + line.door + " " + line.outcome);
    });
    installWriteReporter(std::shared_ptr<FailureReporter>(this, [](FailureReporter*) {}));
    trantor::Logger::setLogLevel(trantor::Logger::kTrace);
    trantor::Logger::setOutputFunction(
        [this](const char* message, std::uint64_t length) { logged.emplace_back(message, length); }, [] {});
  }
  ~Told() override {
    installWriteSink({});
    installWriteReporter(nullptr);
    trantor::Logger::setOutputFunction([](const char* message, std::uint64_t length) { fwrite(message, 1, length, stdout); },
                                       [] { fflush(stdout); });
    trantor::Logger::setLogLevel(level);
  }
  void report(const std::string&, const std::string&, const std::string&) override {}
  void reportWrite(const std::string& operation, const std::string& product, const std::string& door,
                   const std::string& outcome, const std::string&, const std::string& exceptionType) override {
    reports.push_back(operation + " " + product + " " + door + " " + outcome + " " + exceptionType);
  }
};

// A repository that fails the way a real one does under an outage, not by returning "no such tree".
struct FailingTreeRepository : FakeTreeRepository {
  std::optional<StoredTree> load(const TreeId&) override {
    throw std::runtime_error("connect host=db.internal: FATAL");
  }
};

// The two stores share one journal, so a test reads the order the registry called them in.
struct RecordingTreeRepository : FakeTreeRepository {
  std::vector<std::string>& journal;
  explicit RecordingTreeRepository(std::vector<std::string>& j) : journal(j) {}
  bool save(const TreeId& tree, const GraphState& state, const LegendState& legend,
            const Lww<std::string>& title, const Lww<std::string>& guide, Seq head) override {
    journal.push_back("save@" + std::to_string(head));
    return FakeTreeRepository::save(tree, state, legend, title, guide, head);
  }
};

struct RecordingOpLog : FakeOpLog {
  std::vector<std::string>& journal;
  bool failAppend = false;
  explicit RecordingOpLog(std::vector<std::string>& j) : journal(j) {}
  void append(const TreeId& tree, const AppliedOp& op) override {
    journal.push_back("append@" + std::to_string(op.seq));
    if (failAppend) throw std::runtime_error("connection reset before the row landed");
    FakeOpLog::append(tree, op);
  }
};

Graft manyNodeGraft(std::size_t count) {
  Graft graft;
  for (std::size_t i = 0; i < count; ++i) {
    NodeSpec node;
    node.id = NodeId{"n" + std::to_string(i)};
    node.label = "Node " + std::to_string(i);
    graft.document.nodes.push_back(node);
  }
  return graft;
}

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

// A room opens as its stored snapshot and nothing else: the op log is the history the feed reads, never a second
// source of a tree's state. Rows past the snapshot's head change nothing the room holds — here a row that would blank a
// node's fields and one that would move a kind — and the room's head is the later of the snapshot's and the last
// row's, so its next write takes a seq no row holds and lands in the log.
TEST(registry_opens_a_room_as_its_snapshot_and_takes_its_next_seq_after_the_last_op_row) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  LooseGraph graph;
  graph.createNode(nid("a"), "A", "icon", NodeColor::sky, at(1));
  const Legend legend({{KindId{"k"}, NodeColor::sky, "K"}}, at(1));
  repo.byId["t"] = StoredTree{graph.exportState(), legend.exportState(), {"Sail", {}}, 2};
  log.byTree["t"] = {
      AppliedOp{1, "o1", AddKind{KindId{"k"}, NodeColor::sky, "K"}, at(1), uid()},
      AppliedOp{2, "o2", CreateNode{nid("a"), "A", "icon", NodeColor::sky}, at(1), uid()},
      AppliedOp{3, "o3", CreateNode{nid("a"), "", "", NodeColor::terracotta}, at(5), uid()},
      AppliedOp{4, "o4", RecolorKind{KindId{"k"}, NodeColor::plum}, at(6), uid()},
  };
  const StoredTree snapshot = repo.byId["t"];
  RoomRegistry registry(repo, log, bus);

  TreeRoom& room = *registry.open(tid());
  CHECK(room.exportState() == snapshot.state);
  CHECK(room.exportLegend() == snapshot.legend);
  CHECK_EQ(room.head(), static_cast<Seq>(4));

  CHECK_EQ(room.applyCommand(RenameNode{nid("a"), "A2"}, 10, uid()), static_cast<Seq>(5));
  CHECK(registry.persist(tid()));
  CHECK_EQ(repo.byId["t"].head, static_cast<Seq>(5));
  REQUIRE_EQ(log.byTree["t"].size(), 5u);
  CHECK_EQ(log.byTree["t"].back().seq, static_cast<Seq>(5));
  CHECK(std::holds_alternative<RenameNode>(log.byTree["t"].back().command));

  repo.byId["empty"] = StoredTree{GraphState{}, LegendState{}, {"Empty", {}}, 0};
  CHECK_EQ(registry.open(tid("empty"))->head(), static_cast<Seq>(0));
}

// A room that opens behind its log — the last op row's seq past the snapshot's head — is an unexpected state, and its
// first save erases the evidence, so the open tells it: one failed line and one report under a static name, and one
// line that counts the rows past the snapshot and names no tree. The room's clock takes the last row's stamp, so the
// server's next write is stamped past every deed the log holds, whatever the wall clock reads. A room that opens level
// with its log tells nothing.
TEST(registry_a_room_that_opens_behind_its_log_is_reported_with_its_row_count_and_mints_past_the_last_rows_stamp) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  LooseGraph graph;
  graph.createNode(nid("a"), "A", "icon", NodeColor::sky, at(1));
  repo.byId["t"] = StoredTree{graph.exportState(), LegendState{}, {"Sail", {}}, 2};
  repo.byId["level"] = StoredTree{graph.exportState(), LegendState{}, {"Level", {}}, 1};
  const Hlc lastIssued{5'000, 3, "srv"};
  log.byTree["t"] = {
      AppliedOp{2, "o2", CreateNode{nid("a"), "A", "icon", NodeColor::sky}, at(1), uid()},
      AppliedOp{3, "o3", RenameNode{nid("a"), "A2"}, Hlc{4'000, 0, "srv"}, uid()},
      AppliedOp{4, "o4", RenameNode{nid("a"), "A3"}, lastIssued, uid()},
  };
  log.byTree["level"] = {AppliedOp{1, "o1", CreateNode{nid("a"), "A", "icon", NodeColor::sky}, at(1), uid()}};
  RoomRegistry registry(repo, log, bus);
  Told told;

  registry.open(tid("level"));
  CHECK(told.lines.empty());
  CHECK(told.reports.empty());

  TreeRoom& room = *registry.open(tid());
  CHECK_EQ(told.lines, (std::vector<std::string>{"roadmap.room.open_behind_log roadmap background snapshot-behind-log"}));
  REQUIRE_EQ(told.reports.size(), 1u);
  CHECK_EQ(told.reports[0].rfind("roadmap.room.open_behind_log roadmap background snapshot-behind-log ", 0), std::size_t{0});
  std::vector<std::string> counted;
  for (const std::string& line : told.logged)
    if (line.find("roadmap_room_opened_behind_log") != std::string::npos)
      counted.push_back(line.substr(line.find("roadmap_room_opened_behind_log"), line.find(" request_id=") - line.find("roadmap_room_opened_behind_log")));
  CHECK_EQ(counted, (std::vector<std::string>{"roadmap_room_opened_behind_log rows=2"}));

  room.applyCommand(RenameNode{nid("a"), "A4"}, 10, uid());
  CHECK(lastIssued < room.pendingOps().back().hlc);
  registry.open(tid());
  CHECK_EQ(told.reports.size(), 1u);
}

// The clock takes the greatest stamp among the rows past the snapshot, not the last row's. A phone whose clock ran
// ahead, the server's own rename after it, then a tablet with an honest clock leave the last row the lowest of the
// three, and the server's next write is still stamped past them all. The open's report is its own, too: a request that
// opens such a room and then fails files its own failure beside it.
TEST(registry_a_room_behind_its_log_mints_past_the_greatest_stamp_of_those_rows_and_leaves_its_opener_its_own_report) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  LooseGraph graph;
  graph.createNode(nid("a"), "A", "icon", NodeColor::sky, at(1));
  repo.byId["t"] = StoredTree{graph.exportState(), LegendState{}, {"Sail", {}}, 1};
  log.byTree["t"] = {
      AppliedOp{1, "o1", CreateNode{nid("a"), "A", "icon", NodeColor::sky}, at(1), uid()},
      AppliedOp{2, "o2", RenameNode{nid("a"), "By phone"}, Hlc{9'000, 0, "r_phone"}, uid()},
      AppliedOp{3, "o3", RenameNode{nid("a"), "By the server"}, Hlc{9'000, 1, "srv"}, uid()},
      AppliedOp{4, "o4", RenameNode{nid("a"), "By tablet"}, Hlc{2'000, 0, "r_tablet"}, uid()},
  };
  RoomRegistry registry(repo, log, bus);
  Told told;

  {
    WriteObservation door{"mcp.roadmap_update_nodes", "roadmap", "mcp"};
    WriteContext context{door};
    TreeRoom& room = *registry.open(tid());
    room.applyCommand(RenameNode{nid("a"), "After the reopen"}, 3'000, uid());
    CHECK((Hlc{9'000, 1, "srv"} < room.pendingOps().back().hlc));
    door.fail(std::runtime_error("the call failed after the open"));
  }

  CHECK_EQ(told.lines, (std::vector<std::string>{"roadmap.room.open_behind_log roadmap mcp snapshot-behind-log",
                                                 "mcp.roadmap_update_nodes roadmap mcp failed"}));
  REQUIRE_EQ(told.reports.size(), 2u);
  CHECK_EQ(told.reports[0].rfind("roadmap.room.open_behind_log roadmap mcp snapshot-behind-log ", 0), std::size_t{0});
  CHECK_EQ(told.reports[1], std::string("mcp.roadmap_update_nodes roadmap mcp failed ") + typeid(std::runtime_error).name());
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

  registry.open(tid())->rootAccess()->setVisibility(Visibility::public_);  // live only; the column still says private
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

// A subtree has no access of its own: open or closed it is read by its root's, a change of the root's visibility reaches
// its open room at once, narrower before the row and wider after it, and the root's removal takes it out of reach.
TEST(registry_a_subtree_is_read_by_its_roots_access_which_a_change_to_the_root_reaches_at_once) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  repo.byId["t"].owner = uid("owner");
  repo.byId["c"] = oneNodeTree();
  repo.byId["g"] = oneNodeTree();
  repo.subtrees["c"] = Subtree{tid("c"), tid("t"), OwningStep{tid("t"), nid("seed")}, 1, 0};
  repo.subtrees["g"] = Subtree{tid("g"), tid("t"), OwningStep{tid("c"), nid("seed")}, 2, 0};
  RoomRegistry registry(repo, log, bus);
  std::vector<std::string> announced;
  registry.whenAccessChanges([&](const TreeId& id) { announced.push_back(id.str()); });
  const TreeRoom& open = *registry.open(tid("c"));
  const auto visibilityOf = [&registry](const char* tree) { return registry.accessOf(tid(tree))->visibility; };
  CHECK(registry.accessOf(tid("g")) ==
        std::optional<TreeAccess>(TreeAccess{uid("owner"), Visibility::private_, tid("t")}));

  std::vector<Visibility> duringTheWrite;
  repo.duringVisibilitySet = [&] { duringTheWrite.push_back(visibilityOf("c")); };
  registry.setVisibility(tid("t"), Visibility::unlisted);
  registry.setVisibility(tid("t"), Visibility::private_);
  CHECK(duringTheWrite == (std::vector<Visibility>{Visibility::private_, Visibility::private_}));
  registry.setVisibility(tid("t"), Visibility::public_);
  CHECK(open.visibility() == Visibility::public_);
  CHECK(visibilityOf("g") == Visibility::public_);
  CHECK(announced == (std::vector<std::string>{"t", "c", "t", "c", "t", "c"}));

  repo.duringVisibilitySet = [] { throw std::runtime_error("the write was refused"); };
  bool refused = false;
  try {
    registry.setVisibility(tid("t"), Visibility::private_);
  } catch (const std::runtime_error&) {
    refused = true;
  }
  CHECK(refused);
  CHECK(open.visibility() == Visibility::public_);  // narrowed for the write, and back once it failed

  announced.clear();
  {
    std::lock_guard<std::mutex> strand(registry.strandFor(tid("t")));
    registry.remove(tid("t"));
  }
  CHECK_FALSE(registry.accessOf(tid("c")).has_value());
  CHECK_FALSE(registry.accessOf(tid("g")).has_value());
  CHECK_FALSE(open.readableBy(uid("owner")));
  CHECK(announced == (std::vector<std::string>{"t", "c"}));
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

TEST(registry_persist_and_a_live_rename_answer_false_once_the_row_went_away_and_the_rename_retires_the_room) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus);
  std::vector<std::string> announced;
  registry.whenAccessChanges([&](const TreeId& id) { announced.push_back(id.str()); });

  registry.open(tid())->applyCommand(createNode("added"), 10, uid());
  CHECK(registry.persist(tid()));
  repo.deletedIds.insert("t");  // soft-deleted outside this registry, its row kept
  registry.open(tid())->applyCommand(createNode("ghost"), 11, uid());

  CHECK_FALSE(registry.persist(tid()));
  CHECK(registry.isOpen(tid()));
  CHECK_FALSE(registry.rename(tid(), "Ghost title", 12, Hlc{}));
  CHECK_FALSE(registry.isOpen(tid()));
  CHECK_EQ(announced, std::vector<std::string>{"t"});
  CHECK_EQ(nodeCount(repo.byId["t"].state), 2u);
  CHECK(repo.byId["t"].title == (Lww<std::string>{"Seeded", {}}));
  CHECK_EQ(registry.open(tid()), static_cast<TreeRoom*>(nullptr));
}

// The ordering the op log's honesty rests on: a row at seq N exists only once the lattice is
// durable at N. persist() saves first and lands the queued rows after, and so does evict().
TEST(registry_persist_saves_the_lattice_before_it_lands_the_op_rows) {
  std::vector<std::string> journal;
  RecordingTreeRepository repo(journal);
  RecordingOpLog log(journal);
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus);

  TreeRoom& room = *registry.open(tid());
  room.applyCommand(createNode("added"), 10, uid());
  room.applyCommand(createNode("also"), 11, uid());
  CHECK(journal.empty());                        // a write alone touches neither store
  CHECK(log.byTree["t"].empty());
  CHECK_EQ(room.pendingOps().size(), 2u);

  registry.persist(tid());
  CHECK_EQ(journal, (std::vector<std::string>{"save@9", "append@8", "append@9"}));
  CHECK(room.pendingOps().empty());
  CHECK_EQ(repo.byId["t"].head, static_cast<Seq>(9));
  REQUIRE_EQ(log.byTree["t"].size(), 2u);
  CHECK_EQ(log.byTree["t"][0].seq, static_cast<Seq>(8));
  CHECK_EQ(log.byTree["t"][1].seq, static_cast<Seq>(9));

  journal.clear();
  registry.persist(tid());                       // nothing queued: the save alone
  CHECK_EQ(journal, (std::vector<std::string>{"save@9"}));
}

TEST(registry_evict_saves_the_lattice_before_it_lands_the_op_rows) {
  std::vector<std::string> journal;
  RecordingTreeRepository repo(journal);
  RecordingOpLog log(journal);
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus);

  registry.open(tid())->applyCommand(createNode("added"), 10, uid());
  registry.evict(tid());
  CHECK_EQ(journal, (std::vector<std::string>{"save@8", "append@8"}));
  CHECK_FALSE(registry.isOpen(tid()));
  CHECK_EQ(repo.byId["t"].head, static_cast<Seq>(8));
  REQUIRE_EQ(log.byTree["t"].size(), 1u);
  CHECK_EQ(log.byTree["t"][0].seq, static_cast<Seq>(8));
}

// The crash between the two stores, on the lossy side: the lattice landed, the row did not. A
// process that reopens the tree finds the whole 200-node import in the lattice, the head it was
// saved at, and no row past it — the feed misses one deed, and the tree misses nothing.
TEST(registry_a_crash_after_the_save_and_before_the_row_reopens_the_whole_import) {
  std::vector<std::string> journal;
  RecordingTreeRepository repo(journal);
  RecordingOpLog log(journal);
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  {
    RoomRegistry registry(repo, log, bus);
    TreeRoom& room = *registry.open(tid());
    const Seq seq = room.importTree(manyNodeGraft(200), 10, uid()).value();
    CHECK_EQ(seq, static_cast<Seq>(8));
    log.failAppend = true;
    registry.persist(tid());  // the row's failure is logged, never thrown: the lattice is durable
    CHECK_EQ(journal, (std::vector<std::string>{"save@8", "append@8"}));
    CHECK_EQ(room.pendingOps().size(), 1u);  // still queued for the next save, had the process lived
  }
  CHECK(log.byTree["t"].empty());
  CHECK_EQ(repo.byId["t"].head, static_cast<Seq>(8));
  CHECK_EQ(nodeCount(repo.byId["t"].state), 201u);

  FakeBus quiet;
  RoomRegistry reopened(repo, log, quiet);
  TreeRoom& room = *reopened.open(tid());
  CHECK_EQ(room.head(), static_cast<Seq>(8));
  CHECK_EQ(room.snapshot().nodes.size(), 201u);
  CHECK(room.hasNode(NodeId{"n0"}));
  CHECK(room.hasNode(NodeId{"n199"}));
  CHECK(room.pendingOps().empty());
  CHECK(log.since(tid(), 7).empty());  // no row past the saved head: the lattice already holds the frame
}

// The inverse cannot happen: a save that fails lands no row, because the rows are only offered to
// the log once the save has returned. The write stays queued and lands, in order, with the next save.
TEST(registry_a_failed_save_lands_no_op_row_and_keeps_the_write_queued) {
  std::vector<std::string> journal;
  RecordingTreeRepository repo(journal);
  RecordingOpLog log(journal);
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus);

  TreeRoom& room = *registry.open(tid());
  room.applyCommand(createNode("added"), 10, uid());
  repo.savesFail = true;
  bool threw = false;
  try {
    registry.persist(tid());
  } catch (const std::runtime_error&) {
    threw = true;
  }
  CHECK(threw);
  CHECK_EQ(journal, (std::vector<std::string>{"save@8"}));
  CHECK(log.byTree["t"].empty());
  CHECK_EQ(repo.byId["t"].head, static_cast<Seq>(7));
  CHECK_EQ(room.pendingOps().size(), 1u);

  repo.savesFail = false;
  registry.persist(tid());
  CHECK_EQ(journal, (std::vector<std::string>{"save@8", "save@8", "append@8"}));
  CHECK_EQ(repo.byId["t"].head, static_cast<Seq>(8));
  CHECK_EQ(nodeCount(repo.byId["t"].state), 2u);
  REQUIRE_EQ(log.byTree["t"].size(), 1u);
  CHECK_EQ(log.byTree["t"][0].seq, static_cast<Seq>(8));
  CHECK(room.pendingOps().empty());
}

// A row that fails to land after the save is an incident for the log, not a refusal for the
// caller: persist returns normally, the row stays queued, and the next persist lands it in order
// with whatever came after.
TEST(registry_persist_returns_normally_when_a_row_fails_to_land_and_lands_it_next_time) {
  std::vector<std::string> journal;
  RecordingTreeRepository repo(journal);
  RecordingOpLog log(journal);
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus);

  TreeRoom& room = *registry.open(tid());
  room.applyCommand(createNode("added"), 10, uid());
  log.failAppend = true;
  registry.persist(tid());
  CHECK_EQ(journal, (std::vector<std::string>{"save@8", "append@8"}));
  CHECK_EQ(repo.byId["t"].head, static_cast<Seq>(8));
  CHECK(log.byTree["t"].empty());
  CHECK_EQ(room.pendingOps().size(), 1u);

  log.failAppend = false;
  room.applyCommand(createNode("also"), 11, uid());
  registry.persist(tid());
  CHECK_EQ(journal, (std::vector<std::string>{"save@8", "append@8", "save@9", "append@8", "append@9"}));
  CHECK(room.pendingOps().empty());
  REQUIRE_EQ(log.byTree["t"].size(), 2u);
  CHECK_EQ(log.byTree["t"][0].seq, static_cast<Seq>(8));
  CHECK_EQ(log.byTree["t"][1].seq, static_cast<Seq>(9));
}

// Evict saves first and closes regardless: a row that fails to land after that save goes with the
// room, since the lattice it describes is durable — the feed misses the deed, the tree nothing.
TEST(registry_evict_closes_the_room_after_its_save_even_when_the_rows_fail_to_land) {
  std::vector<std::string> journal;
  RecordingTreeRepository repo(journal);
  RecordingOpLog log(journal);
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus);

  registry.open(tid())->applyCommand(createNode("added"), 10, uid());
  log.failAppend = true;
  registry.evict(tid());
  CHECK_EQ(journal, (std::vector<std::string>{"save@8", "append@8"}));
  CHECK_FALSE(registry.isOpen(tid()));
  CHECK_EQ(repo.byId["t"].head, static_cast<Seq>(8));
  CHECK_EQ(nodeCount(repo.byId["t"].state), 2u);
  CHECK(log.byTree["t"].empty());

  // Reopened, the tree holds the write, and the log holds no row past its head.
  TreeRoom& room = *registry.open(tid());
  CHECK_EQ(room.head(), static_cast<Seq>(8));
  CHECK(room.hasNode(NodeId{"added"}));
  CHECK(room.pendingOps().empty());
}

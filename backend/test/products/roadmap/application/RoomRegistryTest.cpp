#include "platform/application/StatementLimits.h"
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
#include <future>
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

// The write a door makes: landed in the room under the strand, its save asked for there and waited on without it.
PendingSave writeNode(RoomRegistry& registry, const char* node, std::uint64_t nowMs) {
  std::lock_guard<std::mutex> strand(registry.strandFor(tid()));
  registry.open(tid())->applyCommand(createNode(node), nowMs, uid());
  return registry.persist(tid());
}

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
  CHECK(registry.persist(tid()).wait() == Saved::saved);
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
  registry.persist(tid()).wait();

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
  registry.persist(tid()).wait();
  CHECK_EQ(repo.savedNodeCounts.back(), 1u);       // the slice carried only "added"
  CHECK_EQ(nodeCount(repo.byId["t"].state), 2u);   // upsert kept "seed" alongside it

  const std::size_t saves = repo.savedNodeCounts.size();
  registry.persist(tid()).wait();                         // nothing written since
  CHECK_EQ(repo.savedNodeCounts.size(), saves);    // so nothing is saved: no statement is sent
  CHECK_EQ(nodeCount(repo.byId["t"].state), 2u);

  room.applyCommand(RenameNode{nid("added"), "Renamed"}, 11, uid());
  registry.persist(tid()).wait();
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
  registry.persist(tid()).wait();

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
        std::optional<TreeAccess>(TreeAccess{uid("owner"), Visibility::private_, tid("t"), OwningStep{tid("c"), nid("seed")}}));

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

TEST(registry_a_save_that_finds_the_row_gone_answers_gone_and_retires_the_room_whichever_write_asked_for_it) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  repo.byId["u"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus);
  std::vector<std::string> announced;
  registry.whenAccessChanges([&](const TreeId& id) { announced.push_back(id.str()); });

  registry.open(tid())->applyCommand(createNode("added"), 10, uid());
  CHECK(registry.persist(tid()).wait() == Saved::saved);
  registry.open(tid("u"));
  repo.deletedIds.insert("t");  // soft-deleted outside this registry, their rows kept
  repo.deletedIds.insert("u");
  registry.open(tid())->applyCommand(createNode("ghost"), 11, uid());

  CHECK(registry.persist(tid()).wait() == Saved::gone);
  CHECK_FALSE(registry.isOpen(tid()));
  CHECK(registry.rename(tid("u"), "Ghost title", 12, Hlc{}).wait() == Saved::gone);
  CHECK_FALSE(registry.isOpen(tid("u")));
  CHECK_EQ(announced, (std::vector<std::string>{"t", "u"}));
  CHECK_EQ(nodeCount(repo.byId["t"].state), 2u);
  CHECK(repo.byId["u"].title == (Lww<std::string>{"Seeded", {}}));
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

  registry.persist(tid()).wait();
  CHECK_EQ(journal, (std::vector<std::string>{"save@9", "append@8", "append@9"}));
  CHECK(room.pendingOps().empty());
  CHECK_EQ(repo.byId["t"].head, static_cast<Seq>(9));
  REQUIRE_EQ(log.byTree["t"].size(), 2u);
  CHECK_EQ(log.byTree["t"][0].seq, static_cast<Seq>(8));
  CHECK_EQ(log.byTree["t"][1].seq, static_cast<Seq>(9));

  journal.clear();
  registry.persist(tid()).wait();                       // nothing written and nothing queued: nothing is sent
  CHECK(journal.empty());
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
    registry.persist(tid()).wait();  // the row's failure is logged, never thrown: the lattice is durable
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

// The registry's own lines about held rooms, as the operator reads them: everything from `roadmap_tree_save` to the end
// of the line, with the hold's id and the times replaced, since each is minted or measured as it runs.
std::vector<std::string> holdLines(const Told& told) {
  std::vector<std::string> lines;
  for (const std::string& logged : told.logged) {
    const std::size_t from = logged.find("roadmap_tree_save ");
    if (from == std::string::npos) continue;
    std::string line = logged.substr(from, logged.find(" - ", from) - from);
    for (const char* key : {" hold=", " held_ms=", " request_id="}) {
      const std::size_t at = line.find(key);
      if (at == std::string::npos) continue;
      const std::size_t value = at + std::string(key).size();
      line.replace(value, line.find(' ', value) == std::string::npos ? std::string::npos : line.find(' ', value) - value, "*");
    }
    lines.push_back(line);
  }
  return lines;
}

// The id a hold's lines carry, read off the n-th of them.
std::string holdIdOf(const Told& told, std::size_t nth) {
  std::size_t seen = 0;
  for (const std::string& logged : told.logged) {
    const std::size_t at = logged.find(" hold=");
    if (at == std::string::npos || seen++ != nth) continue;
    return logged.substr(at + 6, logged.find(' ', at + 6) - at - 6);
  }
  return "";
}

// A save that fails throws nothing and undoes nothing: the room keeps the write, which every open page already has,
// and the registry holds it — answered `held`, the asking write's own line `held-unsaved`, the hold's beginning one
// line under an id minted for it, and the outage one report under `roadmap.tree.save` with the rooms held — and sets
// one retry a second out. No row lands while the save has not: the rows are only offered to the log once the save has
// returned. The retry coming due, with no call in between, saves the lattice and then lands the row, ends the hold in
// one line under the same id with the tries it took and how long it was held, and sets no further retry.
TEST(registry_a_save_that_fails_holds_the_write_and_its_timed_retry_lands_the_lattice_then_the_op_row) {
  std::vector<std::string> journal;
  RecordingTreeRepository repo(journal);
  RecordingOpLog log(journal);
  FakeBus bus;
  HeldRetries retries;
  Told told;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus, retries.timer());

  TreeRoom& room = *registry.open(tid());
  room.applyCommand(createNode("added"), 10, uid());
  repo.savesFail = true;
  {
    WriteObservation door{"mcp.roadmap_create_node", "roadmap", "mcp"};
    WriteContext context{door};
    CHECK(registry.persist(tid()).wait() == Saved::held);
    door.finish();
  }
  CHECK_EQ(journal, (std::vector<std::string>{"save@8"}));
  CHECK(log.byTree["t"].empty());
  CHECK_EQ(repo.byId["t"].head, static_cast<Seq>(7));
  CHECK_EQ(room.pendingOps().size(), 1u);
  CHECK(room.hasNode(NodeId{"added"}));
  CHECK_EQ(told.lines, (std::vector<std::string>{"roadmap.tree.save roadmap mcp failed",
                                                 "mcp.roadmap_create_node roadmap mcp held-unsaved"}));
  CHECK_EQ(told.reports, (std::vector<std::string>{std::string("roadmap.tree.save roadmap mcp failed ") +
                                                   typeid(std::runtime_error).name()}));
  CHECK_EQ(holdLines(told), (std::vector<std::string>{"roadmap_tree_save outcome=held-unsaved hold=* door=mcp",
                                                      "roadmap_tree_save outcome=failed rooms=1 request_id=*"}));
  REQUIRE_EQ(retries.set.size(), 1u);
  CHECK(retries.set[0].delay == std::chrono::milliseconds{1000});

  repo.savesFail = false;
  retries.set[0].run();
  CHECK_EQ(journal, (std::vector<std::string>{"save@8", "save@8", "append@8"}));
  CHECK_EQ(repo.byId["t"].head, static_cast<Seq>(8));
  CHECK_EQ(nodeCount(repo.byId["t"].state), 2u);
  REQUIRE_EQ(log.byTree["t"].size(), 1u);
  CHECK_EQ(log.byTree["t"][0].seq, static_cast<Seq>(8));
  CHECK(room.pendingOps().empty());
  CHECK_EQ(holdLines(told).back(), std::string("roadmap_tree_save outcome=saved-after-retry hold=* attempts=2 held_ms=*"));
  CHECK_EQ(holdIdOf(told, 0).size(), 16u);
  CHECK(holdIdOf(told, 0).find_first_not_of("0123456789abcdef") == std::string::npos);
  CHECK_EQ(holdIdOf(told, 1), holdIdOf(told, 0));
  CHECK_EQ(told.reports.size(), 1u);
  CHECK_EQ(retries.set.size(), 1u);
}

// A held save is tried again a second after it failed, then after twice the wait before, up to a minute between
// tries, for as long as it fails. Nothing else moves that: a read of the tree, a write that changes nothing and a
// sweep try no save, set no retry and leave the next wait as it was, and a write that changes the room tries the save
// once without touching the timer's chain.
TEST(registry_only_the_timer_and_a_write_that_changes_the_room_try_a_held_save_and_no_call_moves_its_retry) {
  std::vector<std::string> journal;
  RecordingTreeRepository repo(journal);
  RecordingOpLog log(journal);
  FakeBus bus;
  HeldRetries retries;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus, retries.timer());
  TreeRoom& room = *registry.open(tid());
  room.applyCommand(createNode("added"), 10, uid());
  repo.savesFail = true;
  CHECK(registry.persist(tid()).wait() == Saved::held);
  retries.set[0].run();
  retries.set[1].run();
  REQUIRE_EQ(retries.set.size(), 3u);
  CHECK(retries.set[2].delay == std::chrono::milliseconds{4000});
  const std::size_t tried = journal.size();

  for (int call = 0; call < 200; ++call) CHECK(registry.open(tid()) == &room);
  for (int echo = 0; echo < 200; ++echo) CHECK(registry.persist(tid()).wait() == Saved::held);
  CHECK(registry.standing(tid()) == Saved::held);
  registry.sweep(std::chrono::seconds(0));
  CHECK(registry.isOpen(tid()));
  CHECK_EQ(journal.size(), tried);
  CHECK_EQ(retries.set.size(), 3u);

  room.applyCommand(createNode("later"), 11, uid());
  CHECK(registry.persist(tid()).wait() == Saved::held);
  CHECK_EQ(journal.size(), tried + 1);
  CHECK_EQ(retries.set.size(), 3u);

  std::vector<long long> delays{1000, 2000, 4000};
  for (std::size_t due = 2; due < 8; ++due) {
    retries.set[due].run();
    REQUIRE_EQ(retries.set.size(), due + 2);
    delays.push_back(retries.set[due + 1].delay.count());
  }
  CHECK_EQ(delays, (std::vector<long long>{1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000}));

  repo.savesFail = false;
  retries.set[8].run();
  CHECK_EQ(repo.byId["t"].head, static_cast<Seq>(9));
  CHECK(LooseGraph(repo.byId["t"].state).hasNode(NodeId{"later"}));
  CHECK(registry.standing(tid()) == Saved::saved);
  CHECK_EQ(retries.set.size(), 9u);

  room.applyCommand(createNode("again"), 12, uid());
  repo.savesFail = true;
  CHECK(registry.persist(tid()).wait() == Saved::held);
  REQUIRE_EQ(retries.set.size(), 10u);
  const std::size_t before = journal.size();
  retries.set[7].run();
  CHECK_EQ(journal.size(), before);
  CHECK_EQ(retries.set.size(), 10u);
}

// An outage is reported for the registry, not per room: one report when the first room is held, and one each minute
// after from the sweep — every second pass, half a minute apart — with the number of rooms held, however many they
// are. A room's own hold is two lines, its beginning and its end. A sweep that finds no room held reports nothing.
TEST(registry_reports_an_outage_once_when_it_begins_and_once_a_minute_with_the_rooms_held_however_many) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  HeldRetries retries;
  Told told;
  for (const char* tree : {"t", "u", "v"}) repo.byId[tree] = oneNodeTree();
  RoomRegistry registry(repo, log, bus, retries.timer());
  repo.savesFail = true;
  for (const char* tree : {"t", "u", "v"}) {
    registry.open(tid(tree))->applyCommand(createNode("added"), 10, uid());
    CHECK(registry.persist(tid(tree)).wait() == Saved::held);
  }
  CHECK_EQ(told.reports.size(), 1u);

  for (int pass = 0; pass < 4; ++pass) registry.sweep(std::chrono::hours(1));
  for (std::size_t due = 0; due < retries.set.size() && due < 12; ++due) retries.set[due].run();

  REQUIRE_EQ(told.reports.size(), 3u);
  CHECK_EQ(told.reports[0], std::string("roadmap.tree.save roadmap background failed ") + typeid(std::runtime_error).name());
  for (const std::string& report : told.reports)
    CHECK_EQ(report.rfind("roadmap.tree.save roadmap background failed ", 0), std::size_t{0});
  CHECK_EQ(holdLines(told), (std::vector<std::string>{
                                "roadmap_tree_save outcome=held-unsaved hold=* door=background",
                                "roadmap_tree_save outcome=failed rooms=1 request_id=*",
                                "roadmap_tree_save outcome=held-unsaved hold=* door=background",
                                "roadmap_tree_save outcome=held-unsaved hold=* door=background",
                                "roadmap_tree_save outcome=failed rooms=3 request_id=*",
                                "roadmap_tree_save outcome=failed rooms=3 request_id=*"}));

  repo.savesFail = false;
  for (std::size_t due = 12; due < retries.set.size(); ++due) retries.set[due].run();
  const std::size_t reports = told.reports.size();
  for (int pass = 0; pass < 4; ++pass) registry.sweep(std::chrono::hours(1));
  CHECK_EQ(told.reports.size(), reports);
  for (const char* tree : {"t", "u", "v"}) CHECK(registry.standing(tid(tree)) == Saved::saved);
}

// Only a room with something unsaved can be held. A sweep that finds an idle room with nothing to save closes it with
// no statement sent, whatever the store would have answered; one with a write still unsaved is held when its save
// fails, and kept.
TEST(registry_a_sweep_closes_a_room_with_nothing_unsaved_without_a_save_and_holds_only_one_with_a_write) {
  std::vector<std::string> journal;
  RecordingTreeRepository repo(journal);
  RecordingOpLog log(journal);
  FakeBus bus;
  HeldRetries retries;
  Told told;
  repo.byId["t"] = oneNodeTree();
  repo.byId["dirty"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus, retries.timer());
  registry.open(tid());
  registry.open(tid("dirty"))->applyCommand(createNode("added"), 10, uid());
  repo.savesFail = true;

  registry.sweep(std::chrono::seconds(0));

  CHECK_FALSE(registry.isOpen(tid()));
  CHECK(registry.isOpen(tid("dirty")));
  CHECK_EQ(journal, (std::vector<std::string>{"save@8"}));
  CHECK_EQ(holdLines(told).size(), 2u);
  CHECK_EQ(retries.set.size(), 1u);
}

// Stopping the registry tries each held room once more, all within one budget of statement time, so a store that is
// back by then has the write. A registry that simply goes away has stopped too. Rooms still held after that are lost
// with the process: one line and one report say how many, under an outcome of their own.
TEST(registry_tries_its_held_rooms_once_more_as_it_stops_within_one_budget_and_reports_the_ones_it_loses) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  HeldRetries retries;
  Told told;
  for (const char* tree : {"t", "u"}) repo.byId[tree] = oneNodeTree();
  std::vector<long long> budgets;
  {
    RoomRegistry registry(repo, log, bus, retries.timer());
    repo.savesFail = true;
    for (const char* tree : {"t", "u"}) {
      registry.open(tid(tree))->applyCommand(createNode("added"), 10, uid());
      CHECK(registry.persist(tid(tree)).wait() == Saved::held);
    }
    repo.savesFail = false;
    repo.duringSave = [&](const TreeId& tree) {
      const StatementLimits* open = StatementLimits::current();
      budgets.push_back(open ? open->lockWait().count() : -1);
      if (open && open->remaining() > RoomRegistry::kShutdownSaveBudget) budgets.push_back(-2);
      if (tree == tid("u")) throw std::runtime_error("the write was refused");
    };
  }
  CHECK_EQ(budgets, (std::vector<long long>{5000, 5000}));
  CHECK_EQ(repo.byId["t"].head, static_cast<Seq>(8));
  CHECK_EQ(repo.byId["u"].head, static_cast<Seq>(7));
  CHECK_EQ(holdLines(told).back(), std::string("roadmap_tree_save outcome=lost-at-shutdown rooms=1 request_id=*"));
  CHECK_EQ(told.lines.back(), std::string("roadmap.tree.save roadmap background lost-at-shutdown"));
  CHECK_EQ(told.reports.back().rfind("roadmap.tree.save roadmap background lost-at-shutdown ", 0), std::size_t{0});
}

// A held room whose row goes away before its save can land has nothing left to save: the retry that finds the row
// gone retires the room, as every write retires a room whose row went away, ends the hold in one line and sets no
// further retry.
TEST(registry_a_held_room_whose_row_went_away_is_retired_by_its_retry_which_says_so) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  HeldRetries retries;
  Told told;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus, retries.timer());
  registry.open(tid())->applyCommand(createNode("added"), 10, uid());
  repo.savesFail = true;
  CHECK(registry.persist(tid()).wait() == Saved::held);

  repo.savesFail = false;
  repo.deletedIds.insert("t");
  retries.set[0].run();
  CHECK_FALSE(registry.isOpen(tid()));
  CHECK_EQ(retries.set.size(), 1u);
  CHECK(log.byTree["t"].empty());
  CHECK_EQ(holdLines(told).back(), std::string("roadmap_tree_save outcome=row-gone hold=* attempts=2"));
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
  registry.persist(tid()).wait();
  CHECK_EQ(journal, (std::vector<std::string>{"save@8", "append@8"}));
  CHECK_EQ(repo.byId["t"].head, static_cast<Seq>(8));
  CHECK(log.byTree["t"].empty());
  CHECK_EQ(room.pendingOps().size(), 1u);

  log.failAppend = false;
  room.applyCommand(createNode("also"), 11, uid());
  registry.persist(tid()).wait();
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

TEST(registry_a_save_runs_with_the_strand_let_go_so_a_read_and_a_write_of_the_tree_land_while_the_store_hangs) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus);
  HangingStore store;
  repo.duringSave = store.duringSave();

  PendingSave first = writeNode(registry, "a", 10);
  std::future<Saved> saving = std::async(std::launch::async, [&] { return first.wait(); });
  REQUIRE(store.reachedBy(1, std::chrono::seconds(10)));

  std::future<std::size_t> reading = std::async(std::launch::async, [&] {
    std::lock_guard<std::mutex> strand(registry.strandFor(tid()));
    TreeRoom* room = registry.open(tid());
    room->applyCommand(createNode("b"), 11, uid());
    return room->snapshot().nodes.size();
  });
  const bool landedWhileTheStoreHung = reading.wait_for(std::chrono::seconds(5)) == std::future_status::ready;
  const bool stillSaving = saving.wait_for(std::chrono::seconds(0)) != std::future_status::ready;
  store.letGoOfIt();
  CHECK(landedWhileTheStoreHung);
  CHECK(stillSaving);
  CHECK_EQ(reading.get(), 3u);
  CHECK(saving.get() == Saved::saved);

  // The store took "a" at the head it was copied at, and its row after. "b" landed while it did: its marks stay, the
  // room is not settled, and its own save stores it with its row.
  CHECK_EQ(nodeCount(repo.byId["t"].state), 2u);
  CHECK_EQ(repo.byId["t"].head, static_cast<Seq>(8));
  REQUIRE_EQ(log.byTree["t"].size(), 1u);
  CHECK_EQ(log.byTree["t"][0].seq, static_cast<Seq>(8));
  CHECK_FALSE(registry.settled(tid()));
  REQUIRE_EQ(registry.open(tid())->pendingOps().size(), 1u);
  CHECK_EQ(registry.open(tid())->pendingOps()[0].seq, static_cast<Seq>(9));

  CHECK(registry.persist(tid()).wait() == Saved::saved);
  CHECK_EQ(nodeCount(repo.byId["t"].state), 3u);
  CHECK_EQ(repo.byId["t"].head, static_cast<Seq>(9));
  REQUIRE_EQ(log.byTree["t"].size(), 2u);
  CHECK_EQ(log.byTree["t"][1].seq, static_cast<Seq>(9));
  CHECK(registry.settled(tid()));
}

TEST(registry_two_saves_of_one_tree_never_pass_each_other_and_each_op_row_lands_after_the_save_that_covers_it) {
  std::vector<std::string> journal;
  RecordingTreeRepository repo(journal);
  RecordingOpLog log(journal);
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus);
  HangingStore store;
  repo.duringSave = store.duringSave();

  PendingSave first = writeNode(registry, "a", 10);
  std::future<Saved> firstSaving = std::async(std::launch::async, [&] { return first.wait(); });
  REQUIRE(store.reachedBy(1, std::chrono::seconds(10)));
  PendingSave second = writeNode(registry, "b", 11);
  std::future<Saved> secondSaving = std::async(std::launch::async, [&] { return second.wait(); });
  // The second save waits for the first: it has sent the store nothing while the first is still there.
  const bool secondReachedTheStore = store.reachedBy(2, std::chrono::milliseconds(300));
  store.letGoOfIt();
  CHECK_FALSE(secondReachedTheStore);
  CHECK(firstSaving.get() == Saved::saved);
  CHECK(secondSaving.get() == Saved::saved);

  CHECK_EQ(journal, (std::vector<std::string>{"save@8", "append@8", "save@9", "append@9"}));
  CHECK_EQ(repo.byId["t"].head, static_cast<Seq>(9));
  CHECK_EQ(nodeCount(repo.byId["t"].state), 3u);
  CHECK(registry.settled(tid()));
}

TEST(registry_writes_that_queue_behind_a_save_that_fails_share_its_answer_and_only_a_later_write_is_tried_again) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  HeldRetries retries;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus, retries.timer());
  HangingStore store;
  store.refuses = true;
  repo.duringSave = store.duringSave();

  // "a" and "b" are both in the room when the first save copies it; "c" lands while the store holds that save.
  PendingSave first = writeNode(registry, "a", 10);
  PendingSave second = writeNode(registry, "b", 11);
  std::future<Saved> firstSaving = std::async(std::launch::async, [&] { return first.wait(); });
  REQUIRE(store.reachedBy(1, std::chrono::seconds(10)));
  std::future<Saved> secondSaving = std::async(std::launch::async, [&] { return second.wait(); });
  PendingSave third = writeNode(registry, "c", 12);
  std::future<Saved> thirdSaving = std::async(std::launch::async, [&] { return third.wait(); });
  store.letGoOfIt();

  CHECK(firstSaving.get() == Saved::held);
  CHECK(secondSaving.get() == Saved::held);
  CHECK(thirdSaving.get() == Saved::held);
  // The first save covered "a" and "b"; the room changed after it, so one more was tried, which covered "c". Whoever
  // of the two waiting writes ran it, the other was answered without a statement.
  CHECK_EQ(store.entered, 2);
  CHECK_EQ(retries.set.size(), 1u);
  CHECK_EQ(nodeCount(repo.byId["t"].state), 1u);
  CHECK(log.byTree["t"].empty());

  repo.duringSave = {};
  retries.set[0].run();
  CHECK_EQ(nodeCount(repo.byId["t"].state), 4u);
  CHECK_EQ(repo.byId["t"].head, static_cast<Seq>(10));
  REQUIRE_EQ(log.byTree["t"].size(), 3u);
  CHECK_EQ(log.byTree["t"][0].seq, static_cast<Seq>(8));
  CHECK_EQ(log.byTree["t"][2].seq, static_cast<Seq>(10));
  CHECK(registry.standing(tid()) == Saved::saved);
}

TEST(registry_a_write_an_earlier_save_stored_is_answered_saved_though_the_save_of_a_later_write_fails) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  HeldRetries retries;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus, retries.timer());
  int saves = 0;
  bool refuses = false;
  repo.duringSave = [&](const TreeId&) {
    ++saves;
    if (refuses) throw std::runtime_error("the write was refused");
  };

  PendingSave first = writeNode(registry, "a", 10);
  PendingSave second = writeNode(registry, "b", 11);
  CHECK(second.wait() == Saved::saved);  // one save stores both
  CHECK_EQ(saves, 1);

  PendingSave third = writeNode(registry, "c", 12);
  refuses = true;
  CHECK(first.wait() == Saved::saved);  // "a" is stored; the save it ran, and that failed, is of "c"
  CHECK_EQ(saves, 2);
  CHECK(registry.standing(tid()) == Saved::held);
  CHECK(third.wait() == Saved::held);  // covered by the save that just failed: no statement of its own
  CHECK_EQ(saves, 2);
  CHECK_EQ(retries.set.size(), 1u);
  CHECK_EQ(nodeCount(repo.byId["t"].state), 3u);
}

TEST(registry_a_write_whose_room_closed_is_answered_saved_and_one_whose_room_was_retired_gone_with_no_statement) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  repo.byId["u"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus);

  PendingSave closed = writeNode(registry, "a", 10);
  CHECK(registry.evict(tid()));
  CHECK_EQ(repo.savedNodeCounts.size(), 1u);
  CHECK(closed.wait() == Saved::saved);
  CHECK_EQ(repo.savedNodeCounts.size(), 1u);
  CHECK_EQ(nodeCount(repo.byId["t"].state), 2u);

  PendingSave retired = Saved::saved;
  {
    std::lock_guard<std::mutex> strand(registry.strandFor(tid("u")));
    registry.open(tid("u"))->applyCommand(createNode("a"), 11, uid());
    retired = registry.persist(tid("u"));
    registry.retire(tid("u"));
  }
  CHECK(retired.wait() == Saved::gone);
  CHECK_EQ(repo.savedNodeCounts.size(), 1u);
  CHECK_EQ(nodeCount(repo.byId["u"].state), 1u);
}

TEST(registry_a_room_is_settled_only_with_every_write_stored_and_no_save_running_and_only_a_settled_one_closes) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus);
  const auto closes = [&] {
    std::lock_guard<std::mutex> strand(registry.strandFor(tid()));
    return registry.close(tid());
  };

  CHECK(registry.settled(tid()));  // no live room: nothing of the registry's is writing the row
  PendingSave write = writeNode(registry, "a", 10);
  CHECK_FALSE(registry.settled(tid()));
  CHECK_FALSE(closes());
  CHECK(registry.isOpen(tid()));

  // The store takes the write and the row's append fails: every write is stored, and nothing is running.
  log.failNextAppends = 1;
  CHECK(write.wait() == Saved::saved);
  CHECK(registry.settled(tid()));

  // The save that lands the row writes the tree's row again: the room is not settled while it runs.
  HangingStore store;
  repo.duringSave = store.duringSave();
  std::future<Saved> landing = std::async(std::launch::async, [&] { return registry.persist(tid()).wait(); });
  REQUIRE(store.reachedBy(1, std::chrono::seconds(10)));
  const bool settledWhileSaving = registry.settled(tid());
  const bool closedWhileSaving = closes();
  store.letGoOfIt();
  CHECK_FALSE(settledWhileSaving);
  CHECK_FALSE(closedWhileSaving);
  CHECK(landing.get() == Saved::saved);
  CHECK_EQ(log.byTree["t"].size(), 1u);

  const std::size_t statements = repo.savedNodeCounts.size();
  CHECK(closes());
  CHECK_FALSE(registry.isOpen(tid()));
  CHECK_EQ(repo.savedNodeCounts.size(), statements);
}

TEST(registry_evict_leaves_open_a_room_a_write_landed_in_while_it_was_saved_and_closes_it_once_that_is_stored) {
  FakeTreeRepository repo;
  FakeOpLog log;
  FakeBus bus;
  repo.byId["t"] = oneNodeTree();
  RoomRegistry registry(repo, log, bus);
  PendingSave first = writeNode(registry, "a", 10);
  PendingSave second = Saved::saved;
  bool landed = false;
  repo.duringSave = [&](const TreeId&) {
    if (landed) return;
    landed = true;
    second = writeNode(registry, "b", 11);  // the strand is free while the store holds the save
  };

  CHECK_FALSE(registry.evict(tid()));
  CHECK(registry.isOpen(tid()));
  CHECK_EQ(nodeCount(repo.byId["t"].state), 2u);
  CHECK_EQ(repo.savedNodeCounts.size(), 1u);

  CHECK(registry.evict(tid()));
  CHECK_FALSE(registry.isOpen(tid()));
  CHECK_EQ(nodeCount(repo.byId["t"].state), 3u);
  CHECK_EQ(repo.savedNodeCounts.size(), 2u);
  // Each write is answered by the save that stored it, the room being closed: neither sends a statement.
  CHECK(first.wait() == Saved::saved);
  CHECK(second.wait() == Saved::saved);
  CHECK_EQ(repo.savedNodeCounts.size(), 2u);
}

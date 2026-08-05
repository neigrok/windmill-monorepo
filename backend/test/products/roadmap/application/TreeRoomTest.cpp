#include "products/roadmap/application/TreeRoom.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::fake;

namespace {

TreeRoom makeRoom(FakeOpLog& log, FakeBus& bus) {
  return TreeRoom(tid(), {"Title", {}}, LooseGraph{}, Legend{}, 0, std::nullopt,
                  Visibility::private_, 0, log, bus);
}

// A server-origin edit (the MCP path): stamp it, apply it, log it, broadcast the delta.
Seq apply(TreeRoom& room, Command command, std::uint64_t ms) {
  return room.applyCommand(command, ms, uid());
}

}

TEST(room_applies_command_assigns_seq_logs_and_broadcasts) {
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room = makeRoom(log, bus);

  Seq seq = apply(room, createNode("a"), 1);
  CHECK_EQ(seq, static_cast<Seq>(1));
  CHECK_EQ(room.head(), static_cast<Seq>(1));
  CHECK_EQ(log.byTree["t"].size(), 1u);           // the op log still powers the activity feed
  CHECK_EQ(bus.subgraphBroadcasts.size(), 1u);    // and the edit fans out as one subgraph
  CHECK_EQ(room.snapshot().nodes.size(), 1u);
}

TEST(room_next_stamp_is_monotone_and_server_actored) {
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room = makeRoom(log, bus);

  Hlc first = room.nextStamp(100);
  Hlc second = room.nextStamp(100);  // same wall ms → counter advances
  Hlc third = room.nextStamp(50);    // wall time goes backward → still strictly greater
  CHECK(second > first);
  CHECK(third > second);
  CHECK_EQ(first.actor, std::string("srv"));  // authorship lives in AppliedOp.actor, not the stamp
}

TEST(room_next_stamp_dominates_a_replayed_op_after_restart) {
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room = makeRoom(log, bus);

  Hlc high{9000, 3, "peer"};
  room.replay(AppliedOp{5, "r1", createNode("z"), high, uid()});  // a loaded op-log tail
  Hlc next = room.nextStamp(10);  // local wall clock is far behind the replayed stamp
  CHECK(next > high);             // the receive rule on replay keeps a fresh mint ahead
}

TEST(room_next_stamp_dominates_the_loaded_document_state) {
  LooseGraph loaded;
  Hlc old{8000, 2, "old"};
  loaded.createNode(nid("seed"), "S", "i", NodeColor::sky, std::nullopt, old);
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room(tid(), {"T", {}}, std::move(loaded), Legend{}, 0, std::nullopt,
                Visibility::private_, 0, log, bus);

  Hlc next = room.nextStamp(10);  // wall clock behind the persisted stamp
  CHECK(next > old);              // the constructor folded the loaded document's frontier
}

namespace {
Subgraph frameWith(const char* frameId, const NodeId& node, const Hlc& stamp) {
  Subgraph frame;
  frame.treeId = tid();
  frame.frameId = frameId;
  frame.actor = stamp.actor;
  LooseGraph graph;
  graph.createNode(node, "N", "icon", NodeColor::sky, std::nullopt, stamp);
  frame.graph = graph.exportState();
  return frame;
}
}

TEST(room_join_subgraph_folds_assigns_seq_and_broadcasts) {
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room = makeRoom(log, bus);

  std::optional<Seq> seq = room.joinSubgraph(frameWith("f1", nid("a"), at(7)), uid());
  REQUIRE(seq.has_value());
  CHECK_EQ(*seq, static_cast<Seq>(1));
  CHECK_EQ(room.head(), static_cast<Seq>(1));
  CHECK_EQ(room.snapshot().nodes.size(), 1u);
  REQUIRE_EQ(bus.subgraphBroadcasts.size(), 1u);
  CHECK_EQ(bus.subgraphBroadcasts[0].seq, static_cast<Seq>(1));
}

TEST(room_join_subgraph_logs_its_headline_for_the_feed) {
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room = makeRoom(log, bus);

  Seq seq = *room.joinSubgraph(frameWith("f1", nid("a"), at(7)), uid());
  REQUIRE_EQ(log.byTree["t"].size(), 1u);            // a browser edit reaches the feed like an agent's
  const AppliedOp& op = log.byTree["t"].front();
  CHECK_EQ(op.seq, seq);                           // logged at the seq the frame took
  CHECK_EQ(op.opId, std::string("f1"));            // keyed on the frameId, so a re-gossip can't double-count
  const CreateNode* deed = std::get_if<CreateNode>(&op.command);
  REQUIRE(deed != nullptr);                        // the headline read off the frame's life-add
  CHECK_EQ(deed->id, nid("a"));
  CHECK_EQ(deed->label, std::string("N"));
}

TEST(room_join_subgraph_reposition_only_frame_logs_nothing) {
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room = makeRoom(log, bus);

  Subgraph frame;
  frame.treeId = tid();
  frame.frameId = "f1";
  NodeStateEntry moved;
  moved.id = nid("a");
  moved.position = Vec2{3, 4};
  moved.positionAt = at(9);
  frame.graph.nodes.push_back(moved);

  Seq seq = *room.joinSubgraph(frame, uid());
  CHECK_EQ(seq, static_cast<Seq>(1));              // the frame still takes a seq and broadcasts
  CHECK_EQ(bus.subgraphBroadcasts.size(), 1u);
  CHECK(log.byTree["t"].empty());                  // but a nudge is not a feed-worthy deed
}

TEST(room_join_subgraph_edge_frame_logs_a_link) {
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room = makeRoom(log, bus);

  Subgraph frame;
  frame.treeId = tid();
  frame.frameId = "f1";
  EdgeStateEntry link;
  link.edge = Edge{nid("a"), nid("b")};
  link.addedAt = at(9);
  frame.graph.edges.push_back(link);

  room.joinSubgraph(frame, uid());
  REQUIRE_EQ(log.byTree["t"].size(), 1u);
  const AddEdge* deed = std::get_if<AddEdge>(&log.byTree["t"].front().command);
  REQUIRE(deed != nullptr);
  CHECK_EQ(deed->from, nid("a"));
  CHECK_EQ(deed->to, nid("b"));
}

TEST(room_join_subgraph_dedupes_on_frame_id) {
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room = makeRoom(log, bus);

  CHECK(room.joinSubgraph(frameWith("f1", nid("a"), at(7)), uid()).has_value());
  CHECK_FALSE(room.joinSubgraph(frameWith("f1", nid("b"), at(8)), uid()).has_value());  // same frameId
  CHECK_EQ(room.head(), static_cast<Seq>(1));
  CHECK_EQ(bus.subgraphBroadcasts.size(), 1u);  // the duplicate never broadcasts
  CHECK_EQ(log.byTree["t"].size(), 1u);         // and never logs a second feed op
  CHECK_FALSE(room.snapshot().nodes.size() == 2u);  // 'b' was never joined
}

TEST(room_join_subgraph_observes_client_stamps) {
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room = makeRoom(log, bus);

  Hlc clientStamp{9000, 5, "u_9#r_z"};
  room.joinSubgraph(frameWith("f1", nid("a"), clientStamp), uid());
  Hlc next = room.nextStamp(10);  // the server's wall clock is far behind the client's stamp
  CHECK(next > clientStamp);      // the receive rule folded the client stamp on join
}

TEST(room_never_rejects_and_surfaces_cycle) {
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room = makeRoom(log, bus);

  apply(room, createNode("a"), 1);
  apply(room, createNode("b"), 2);
  apply(room, AddEdge{nid("a"), nid("b")}, 3);
  Seq closing = apply(room, AddEdge{nid("b"), nid("a")}, 4);

  CHECK_EQ(closing, static_cast<Seq>(4));
  CHECK_EQ(room.head(), static_cast<Seq>(4));

  auto report = room.diagnose();
  CHECK_FALSE(report.clean());
  REQUIRE_EQ(report.cycles.size(), 1u);
  CHECK_EQ(report.cycles[0].members.size(), 2u);
}

TEST(room_op_log_replays_since_seq) {
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room = makeRoom(log, bus);

  apply(room, createNode("a"), 1);
  apply(room, createNode("b"), 2);
  apply(room, AddEdge{nid("a"), nid("b")}, 3);

  CHECK_EQ(log.since(tid(), 1).size(), 2u);
  CHECK_EQ(log.since(tid(), 0).size(), 3u);
}

TEST(room_snapshot_carries_the_legend) {
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room = makeRoom(log, bus);

  apply(room, AddKind{KindId{"sky"}, NodeColor::sky}, 1);
  apply(room, RenameKind{KindId{"sky"}, "Infra"}, 2);

  TreeData snapshot = room.snapshot();
  REQUIRE_EQ(snapshot.kinds.size(), 1u);
  CHECK_EQ(snapshot.kinds[0].id, KindId{"sky"});
  CHECK_EQ(snapshot.kinds[0].hue, NodeColor::sky);
  CHECK_EQ(snapshot.kinds[0].label, std::string("Infra"));
}

TEST(room_validate_rejects_invalid_legend_ops_only) {
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room = makeRoom(log, bus);

  apply(room, AddKind{KindId{"sky"}, NodeColor::sky}, 1);
  CHECK(room.validate(AddKind{KindId{"dupe"}, NodeColor::sky}).has_value());   // hue taken
  CHECK_FALSE(room.validate(AddKind{KindId{"gold"}, NodeColor::gold}).has_value());
  CHECK_FALSE(room.validate(RenameNode{nid("anything"), "x"}).has_value());    // graph op: never rejected
}

TEST(room_recolor_kind_repaints_nodes) {
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room = makeRoom(log, bus);

  apply(room, CreateNode{nid("a"), "A", "i", NodeColor::olive, {}, std::nullopt}, 1);
  apply(room, AddKind{KindId{"learn"}, NodeColor::olive}, 2);
  apply(room, RecolorKind{KindId{"learn"}, NodeColor::brick}, 3);

  TreeData snapshot = room.snapshot();
  REQUIRE_EQ(snapshot.nodes.size(), 1u);
  CHECK_EQ(snapshot.nodes[0].color, NodeColor::brick);   // node followed its kind
  CHECK_EQ(snapshot.kinds[0].hue, NodeColor::brick);
}

TEST(room_tracks_exactly_the_dirty_entries_and_cleans_after_save) {
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room = makeRoom(log, bus);
  apply(room, createNode("a"), 1);
  apply(room, createNode("b"), 2);
  room.markClean();  // as if a save just landed

  apply(room, RenameNode{nid("b"), "B2"}, 3);  // touch one node only
  auto [graph, legend] = room.dirtyState();
  REQUIRE_EQ(graph.nodes.size(), 1u);            // just b — not the whole tree
  CHECK_EQ(graph.nodes[0].id, nid("b"));
  CHECK_EQ(graph.nodes[0].label, std::string("B2"));
  CHECK_EQ(graph.edges.size(), 0u);
  CHECK_EQ(legend.kinds.size(), 0u);

  apply(room, AddEdge{nid("a"), nid("b")}, 4);
  auto [withEdge, legendStill] = room.dirtyState();
  CHECK_EQ(withEdge.nodes.size(), 1u);         // b still pending
  REQUIRE_EQ(withEdge.edges.size(), 1u);         // plus the new edge
  CHECK_EQ(withEdge.edges[0].edge, (Edge{nid("a"), nid("b")}));
  CHECK_EQ(legendStill.kinds.size(), 0u);

  room.markClean();
  auto [cleanGraph, cleanLegend] = room.dirtyState();
  CHECK_EQ(cleanGraph.nodes.size(), 0u);
  CHECK_EQ(cleanGraph.edges.size(), 0u);
  CHECK_EQ(cleanLegend.kinds.size(), 0u);
}

TEST(room_replay_flips_to_all_dirty_so_the_next_save_writes_everything) {
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room = makeRoom(log, bus);
  apply(room, createNode("a"), 1);
  room.markClean();

  room.replay(AppliedOp{2, "r1", createNode("z"), at(5), uid()});  // footprint unknown to the room
  auto [graph, legend] = room.dirtyState();
  CHECK_EQ(graph.nodes.size(), 2u);  // full state, a included
  CHECK_EQ(legend.kinds.size(), 0u);
}

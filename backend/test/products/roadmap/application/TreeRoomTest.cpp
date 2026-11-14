#include "products/roadmap/application/ActivityFeed.h"
#include "products/roadmap/application/TreeRoom.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

#include <algorithm>
#include <memory>
#include <stdexcept>

using namespace wm;
using namespace wm::fake;

namespace {

TreeRoom makeRoom(FakeBus& bus) {
  return TreeRoom(tid(), {"Title", {}}, {}, false, LooseGraph{}, Legend{}, 0, tid(), {}, {},
                  std::make_shared<RootAccess>(std::nullopt, Visibility::private_), 0, bus);
}

Seq apply(TreeRoom& room, Command command, std::uint64_t ms) {
  return room.applyCommand(command, ms, uid());
}

}

TEST(room_applies_command_assigns_seq_queues_its_op_row_and_broadcasts) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);

  Seq seq = apply(room, createNode("a"), 1);
  CHECK_EQ(seq, static_cast<Seq>(1));
  CHECK_EQ(room.head(), static_cast<Seq>(1));
  CHECK_EQ(room.pendingOps().size(), 1u);
  CHECK_EQ(bus.subgraphBroadcasts.size(), 1u);
  CHECK_EQ(room.snapshot().nodes.size(), 1u);
}

TEST(room_next_stamp_is_monotone_and_server_actored) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);

  Hlc first = room.nextStamp(100);
  Hlc second = room.nextStamp(100);  // same wall ms → counter advances
  Hlc third = room.nextStamp(50);    // wall time goes backward → still strictly greater
  CHECK(second > first);
  CHECK(third > second);
  CHECK_EQ(first.actor, std::string("srv"));
}

TEST(room_next_stamp_dominates_the_loaded_document_state) {
  LooseGraph loaded;
  Hlc old{8000, 2, "old"};
  loaded.createNode(nid("seed"), "S", "i", NodeColor::sky, old);
  FakeBus bus;
  TreeRoom room(tid(), {"T", {}}, {}, false, std::move(loaded), Legend{}, 0, tid(), {}, {},
                std::make_shared<RootAccess>(std::nullopt, Visibility::private_), 0, bus);

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
  graph.createNode(node, "N", "icon", NodeColor::sky, stamp);
  frame.graph = graph.exportState();
  return frame;
}
}

TEST(room_join_subgraph_folds_assigns_seq_and_broadcasts) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);

  std::optional<Seq> seq = room.joinSubgraph(frameWith("f1", nid("a"), at(7)), uid());
  REQUIRE(seq.has_value());
  CHECK_EQ(*seq, static_cast<Seq>(1));
  CHECK_EQ(room.head(), static_cast<Seq>(1));
  CHECK_EQ(room.snapshot().nodes.size(), 1u);
  REQUIRE_EQ(bus.subgraphBroadcasts.size(), 1u);
  CHECK_EQ(bus.subgraphBroadcasts[0].seq, static_cast<Seq>(1));
}

// A frame is logged, told in the feed and broadcast as the registers that landed, not as it was sent. One that echoes
// a node whole, repeats another's label and gives a third a new colour is a recolour of the third: the echoes changed
// nothing, so they name no deed, mark no row to save and are not sent on. A frame whose every register lands reads as
// it was sent.
TEST(room_a_frame_is_logged_fed_and_broadcast_as_the_registers_that_landed) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);
  apply(room, CreateNode{nid("root"), "Root", "i", NodeColor::sky}, 1);
  apply(room, CreateNode{nid("b"), "B", "i", NodeColor::sky}, 2);
  apply(room, CreateNode{nid("c"), "C", "i", NodeColor::sky}, 3);
  room.markClean();
  const GraphState held = room.exportState();
  const auto entryOf = [&](const char* id) {
    return *std::find_if(held.nodes.begin(), held.nodes.end(), [&](const NodeStateEntry& node) { return node.id == nid(id); });
  };
  const Hlc fresh{50, 0, "phone"};

  Subgraph mixed;
  mixed.treeId = tid();
  mixed.frameId = "mixed";
  mixed.actor = "phone";
  mixed.graph.nodes = {entryOf("root"),
                       NodeStateEntry{.id = nid("b"), .label = "B", .labelAt = entryOf("b").labelAt},
                       NodeStateEntry{.id = nid("c"), .color = NodeColor::plum, .colorAt = fresh}};
  REQUIRE(room.joinSubgraph(mixed, uid()) == std::optional<Seq>(4));

  const GraphState recolour{{NodeStateEntry{.id = nid("c"), .color = NodeColor::plum, .colorAt = fresh}}, {}};
  REQUIRE_EQ(room.pendingOps().size(), 4u);
  REQUIRE(std::holds_alternative<SetNodeColor>(room.pendingOps().back().command));
  CHECK(std::get<SetNodeColor>(room.pendingOps().back().command).id == nid("c"));
  CHECK(bus.subgraphBroadcasts.back().subgraph.graph == recolour);
  CHECK_EQ(bus.subgraphBroadcasts.back().subgraph.frameId, std::string("mixed"));
  NodeStateEntry recoloured = entryOf("c");
  recoloured.color = NodeColor::plum;
  recoloured.colorAt = fresh;
  const GraphState toSave{{recoloured}, {}};
  CHECK(room.dirtyState().first == toSave);
  CHECK_EQ(activityFeed(room.snapshot(), room.pendingOps(), 1).front().summary, std::string("recolored C plum"));

  Subgraph whole;
  whole.treeId = tid();
  whole.frameId = "whole";
  whole.actor = "phone";
  whole.graph.nodes = {NodeStateEntry{.id = nid("d"), .createdAt = Hlc{51, 0, "phone"}, .label = "D", .labelAt = Hlc{51, 0, "phone"}}};
  whole.graph.edges = {EdgeStateEntry{Edge{nid("root"), nid("d")}, Hlc{51, 0, "phone"}, {}}};
  REQUIRE(room.joinSubgraph(whole, uid()) == std::optional<Seq>(5));
  CHECK(bus.subgraphBroadcasts.back().subgraph.graph == whole.graph);
  REQUIRE(std::holds_alternative<CreateNode>(room.pendingOps().back().command));
  CHECK(std::get<CreateNode>(room.pendingOps().back().command).id == nid("d"));
}

// An entry part of which lands is broadcast, saved and logged as that part, in the graph and the legend alike: a node
// whose label is new beside its held colour, an edge removed beside its held addition, a kind renamed beside its held
// hue. A title or a guide the frame carries rides the broadcast only where it took: sent beside a change with the
// stamp the room already holds, it is left out.
TEST(room_a_frame_is_broadcast_as_the_part_of_each_entry_and_tree_register_that_landed) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);
  apply(room, AddKind{KindId{"k"}, NodeColor::sky, "K"}, 1);
  apply(room, CreateNode{nid("a"), "A", "i", NodeColor::sky}, 2);
  apply(room, CreateNode{nid("b"), "B", "i", NodeColor::sky}, 3);
  apply(room, AddEdge{nid("a"), nid("b")}, 4);
  room.describe(std::string("Sail"), std::string("Rig first."), 5);
  room.markClean();
  const GraphState held = room.exportState();
  const LegendState heldLegend = room.exportLegend();
  const Hlc fresh{50, 0, "phone"};

  Subgraph partial;
  partial.treeId = tid();
  partial.frameId = "partial";
  partial.actor = "phone";
  partial.title = room.title();
  partial.guide = Lww<std::string>{"Sail first.", fresh};
  NodeStateEntry renamed = held.nodes.front();
  renamed.label = "A2";
  renamed.labelAt = fresh;
  EdgeStateEntry cut = held.edges.front();
  cut.removedAt = fresh;
  KindStateEntry relabelled = heldLegend.kinds.front();
  relabelled.label = "Kay";
  relabelled.labelAt = fresh;
  partial.graph = GraphState{{renamed}, {cut}};
  partial.legend = LegendState{{relabelled}};
  REQUIRE(room.joinSubgraph(partial, uid()).has_value());

  Subgraph landed;
  landed.treeId = tid();
  landed.frameId = "partial";
  landed.actor = "phone";
  landed.guide = Lww<std::string>{"Sail first.", fresh};
  landed.graph = GraphState{{NodeStateEntry{.id = renamed.id, .label = "A2", .labelAt = fresh}},
                            {EdgeStateEntry{cut.edge, {}, fresh}}};
  landed.legend = LegendState{{KindStateEntry{.id = KindId{"k"}, .label = "Kay", .labelAt = fresh}}};
  CHECK(bus.subgraphBroadcasts.back().subgraph == landed);

  Subgraph echoedTitle;
  echoedTitle.treeId = tid();
  echoedTitle.frameId = "echoed-title";
  echoedTitle.actor = "phone";
  echoedTitle.title = room.title();
  echoedTitle.guide = room.guide();
  echoedTitle.graph.nodes = {NodeStateEntry{.id = nid("b"), .label = "B2", .labelAt = Hlc{51, 0, "phone"}}};
  REQUIRE(room.joinSubgraph(echoedTitle, uid()).has_value());
  CHECK_FALSE(bus.subgraphBroadcasts.back().subgraph.title.has_value());
  CHECK_FALSE(bus.subgraphBroadcasts.back().subgraph.guide.has_value());
  CHECK(bus.subgraphBroadcasts.back().subgraph.graph == echoedTitle.graph);
}

// A deed that brings a node or a kind into being is logged under the name, icon and hue the room holds for it after
// the join, whatever of them the frame echoed. A revive that lands a creation stamp alone is broadcast as that stamp
// and logged as CreateNode with the label, icon and hue the node kept, so the feed reads "added Bee" while the node
// stands and after it is deleted again; a kind revived the same way is AddKind with the hue and label it kept.
TEST(room_a_frame_that_revives_a_node_or_a_kind_is_logged_under_the_name_icon_and_hue_the_room_holds) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);
  apply(room, AddKind{KindId{"k"}, NodeColor::plum, "Kay"}, 1);
  apply(room, CreateNode{nid("bee"), "Bee", "hive", NodeColor::plum}, 2);
  apply(room, DeleteNode{nid("bee")}, 3);
  apply(room, RemoveKind{KindId{"k"}}, 4);
  const Hlc fresh{50, 0, "phone"};

  Subgraph revivedNode;
  revivedNode.treeId = tid();
  revivedNode.frameId = "revive-node";
  revivedNode.actor = "phone";
  revivedNode.graph.nodes = room.exportState().nodes;
  revivedNode.graph.nodes.front().createdAt = fresh;
  REQUIRE(room.joinSubgraph(revivedNode, uid()).has_value());
  CHECK((bus.subgraphBroadcasts.back().subgraph.graph == GraphState{{NodeStateEntry{.id = nid("bee"), .createdAt = fresh}}, {}}));
  REQUIRE(std::holds_alternative<CreateNode>(room.pendingOps().back().command));
  const CreateNode logged = std::get<CreateNode>(room.pendingOps().back().command);
  CHECK_EQ(logged.label, std::string("Bee"));
  CHECK_EQ(logged.icon, std::string("hive"));
  CHECK(logged.color == NodeColor::plum);
  CHECK_EQ(activityFeed(room.snapshot(), room.pendingOps(), 1).front().summary, std::string("added Bee"));
  apply(room, DeleteNode{nid("bee")}, 60);
  CHECK_EQ(activityFeed(room.snapshot(), room.pendingOps(), 2).front().summary, std::string("added Bee"));

  Subgraph revivedKind;
  revivedKind.treeId = tid();
  revivedKind.frameId = "revive-kind";
  revivedKind.actor = "phone";
  revivedKind.legend.kinds = room.exportLegend().kinds;
  revivedKind.legend.kinds.front().createdAt = Hlc{70, 0, "phone"};
  REQUIRE(room.joinSubgraph(revivedKind, uid()).has_value());
  CHECK((bus.subgraphBroadcasts.back().subgraph.legend ==
         LegendState{{KindStateEntry{.id = KindId{"k"}, .createdAt = Hlc{70, 0, "phone"}}}}));
  REQUIRE(std::holds_alternative<AddKind>(room.pendingOps().back().command));
  const AddKind added = std::get<AddKind>(room.pendingOps().back().command);
  CHECK(added.hue == NodeColor::plum);
  CHECK_EQ(added.label, std::string("Kay"));
  CHECK_EQ(activityFeed(room.snapshot(), room.pendingOps(), 1).front().summary, std::string("added a plum kind"));
}

TEST(room_join_subgraph_queues_its_headline_for_the_feed) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);

  Seq seq = *room.joinSubgraph(frameWith("f1", nid("a"), at(7)), uid());
  REQUIRE_EQ(room.pendingOps().size(), 1u);
  const AppliedOp& op = room.pendingOps().front();
  CHECK_EQ(op.seq, seq);                           // queued at the seq the frame took
  CHECK_EQ(op.opId, std::string("f1"));            // keyed on the frameId, so a re-gossip can't double-count
  const CreateNode* deed = std::get_if<CreateNode>(&op.command);
  REQUIRE(deed != nullptr);
  CHECK_EQ(deed->id, nid("a"));
  CHECK_EQ(deed->label, std::string("N"));
}

// A frame that lands nothing — one re-sending stamps the room holds, one whose entries carry no stamp, as a frame that
// carried only keys no register keeps arrives, or one with no entry at all — takes no seq, queues no op, is told to no
// one and leaves the room as it was, the ids it named unrecorded.
TEST(room_join_subgraph_a_frame_that_lands_nothing_takes_no_seq_is_told_to_no_one_and_leaves_the_room_as_it_was) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);

  Subgraph created;
  created.treeId = tid();
  created.frameId = "f1";
  created.graph.nodes.push_back(NodeStateEntry{.id = nid("a"), .createdAt = at(9), .label = "A", .labelAt = at(9)});
  Subgraph again = created;
  again.frameId = "f2";
  Subgraph bare;
  bare.treeId = tid();
  bare.frameId = "f3";
  bare.graph.nodes = {NodeStateEntry{.id = nid("a")}, NodeStateEntry{.id = nid("ghost")}};
  bare.graph.edges = {EdgeStateEntry{Edge{nid("a"), nid("ghost")}, {}, {}}};
  KindStateEntry kind;
  kind.id = KindId{"ghost"};
  bare.legend.kinds = {kind};
  Subgraph empty;
  empty.treeId = tid();
  empty.frameId = "f4";

  CHECK(room.joinSubgraph(created, uid()) == std::optional<Seq>(1));
  const GraphState landed = room.exportState();
  const LegendState legend = room.exportLegend();
  room.markClean();
  CHECK(room.joinSubgraph(again, uid()) == std::nullopt);
  CHECK(room.joinSubgraph(bare, uid()) == std::nullopt);
  CHECK(room.joinSubgraph(empty, uid()) == std::nullopt);
  CHECK_EQ(room.head(), static_cast<Seq>(1));
  CHECK(room.exportState() == landed);
  CHECK(room.exportLegend() == legend);
  CHECK(room.dirtyState() == (std::pair<GraphState, LegendState>{}));
  CHECK_EQ(bus.subgraphBroadcasts.size(), 1u);
  CHECK_EQ(room.pendingOps().size(), 1u);
}

TEST(room_join_subgraph_edge_frame_queues_a_link) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);

  Subgraph frame;
  frame.treeId = tid();
  frame.frameId = "f1";
  EdgeStateEntry link;
  link.edge = Edge{nid("a"), nid("b")};
  link.addedAt = at(9);
  frame.graph.edges.push_back(link);

  room.joinSubgraph(frame, uid());
  REQUIRE_EQ(room.pendingOps().size(), 1u);
  const AddEdge* deed = std::get_if<AddEdge>(&room.pendingOps().front().command);
  REQUIRE(deed != nullptr);
  CHECK_EQ(deed->from, nid("a"));
  CHECK_EQ(deed->to, nid("b"));
}

TEST(room_join_subgraph_dedupes_on_frame_id) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);

  CHECK(room.joinSubgraph(frameWith("f1", nid("a"), at(7)), uid()).has_value());
  CHECK_FALSE(room.joinSubgraph(frameWith("f1", nid("b"), at(8)), uid()).has_value());  // same frameId
  CHECK_EQ(room.head(), static_cast<Seq>(1));
  CHECK_EQ(bus.subgraphBroadcasts.size(), 1u);
  CHECK_EQ(room.pendingOps().size(), 1u);
  CHECK_FALSE(room.snapshot().nodes.size() == 2u);
}

TEST(room_join_subgraph_observes_client_stamps) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);

  Hlc clientStamp{9000, 5, "u_9#r_z"};
  room.joinSubgraph(frameWith("f1", nid("a"), clientStamp), uid());
  Hlc next = room.nextStamp(10);  // the server's wall clock is far behind the client's stamp
  CHECK(next > clientStamp);      // the receive rule folded the client stamp on join
}

TEST(room_never_rejects_and_surfaces_cycle) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);

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

TEST(room_queues_its_op_rows_in_seq_order_and_the_ones_that_landed_leave_from_the_front) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);

  apply(room, createNode("a"), 1);
  apply(room, createNode("b"), 2);
  apply(room, AddEdge{nid("a"), nid("b")}, 3);
  REQUIRE_EQ(room.pendingOps().size(), 3u);
  CHECK_EQ(room.pendingOps()[0].seq, static_cast<Seq>(1));
  CHECK_EQ(room.pendingOps()[2].seq, static_cast<Seq>(3));

  // A save copied the three rows and its append failed on the third; a write queued a fourth meanwhile.
  apply(room, createNode("c"), 4);
  room.dropLandedOps(2);
  REQUIRE_EQ(room.pendingOps().size(), 2u);
  CHECK_EQ(room.pendingOps()[0].seq, static_cast<Seq>(3));
  CHECK_EQ(room.pendingOps()[1].seq, static_cast<Seq>(4));
  CHECK(room.unsaved());

  room.dropLandedOps(0);  // an append that landed nothing leaves the queue as it is
  CHECK_EQ(room.pendingOps().size(), 2u);
  room.dropLandedOps(2);
  CHECK(room.pendingOps().empty());
}

// A frame of replica `r_a`'s: the registers given, as its lattice sends a write.
static Subgraph frameOf(const char* frameId, GraphState graph, LegendState legend = {}) {
  Subgraph frame;
  frame.treeId = tid();
  frame.frameId = frameId;
  frame.actor = "r_a";
  frame.graph = std::move(graph);
  frame.legend = std::move(legend);
  return frame;
}

// A delete that lands late — a node's, an edge's removal, a kind's — reaches a subscriber that was away, as a late
// field does: each tombstone is a row with a land seq of its own. The subscriber's vector is past every stamp of the
// late frame, so the vector alone sends none of them; its position sends all three whole, and nothing else.
TEST(a_late_delete_reaches_a_subscriber_that_was_away) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);
  const Hlc early{100, 0, "r_a"};
  const Hlc late{200, 0, "r_a"};
  const Hlc later{300, 0, "r_a"};
  NodeStateEntry n{.id = nid("n"), .createdAt = early};
  NodeStateEntry p{.id = nid("p"), .createdAt = early};
  EdgeStateEntry edge{Edge{nid("n"), nid("p")}, early, {}};
  KindStateEntry kind{.id = KindId{"k"}, .createdAt = early, .hue = NodeColor::plum, .hueAt = early};
  REQUIRE(room.joinSubgraph(frameOf("f-born", GraphState{{n, p}, {edge}}, LegendState{{kind}}), uid()) == std::optional<Seq>(1));
  REQUIRE(room.joinSubgraph(frameOf("f-later", GraphState{{NodeStateEntry{.id = nid("m"), .createdAt = later}}, {}}), uid()) ==
          std::optional<Seq>(2));
  const VersionVector covered = *room.deltaSince(VersionVector{}).coverage;  // the subscriber's answer, at seq 2

  REQUIRE(room.joinSubgraph(frameOf("f-late", GraphState{{NodeStateEntry{.id = nid("n"), .deletedAt = late}},
                                                         {EdgeStateEntry{edge.edge, {}, late}}},
                                    LegendState{{KindStateEntry{.id = KindId{"k"}, .deletedAt = late}}}),
                            uid()) == std::optional<Seq>(3));
  n.deletedAt = late;
  edge.removedAt = late;
  kind.deletedAt = late;

  const Subgraph byVector = room.deltaSince(covered);
  CHECK(byVector.graph == GraphState{});
  CHECK(byVector.legend == LegendState{});

  const Subgraph byPosition = room.deltaSince(covered, 2);
  CHECK(byPosition.graph == (GraphState{{n}, {edge}}));
  CHECK(byPosition.legend == (LegendState{{kind}}));

  const Subgraph atTheHead = room.deltaSince(covered, 3);
  CHECK(atTheHead.graph == GraphState{});
  CHECK(atTheHead.legend == LegendState{});
}

// The tree's own registers land at a seq as its entries do: a title or a guide that lands late, under a stamp the
// subscriber's vector is past, is sent to one that was away, and the register that did not land late is not.
TEST(a_title_or_a_guide_that_lands_late_reaches_a_subscriber_that_was_away) {
  for (const bool lateTitle : {true, false}) {
    FakeBus bus;
    TreeRoom room = makeRoom(bus);
    const Lww<std::string> first{"first", Hlc{100, 0, "r_a"}};
    const Lww<std::string> late{"late", Hlc{200, 0, "r_a"}};
    Subgraph born = frameOf("f-born", {});
    born.title = first;
    born.guide = first;
    REQUIRE(room.joinSubgraph(born, uid()) == std::optional<Seq>(1));
    REQUIRE(room.joinSubgraph(frameOf("f-later", GraphState{{NodeStateEntry{.id = nid("m"), .createdAt = Hlc{300, 0, "r_a"}}}, {}}),
                              uid()) == std::optional<Seq>(2));
    const VersionVector covered = *room.deltaSince(VersionVector{}).coverage;

    Subgraph landing = frameOf("f-late", {});
    (lateTitle ? landing.title : landing.guide) = late;
    REQUIRE(room.joinSubgraph(landing, uid()) == std::optional<Seq>(3));

    const Subgraph byVector = room.deltaSince(covered);
    CHECK_FALSE(byVector.title.has_value());
    CHECK_FALSE(byVector.guide.has_value());
    const Subgraph byPosition = room.deltaSince(covered, 2);
    CHECK(byPosition.title == (lateTitle ? std::optional<Lww<std::string>>(late) : std::nullopt));
    CHECK(byPosition.guide == (lateTitle ? std::nullopt : std::optional<Lww<std::string>>(late)));
    CHECK(byPosition.graph == GraphState{});
  }
}

// Only what lands late takes a land seq. An ordinary frame, under stamps past everything the room held for its actor,
// and a command, which the server stamps past everything, take none: a subscriber at any position is sent what its
// vector lacks, cut to the registers it lacks, and nothing whole.
TEST(an_ordinary_frame_and_an_ordinary_command_record_no_land_seq) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);
  REQUIRE(room.joinSubgraph(frameOf("f-a", GraphState{{NodeStateEntry{.id = nid("a"), .createdAt = Hlc{100, 0, "r_a"}}}, {}}), uid()) ==
          std::optional<Seq>(1));
  apply(room, createNode("b"), 2'000);
  const VersionVector covered = *room.deltaSince(VersionVector{}).coverage;
  REQUIRE(room.joinSubgraph(frameOf("f-rename", GraphState{{NodeStateEntry{.id = nid("a"), .label = "A", .labelAt = Hlc{3'000, 0, "r_a"}}}, {}}),
                            uid()) == std::optional<Seq>(3));
  apply(room, RenameNode{nid("b"), "B"}, 4'000);

  CHECK(room.landSeqs() == LandSeqs{});
  const Subgraph byVector = room.deltaSince(covered);
  REQUIRE_EQ(byVector.graph.nodes.size(), 2u);
  CHECK(byVector.graph.nodes[0].createdAt == Hlc{});  // cut to the label it lacks
  CHECK(room.deltaSince(covered, 0) == byVector);
  CHECK(room.deltaSince(covered, 2) == byVector);
}

// A frame that carries a late register beside an ordinary one records a land seq for the late entry alone: the
// subscriber that was away is sent that entry whole and the other cut to what its vector lacks.
TEST(a_frame_with_a_late_register_and_an_ordinary_one_records_a_land_seq_for_the_late_entry_alone) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);
  NodeStateEntry n{.id = nid("n"), .createdAt = Hlc{100, 0, "r_a"}};
  NodeStateEntry m{.id = nid("m"), .createdAt = Hlc{300, 0, "r_a"}};
  REQUIRE(room.joinSubgraph(frameOf("f-n", GraphState{{n}, {}}), uid()) == std::optional<Seq>(1));
  REQUIRE(room.joinSubgraph(frameOf("f-m", GraphState{{m}, {}}), uid()) == std::optional<Seq>(2));
  const VersionVector covered = *room.deltaSince(VersionVector{}).coverage;

  // One frame: `n`'s label under a stamp below the 300 the room holds for r_a, and `m`'s under one past it.
  n.label = "N late";
  n.labelAt = Hlc{200, 0, "r_a"};
  const NodeStateEntry renamed{.id = nid("m"), .label = "M now", .labelAt = Hlc{400, 0, "r_a"}};
  REQUIRE(room.joinSubgraph(frameOf("f-both", GraphState{{NodeStateEntry{.id = nid("n"), .label = n.label, .labelAt = n.labelAt}, renamed}, {}}),
                            uid()) == std::optional<Seq>(3));

  LandSeqs late;
  late.nodes = {{nid("n"), 3}};
  CHECK(room.landSeqs() == late);
  CHECK(room.deltaSince(covered, 2).graph == (GraphState{{renamed, n}, {}}));
  CHECK(room.deltaSince(covered).graph == (GraphState{{renamed}, {}}));
}

// What the room has held is never below what a scan of its state reports, and is the same until an actor's greatest
// stamp is overwritten by another actor's: the scan then loses that actor's mark and the room keeps it, so a write of
// that actor's below it is still late. A room rebuilt from the same state starts from the scan again, with the
// greatest stamp of all as its floor.
TEST(what_a_room_has_held_is_never_below_a_scan_of_its_state_and_the_same_until_an_actors_greatest_stamp_is_overwritten) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);
  const auto scanned = [](const TreeRoom& of) { return *of.deltaSince(VersionVector{}).coverage; };
  const NodeStateEntry n{.id = nid("n"), .createdAt = Hlc{100, 0, "r_a"}};
  const EdgeStateEntry edge{Edge{nid("n"), nid("p")}, Hlc{120, 0, "r_a"}, {}};
  REQUIRE(room.joinSubgraph(frameOf("f-1", GraphState{{n, NodeStateEntry{.id = nid("p"), .createdAt = Hlc{110, 0, "r_b"}}}, {edge}},
                                    LegendState{{KindStateEntry{.id = KindId{"k"}, .createdAt = Hlc{130, 0, "r_b"}, .hue = NodeColor::plum,
                                                                .hueAt = Hlc{130, 0, "r_b"}}}}),
                            uid()).has_value());
  apply(room, createNode("c"), 2'000);
  REQUIRE(room.joinSubgraph(frameOf("f-2", GraphState{{NodeStateEntry{.id = nid("p"), .deletedAt = Hlc{3'000, 0, "r_a"}}},
                                                      {EdgeStateEntry{edge.edge, {}, Hlc{3'001, 0, "r_a"}}}},
                                    LegendState{{KindStateEntry{.id = KindId{"k"}, .deletedAt = Hlc{3'002, 0, "r_b"}}}}),
                            uid()).has_value());
  Subgraph guided = frameOf("f-3", {});
  guided.guide = Lww<std::string>{"Rig first.", Hlc{3'100, 0, "r_c"}};
  REQUIRE(room.joinSubgraph(guided, uid()).has_value());
  CHECK(room.held().marks == scanned(room));  // writes, deletes, a command and a tree register: nothing overwritten

  // r_c's one stamp is on the guide; r_b writes the guide over it.
  Subgraph reguided = frameOf("f-4", {});
  reguided.guide = Lww<std::string>{"Sail first.", Hlc{3'200, 0, "r_b"}};
  REQUIRE(room.joinSubgraph(reguided, uid()).has_value());
  const VersionVector scan = scanned(room);
  CHECK_FALSE(scan.marks.count("r_c"));
  CHECK(room.held().marks.marks.at("r_c") == (Hlc{3'100, 0, "r_c"}));
  for (const auto& [actor, mark] : scan.marks) CHECK(room.held().marks.covers(mark));

  // The same state in a room built from it: the scan again, and the floor at the greatest stamp of all.
  TreeRoom rebuilt(tid(), room.title(), room.guide(), false, LooseGraph(room.exportState()), Legend(room.exportLegend()), room.head(),
                   tid(), {}, {}, std::make_shared<RootAccess>(std::nullopt, Visibility::private_), 0, bus);
  CHECK(rebuilt.held().marks == scan);
  CHECK(rebuilt.held().floor == (Hlc{3'200, 0, "r_b"}));
  CHECK(rebuilt.held().holds(Hlc{3'100, 0, "r_c"}));  // at or below the floor, though no mark of r_c's is left
  CHECK_FALSE(rebuilt.held().holds(Hlc{3'201, 0, "r_c"}));
}

TEST(room_snapshot_carries_the_legend) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);

  apply(room, AddKind{KindId{"sky"}, NodeColor::sky}, 1);
  apply(room, RenameKind{KindId{"sky"}, "Infra"}, 2);

  TreeData snapshot = room.snapshot();
  REQUIRE_EQ(snapshot.kinds.size(), 1u);
  CHECK_EQ(snapshot.kinds[0].id, KindId{"sky"});
  CHECK_EQ(snapshot.kinds[0].hue, NodeColor::sky);
  CHECK_EQ(snapshot.kinds[0].label, std::string("Infra"));
}

TEST(room_validate_speaks_for_the_live_state) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);

  apply(room, AddKind{KindId{"sky"}, NodeColor::sky}, 1);
  CHECK(room.validate(AddKind{KindId{"dupe"}, NodeColor::sky}).has_value());
  CHECK_FALSE(room.validate(AddKind{KindId{"gold"}, NodeColor::gold}).has_value());
  apply(room, CreateNode{nid("a"), "A", "i", NodeColor::sky}, 2);
  CHECK_FALSE(room.validate(RenameNode{nid("a"), "x"}).has_value());
  CHECK_EQ(room.validate(RenameNode{nid("anything"), "x"}),
           std::optional<std::string>("no node in this tree is named \"anything\""));
}

TEST(room_recoloring_a_kind_repaints_nodes) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);

  apply(room, CreateNode{nid("a"), "A", "i", NodeColor::olive}, 1);
  apply(room, AddKind{KindId{"learn"}, NodeColor::olive}, 2);
  apply(room, RecolorKind{KindId{"learn"}, NodeColor::brick}, 3);

  TreeData snapshot = room.snapshot();
  REQUIRE_EQ(snapshot.nodes.size(), 1u);
  CHECK_EQ(snapshot.nodes[0].color, NodeColor::brick);
  CHECK_EQ(snapshot.kinds[0].hue, NodeColor::brick);
}

// The frame a kind's re-hue broadcasts carries a deleted wearer's new colour as that one register, with no life stamp:
// a replica that joins it moves the colour and the node stays deleted, here and there.
TEST(room_recoloring_a_kind_broadcasts_a_deleted_wearers_colour_and_no_life_stamp) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);
  apply(room, AddKind{KindId{"k"}, NodeColor::sky}, 1);
  apply(room, CreateNode{nid("a"), "A", "i", NodeColor::sky}, 2);
  apply(room, CreateNode{nid("b"), "B", "i", NodeColor::sky}, 3);
  apply(room, DeleteNode{nid("b")}, 4);

  apply(room, RecolorKind{KindId{"k"}, NodeColor::plum}, 5);

  const Subgraph& frame = bus.subgraphBroadcasts.back().subgraph;
  REQUIRE_EQ(frame.legend.kinds.size(), 1u);
  const Hlc stamp = frame.legend.kinds[0].hueAt;
  CHECK((frame.graph.nodes ==
         std::vector<NodeStateEntry>{{.id = nid("a"), .color = NodeColor::plum, .colorAt = stamp},
                                     {.id = nid("b"), .color = NodeColor::plum, .colorAt = stamp}}));
  CHECK_FALSE(room.hasNode(nid("b")));
  LooseGraph replica{room.exportState()};
  CHECK_FALSE(replica.hasNode(nid("b")));
  CHECK(replica.exportNode(nid("b"))->color == NodeColor::plum);
}

TEST(room_tracks_exactly_the_dirty_entries_and_cleans_after_save) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);
  apply(room, createNode("a"), 1);
  apply(room, createNode("b"), 2);
  room.markClean();

  apply(room, RenameNode{nid("b"), "B2"}, 3);
  auto [graph, legend] = room.dirtyState();
  REQUIRE_EQ(graph.nodes.size(), 1u);
  CHECK_EQ(graph.nodes[0].id, nid("b"));
  CHECK_EQ(graph.nodes[0].label, std::string("B2"));
  CHECK_EQ(graph.edges.size(), 0u);
  CHECK_EQ(legend.kinds.size(), 0u);

  apply(room, AddEdge{nid("a"), nid("b")}, 4);
  auto [withEdge, legendStill] = room.dirtyState();
  CHECK_EQ(withEdge.nodes.size(), 1u);
  REQUIRE_EQ(withEdge.edges.size(), 1u);
  CHECK_EQ(withEdge.edges[0].edge, (Edge{nid("a"), nid("b")}));
  CHECK_EQ(legendStill.kinds.size(), 0u);

  room.markClean();
  auto [cleanGraph, cleanLegend] = room.dirtyState();
  CHECK_EQ(cleanGraph.nodes.size(), 0u);
  CHECK_EQ(cleanGraph.edges.size(), 0u);
  CHECK_EQ(cleanLegend.kinds.size(), 0u);
}

TEST(room_applies_a_batch_as_one_frame_under_one_seq_with_one_op_row_holding_every_member) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);
  apply(room, createNode("a"), 1);
  apply(room, createNode("b"), 2);
  apply(room, AddEdge{nid("a"), nid("b")}, 3);

  Seq seq = room.applyCommands(
      {DeleteNode{nid("a")}, DeleteNode{nid("b")}, RemoveEdge{nid("a"), nid("b")}}, 4, uid());
  CHECK_EQ(seq, static_cast<Seq>(4));
  CHECK_EQ(room.head(), static_cast<Seq>(4));
  CHECK_FALSE(room.hasNode(nid("a")));
  CHECK_FALSE(room.hasNode(nid("b")));
  CHECK_FALSE(room.hasEdge(nid("a"), nid("b")));
  CHECK(room.diagnose().clean());

  REQUIRE_EQ(room.pendingOps().size(), 4u);
  CHECK_EQ(room.pendingOps().back().seq, static_cast<Seq>(4));
  REQUIRE(std::holds_alternative<Batch>(room.pendingOps().back().command));
  const std::vector<Command>& logged = std::get<Batch>(room.pendingOps().back().command).commands;
  REQUIRE_EQ(logged.size(), 3u);
  CHECK_EQ(std::get<DeleteNode>(logged[0]).id, nid("a"));
  CHECK_EQ(std::get<DeleteNode>(logged[1]).id, nid("b"));
  CHECK_EQ(std::get<RemoveEdge>(logged[2]).from, nid("a"));
  CHECK_EQ(std::get<RemoveEdge>(logged[2]).to, nid("b"));
  REQUIRE_EQ(bus.subgraphBroadcasts.size(), 4u);
  CHECK_EQ(bus.subgraphBroadcasts.back().seq, static_cast<Seq>(4));
  CHECK_EQ(bus.subgraphBroadcasts.back().subgraph.graph.nodes.size(), 2u);
  CHECK_EQ(bus.subgraphBroadcasts.back().subgraph.graph.edges.size(), 1u);
  CHECK_EQ(bus.subgraphBroadcasts.back().subgraph.frameId, room.pendingOps().back().opId);
}

TEST(room_edges_touching_reads_the_live_graph) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);
  apply(room, createNode("a"), 1);
  apply(room, createNode("b"), 2);
  apply(room, createNode("c"), 3);
  apply(room, AddEdge{nid("a"), nid("b")}, 4);
  apply(room, AddEdge{nid("b"), nid("c")}, 5);

  CHECK_EQ(room.edgesTouching({nid("b")}), (std::vector<Edge>{Edge{nid("a"), nid("b")}, Edge{nid("b"), nid("c")}}));
  CHECK_EQ(room.edgesTouching({nid("a")}), (std::vector<Edge>{Edge{nid("a"), nid("b")}}));
  CHECK(room.hasEdge(nid("a"), nid("b")));
  CHECK_FALSE(room.hasEdge(nid("b"), nid("a")));
}

TEST(room_import_tree_lands_the_upsert_the_replacements_and_the_tombstones_at_one_seq) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);
  for (const char* id : {"a", "b", "c", "n"}) apply(room, createNode(id), 1);
  apply(room, AddEdge{nid("a"), nid("n")}, 2);
  apply(room, AddEdge{nid("c"), nid("n")}, 3);
  apply(room, AddEdge{nid("n"), nid("b")}, 4);
  const Seq before = room.head();

  NodeSpec n;
  n.id = nid("n");
  n.label = "N";
  n.prerequisites = {nid("a")};
  Graft graft;
  graft.document.nodes = {n};
  graft.prerequisites = PrerequisiteMode::replace;
  graft.tombstones = {nid("b")};

  const Seq seq = room.importTree(graft, 100, uid()).value();
  CHECK_EQ(seq, before + 1);
  CHECK_EQ(room.head(), seq);
  CHECK_EQ(room.prerequisitesOf(nid("n")), (std::vector<NodeId>{nid("a")}));
  CHECK_FALSE(room.hasNode(nid("b")));
  CHECK(room.diagnose().dangling.empty());

  // Every removal carries the graft's one stamp, later than anything the room held.
  const GraphState state = room.exportState();
  Hlc removal;
  for (const EdgeStateEntry& edge : state.edges) {
    if (edge.edge == Edge{nid("a"), nid("n")}) CHECK_FALSE(edge.removedAt.isSet());
    if (edge.edge == Edge{nid("c"), nid("n")} || edge.edge == Edge{nid("n"), nid("b")}) {
      CHECK(edge.removedAt > edge.addedAt);
      if (removal.isSet()) CHECK_EQ(edge.removedAt, removal);
      removal = edge.removedAt;
    }
  }
  CHECK(removal.isSet());

  // A later merge re-add outranks the removal.
  n.prerequisites = {nid("c")};
  Graft again;
  again.document.nodes = {n};
  room.importTree(again, 200, uid());
  CHECK_EQ(room.prerequisitesOf(nid("n")), (std::vector<NodeId>{nid("a"), nid("c")}));
}

// A client removed the kind while offline, before the import, and its frame lands after it. The remove
// wins as it would over a rename: the legend loses the kind, the label the import changed waits on its
// record, and the node wearing its hue keeps that hue with no kind claiming it.
TEST(room_import_loses_a_re_sent_kind_to_a_remove_stamped_before_it_that_arrives_after_it) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);
  apply(room, AddKind{KindId{"backend"}, NodeColor::sky, "Backend"}, 10);
  apply(room, CreateNode{nid("review"), "Review", "", NodeColor::sky}, 20);

  Graft graft;
  graft.document.kinds = {{KindId{"backend"}, NodeColor::sky, "Backend services"}};
  graft.omittedKindRegisters[KindId{"backend"}] = {KindRegister::description};
  room.importTree(graft, 100, uid());
  Subgraph remove;
  remove.treeId = tid();
  remove.frameId = "offline-remove";
  remove.actor = "u1";
  remove.legend = LegendState{{KindStateEntry{.id = KindId{"backend"}, .deletedAt = Hlc{50, 0, "u1"}}}};
  REQUIRE(room.joinSubgraph(remove, uid()).has_value());

  const TreeData tree = room.snapshot();
  CHECK(tree.kinds.empty());
  REQUIRE_EQ(tree.nodes.size(), 1u);
  CHECK_EQ(tree.nodes[0].id, nid("review"));
  CHECK_EQ(tree.nodes[0].color, NodeColor::sky);
  CHECK(room.exportLegend() ==
        (LegendState{{KindStateEntry{.id = KindId{"backend"}, .createdAt = Hlc{10, 0, "srv"},
                                     .deletedAt = Hlc{50, 0, "u1"}, .hue = NodeColor::sky,
                                     .hueAt = Hlc{10, 0, "srv"}, .label = "Backend services",
                                     .labelAt = Hlc{100, 0, "srv"}, .rank = 0, .rankAt = Hlc{10, 0, "srv"}}}}));
}

TEST(room_applies_an_empty_batch_as_a_no_op_that_mints_no_seq) {
  FakeBus bus;
  TreeRoom room = makeRoom(bus);
  apply(room, createNode("a"), 1);

  CHECK_EQ(room.applyCommands({}, 2, uid()), static_cast<Seq>(1));
  CHECK_EQ(room.head(), static_cast<Seq>(1));
  CHECK_EQ(room.pendingOps().size(), 1u);
  CHECK_EQ(bus.subgraphBroadcasts.size(), 1u);
}

// The tree a node opens goes only to a caller who can write the tree, so a room hands its pointers to nobody else.
TEST(room_hands_its_pointers_to_a_caller_who_can_write_the_tree_and_to_nobody_else) {
  FakeBus bus;
  LooseGraph graph;
  graph.createNode(nid("idea"), "Idea", "", NodeColor::sky, at(1));
  graph.createNode(nid("plain"), "Plain", "", NodeColor::sky, at(2));
  graph.setOpens(nid("idea"), tid("t_sub"), at(3));
  const TreeRoom owned(tid(), {"Title", {}}, {}, false, graph, Legend{}, 0, tid(), {}, {},
                       std::make_shared<RootAccess>(uid("owner"), Visibility::public_), 0, bus);
  const TreeRoom nobodys(tid(), {"Title", {}}, {}, false, graph, Legend{}, 0, tid(), {}, {},
                         std::make_shared<RootAccess>(std::nullopt, Visibility::public_), 0, bus);

  CHECK(owned.pointersFor(uid("owner")) == (std::map<NodeId, TreeId>{{nid("idea"), tid("t_sub")}}));
  CHECK(owned.pointersFor(uid("stranger")) == (std::map<NodeId, TreeId>{}));
  CHECK(owned.pointersFor(std::nullopt) == (std::map<NodeId, TreeId>{}));
  CHECK(nobodys.pointersFor(uid("owner")) == (std::map<NodeId, TreeId>{}));
  CHECK_EQ(owned.snapshots(), std::size_t{0});
}

// A step that owns a subtree opens it in every projection the room makes, whatever its pointer holds, and under no stamp;
// a step deleted from the tree owns nothing the room tells, and a subtree created under a step is owned from its seq on.
TEST(room_reads_the_subtree_a_step_owns_as_the_tree_it_opens_whatever_its_pointer_holds) {
  FakeBus bus;
  LooseGraph graph;
  graph.createNode(nid("sail"), "Sail", "", NodeColor::sky, at(1));
  graph.createNode(nid("rig"), "Rig", "", NodeColor::sky, at(2));
  graph.createNode(nid("gone"), "Gone", "", NodeColor::sky, at(3));
  graph.createNode(nid("idea"), "Idea", "", NodeColor::sky, at(4));
  graph.setOpens(nid("sail"), tid("t_old"), at(5));
  graph.setOpens(nid("idea"), tid("t_other"), at(6));
  graph.deleteNode(nid("gone"), at(7));
  TreeRoom room(tid(), {"Title", {}}, {}, false, graph, Legend{}, 0, tid(), {},
                {{nid("sail"), tid("t_s")}, {nid("gone"), tid("t_g")}},
                std::make_shared<RootAccess>(uid("owner"), Visibility::public_), 0, bus);

  CHECK(room.subtrees() == (std::map<NodeId, TreeId>{{nid("sail"), tid("t_s")}}));
  CHECK(room.pointers() == (std::map<NodeId, TreeId>{{nid("idea"), tid("t_other")}, {nid("sail"), tid("t_s")}}));
  CHECK(room.stampedPointers() == (std::map<NodeId, StampedPointer>{{nid("idea"), {tid("t_other"), at(6)}},
                                                                    {nid("sail"), {tid("t_s"), Hlc{}}}}));
  CHECK(room.pointersFor(uid("owner")) == room.pointers());
  std::map<NodeId, TreeId> opened;
  for (const NodeSpec& node : room.snapshot().nodes) opened.emplace(node.id, node.opens);
  CHECK(opened == (std::map<NodeId, TreeId>{{nid("idea"), tid("t_other")}, {nid("rig"), TreeId{}}, {nid("sail"), tid("t_s")}}));

  room.appendSubtree(nid("rig"), Subtree{tid("t_r"), tid(), OwningStep{tid(), nid("rig")}, 1, 0});
  CHECK_EQ(room.head(), Seq{1});
  CHECK(room.subtrees() == (std::map<NodeId, TreeId>{{nid("rig"), tid("t_r")}, {nid("sail"), tid("t_s")}}));
  CHECK(room.pointers().at(nid("rig")) == tid("t_r"));
}

// A subtree is named by its owning step's label, which a subscriber is sent beside the delta: its own title register,
// which the socket and a posted document still write, is never sent nor counted in the delta's coverage. A root's is.
TEST(room_sends_a_subtree_no_title_register_of_its_own_and_a_root_its_own) {
  FakeBus bus;
  const auto roomWith = [&bus](const std::optional<OwningStep>& parent) {
    return TreeRoom(tid("t_s"), {"Its own register", at(9, "r_old")}, {}, false, LooseGraph{}, Legend{}, 0, tid("t_a"),
                    parent ? std::vector<OwningStep>{*parent} : std::vector<OwningStep>{}, {},
                    std::make_shared<RootAccess>(uid("owner"), Visibility::private_), 0, bus);
  };
  const Subgraph subtree = roomWith(OwningStep{tid("t_a"), nid("sail")}).deltaSince(VersionVector{});
  CHECK_FALSE(subtree.title.has_value());
  CHECK_FALSE(subtree.coverage->marks.count("r_old"));
  const Subgraph root = roomWith(std::nullopt).deltaSince(VersionVector{});
  CHECK(root.title == (std::optional<Lww<std::string>>(Lww<std::string>{"Its own register", at(9, "r_old")})));
  CHECK(root.coverage->marks.count("r_old"));
}

// A deletion of an owning step names its subtree, whatever door it comes through: the room tells each door which steps
// a write would take unnamed — a frame by what its join deletes, a graft by its tombstones, a deletion by the steps it
// names — and a write that would land one anyway is a fault, refused with nothing landed and nobody told.
TEST(room_names_the_owning_steps_a_write_would_remove_unconfirmed_and_never_lands_one) {
  FakeBus bus;
  LooseGraph graph;
  graph.createNode(nid("sail"), "Sail", "", NodeColor::sky, at(1));
  graph.createNode(nid("plain"), "Plain", "", NodeColor::sky, at(1));
  TreeRoom room(tid(), {"Title", {}}, {}, false, graph, Legend{}, 0, tid(), {}, {{nid("sail"), tid("t_s")}},
                std::make_shared<RootAccess>(uid("owner"), Visibility::private_), 0, bus);

  Subgraph frame;
  frame.frameId = "f1";
  frame.graph.nodes.push_back(NodeStateEntry{.id = nid("sail"), .deletedAt = at(5, "web")});
  frame.graph.nodes.push_back(NodeStateEntry{.id = nid("plain"), .deletedAt = at(5, "web")});
  CHECK(room.unconfirmedBranches(frame) == (std::vector<UnconfirmedBranch>{{nid("sail"), tid("t_s")}}));
  Graft graft;
  graft.tombstones = {nid("sail")};
  CHECK(room.unconfirmedBranches(graft) == (std::vector<UnconfirmedBranch>{{nid("sail"), tid("t_s")}}));
  CHECK(room.unconfirmedBranches({nid("sail"), nid("plain")}, {}) ==
        (std::vector<UnconfirmedBranch>{{nid("sail"), tid("t_s")}}));

  const auto aFault = [](const auto& write) {
    try {
      write();
    } catch (const std::logic_error&) {
      return true;
    }
    return false;
  };
  CHECK(aFault([&] { room.joinSubgraph(frame, uid("owner")); }));
  CHECK(aFault([&] { room.importTree(graft, 10, uid("owner")); }));
  CHECK(aFault([&] { room.applyCommands({DeleteNode{nid("sail")}}, 10, uid("owner")); }));
  CHECK(room.hasNode(nid("sail")));
  CHECK(room.hasNode(nid("plain")));
  CHECK_EQ(room.head(), Seq{0});
  CHECK(bus.subgraphBroadcasts.empty());

  frame.branches = {tid("t_s")};
  graft.branches = {tid("t_s")};
  CHECK(room.unconfirmedBranches(frame).empty());
  CHECK(room.unconfirmedBranches(graft).empty());
  CHECK(room.joinSubgraph(frame, uid("owner")) == std::optional<Seq>(1));
  CHECK_FALSE(room.hasNode(nid("sail")));
  CHECK(bus.subgraphBroadcasts.back().subgraph.branches.empty());  // a confirmation, never sent on
}

// Every write records the room's owning steps in the root's access before it is told, so the access answers a deleted
// step's branch as absent before any subscriber hears of the delete, and a revive's as standing; each change is told
// once.
TEST(room_records_its_owning_steps_in_the_roots_access_before_the_write_is_told) {
  FakeBus bus;
  LooseGraph graph;
  graph.createNode(nid("sail"), "Sail", "", NodeColor::sky, at(1));
  std::vector<OwningStep> moved;
  const auto access = std::make_shared<RootAccess>(uid("owner"), Visibility::private_, std::set<OwningStep>{},
                                                   [&moved](const OwningStep& step) { moved.push_back(step); });
  TreeRoom room(tid(), {"Title", {}}, {}, false, graph, Legend{}, 0, tid(), {}, {{nid("sail"), tid("t_s")}}, access, 0,
                bus);
  const std::vector<OwningStep> below{OwningStep{tid(), nid("sail")}};
  CHECK(access->admits(below));

  room.applyCommands({DeleteNode{nid("sail")}}, 10, uid("owner"), {tid("t_s")});
  CHECK_FALSE(access->admits(below));
  CHECK(access->admits({}));
  room.applyCommand(RenameNode{nid("sail"), "Still gone"}, 11, uid("owner"));
  room.applyCommand(CreateNode{nid("sail"), "Sail", "", NodeColor::sky}, 12, uid("owner"));
  CHECK(access->admits(below));
  CHECK(moved == (std::vector<OwningStep>{OwningStep{tid(), nid("sail")}, OwningStep{tid(), nid("sail")}}));

  access->setStanding(false);
  CHECK_FALSE(access->admits({}));
}

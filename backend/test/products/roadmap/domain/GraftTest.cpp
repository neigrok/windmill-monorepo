#include "products/roadmap/domain/Command.h"
#include "products/roadmap/domain/Graft.h"
#include "test/testing.h"

#include <set>
#include <string>
#include <vector>

using namespace wm;

namespace {

NodeId nid(const char* s) { return NodeId{std::string(s)}; }
Hlc at(std::uint64_t ms) { return Hlc{ms, 0, "a"}; }

// a -> n, c -> n, n -> d; b stands alone.
LooseGraph seeded() {
  LooseGraph g;
  for (const char* id : {"a", "b", "c", "n", "d"})
    g.createNode(nid(id), id, "", NodeColor::sky, std::nullopt, at(1));
  g.addEdge(nid("a"), nid("n"), at(1));
  g.addEdge(nid("c"), nid("n"), at(1));
  g.addEdge(nid("n"), nid("d"), at(1));
  return g;
}

NodeSpec spec(const char* id, std::vector<const char*> prerequisites) {
  NodeSpec s;
  s.id = nid(id);
  s.label = id;
  for (const char* p : prerequisites) s.prerequisites.push_back(nid(p));
  return s;
}

// What a batch item that carried only `sent` leaves out.
std::set<NodeRegister> omittedAllBut(const std::set<NodeRegister>& sent) {
  std::set<NodeRegister> omitted;
  for (NodeRegister reg : {NodeRegister::label, NodeRegister::icon, NodeRegister::color, NodeRegister::order,
                           NodeRegister::position, NodeRegister::status, NodeRegister::description,
                           NodeRegister::links, NodeRegister::opens})
    if (!sent.count(reg)) omitted.insert(reg);
  return omitted;
}

}

TEST(graft_merge_keeps_the_edge_the_document_left_out_and_names_it) {
  LooseGraph g = seeded();
  Graft graft;
  graft.document.nodes = {spec("n", {"a", "b"})};

  const GraftFootprint footprint = footprintOf(g, graft);
  CHECK_EQ(footprint.keptEdges, (std::vector<Edge>{{nid("c"), nid("n")}}));
  CHECK(footprint.replacedEdges.empty());
  CHECK(footprint.tombstonedNodes.empty());
  CHECK(footprint.tombstonedEdges.empty());

  g.join(graftState(g, graft, at(2)));
  CHECK_EQ(g.nodeView(nid("n"))->prerequisites, (std::vector<NodeId>{nid("a"), nid("b"), nid("c")}));
  CHECK(g.edgePresent(nid("n"), nid("d")));  // an outgoing edge is never one of n's prerequisites
}

TEST(graft_replace_removes_the_unnamed_edge_and_a_later_merge_re_add_wins) {
  LooseGraph g = seeded();
  Graft graft;
  graft.document.nodes = {spec("n", {"a", "b"})};
  graft.prerequisites = PrerequisiteMode::replace;

  const GraftFootprint footprint = footprintOf(g, graft);
  CHECK(footprint.keptEdges.empty());
  CHECK_EQ(footprint.replacedEdges, (std::vector<Edge>{{nid("c"), nid("n")}}));

  g.join(graftState(g, graft, at(2)));
  CHECK_FALSE(g.edgePresent(nid("c"), nid("n")));
  CHECK_EQ(g.nodeView(nid("n"))->prerequisites, (std::vector<NodeId>{nid("a"), nid("b")}));
  CHECK(g.edgePresent(nid("n"), nid("d")));
  CHECK_EQ(g.lifeOf(Edge{nid("c"), nid("n")})->removedAt, at(2));

  Graft again;
  again.document.nodes = {spec("n", {"c"})};
  g.join(graftState(g, again, at(3)));
  CHECK_EQ(g.nodeView(nid("n"))->prerequisites, (std::vector<NodeId>{nid("a"), nid("b"), nid("c")}));
}

TEST(graft_treats_a_tombstoned_id_as_re_sent_so_the_edges_a_delete_left_behind_are_named_or_replaced) {
  LooseGraph g = seeded();
  g.deleteNode(nid("n"), at(2));  // no prune: a->n, c->n, n->d stay present, dangling
  CHECK_FALSE(g.hasNode(nid("n")));
  CHECK(g.isTombstoned(nid("n")));

  Graft merge;
  merge.document.nodes = {spec("n", {"b"})};
  const GraftFootprint kept = footprintOf(g, merge);
  CHECK_EQ(kept.keptEdges, (std::vector<Edge>{{nid("a"), nid("n")}, {nid("c"), nid("n")}}));
  CHECK(kept.replacedEdges.empty());

  Graft replace = merge;
  replace.prerequisites = PrerequisiteMode::replace;
  const GraftFootprint replaced = footprintOf(g, replace);
  CHECK(replaced.keptEdges.empty());
  CHECK_EQ(replaced.replacedEdges, (std::vector<Edge>{{nid("a"), nid("n")}, {nid("c"), nid("n")}}));

  g.join(graftState(g, replace, at(3)));
  CHECK(g.hasNode(nid("n")));
  CHECK_EQ(g.nodeView(nid("n"))->prerequisites, (std::vector<NodeId>{nid("b")}));
  CHECK(g.edgePresent(nid("n"), nid("d")));  // an outgoing edge revives with the node either way
}

// Under replace, a node the document sends without prerequisites keeps every edge into it, and one re-sent as the
// tree holds it lands nothing; an empty list is a list, and clears them.
TEST(graft_replace_keeps_the_edges_of_a_node_sent_without_prerequisites) {
  LooseGraph g = seeded();
  Graft unsent;
  unsent.document.nodes = {spec("n", {})};
  unsent.omittedNodeRegisters[nid("n")] = omittedAllBut({NodeRegister::label});
  unsent.omittedPrerequisites = {nid("n")};
  unsent.prerequisites = PrerequisiteMode::replace;

  const GraftFootprint kept = footprintOf(g, unsent);
  CHECK_EQ(kept.keptEdges, (std::vector<Edge>{{nid("a"), nid("n")}, {nid("c"), nid("n")}}));
  CHECK(kept.replacedEdges.empty());
  CHECK(graftFrame(g, Legend{}, unsent, at(2)).landsNothing());

  unsent.document.nodes[0].label = "renamed";
  g.join(graftState(g, unsent, at(2)));
  CHECK_EQ(g.nodeView(nid("n"))->label, std::string("renamed"));
  CHECK_EQ(g.nodeView(nid("n"))->prerequisites, (std::vector<NodeId>{nid("a"), nid("c")}));

  Graft cleared = unsent;
  cleared.omittedPrerequisites.clear();
  const GraftFootprint dropped = footprintOf(g, cleared);
  CHECK(dropped.keptEdges.empty());
  CHECK_EQ(dropped.replacedEdges, (std::vector<Edge>{{nid("a"), nid("n")}, {nid("c"), nid("n")}}));
  g.join(graftState(g, cleared, at(3)));
  CHECK(g.nodeView(nid("n"))->prerequisites.empty());
}

// A deleted node re-sent under replace without prerequisites comes back with the edges it had, as under merge.
TEST(graft_replace_revives_a_node_sent_without_prerequisites_with_its_edges) {
  LooseGraph g = seeded();
  g.deleteNode(nid("n"), at(2));
  Graft revive;
  revive.document.nodes = {spec("n", {})};
  revive.omittedNodeRegisters[nid("n")] = omittedAllBut({});
  revive.omittedPrerequisites = {nid("n")};
  revive.prerequisites = PrerequisiteMode::replace;

  const GraftFootprint footprint = footprintOf(g, revive);
  CHECK_EQ(footprint.keptEdges, (std::vector<Edge>{{nid("a"), nid("n")}, {nid("c"), nid("n")}}));
  CHECK(footprint.replacedEdges.empty());
  g.join(graftState(g, revive, at(3)));
  CHECK(g.hasNode(nid("n")));
  CHECK_EQ(g.nodeView(nid("n"))->prerequisites, (std::vector<NodeId>{nid("a"), nid("c")}));
}

// A graft that re-hues a held kind repaints the present nodes wearing its old hue, judged against the legend and graph
// as they stood before the batch, so a swap swaps; a node the document colours itself, or tombstones, is left to it.
TEST(graft_frame_repaints_the_nodes_a_rehued_kind_wore) {
  LooseGraph g;
  for (const auto& [id, color] : std::vector<std::pair<const char*, NodeColor>>{
           {"a", NodeColor::sky}, {"b", NodeColor::plum}, {"c", NodeColor::sky}, {"d", NodeColor::sky}})
    g.createNode(nid(id), id, "", color, std::nullopt, at(1));
  const Legend legend({{KindId{"apps"}, NodeColor::sky, "Apps"}, {KindId{"infra"}, NodeColor::plum, "Infra"}}, at(1));
  Graft graft;
  graft.document.kinds = {{KindId{"apps"}, NodeColor::plum}, {KindId{"infra"}, NodeColor::sky}};
  for (const char* kind : {"apps", "infra"})
    graft.omittedKindRegisters[KindId{kind}] = {KindRegister::label, KindRegister::description,
                                                KindRegister::crossBranchExempt};
  graft.document.nodes = {spec("c", {})};
  graft.document.nodes[0].color = NodeColor::gold;
  graft.omittedNodeRegisters[nid("c")] = omittedAllBut({NodeRegister::color});
  graft.tombstones = {nid("d")};

  g.join(graftFrame(g, legend, graft, at(2)).graph);
  CHECK(g.nodeView(nid("a"))->color == NodeColor::plum);
  CHECK(g.nodeView(nid("b"))->color == NodeColor::sky);
  CHECK(g.nodeView(nid("c"))->color == NodeColor::gold);
  CHECK_FALSE(g.hasNode(nid("d")));
  CHECK(g.exportNode(nid("d"))->color == NodeColor::sky);
}

// A node the batch files by kind is the batch's word, even when the hue that kind wears after the batch is the one the
// node holds: a swap leaves it on that hue under the other kind and repaints only the other wearers.
TEST(graft_frame_leaves_a_node_filed_by_kind_to_the_batch_beside_a_swap) {
  LooseGraph g;
  for (const auto& [id, color] : std::vector<std::pair<const char*, NodeColor>>{
           {"a", NodeColor::sky}, {"b", NodeColor::sky}, {"c", NodeColor::plum}})
    g.createNode(nid(id), id, "", color, std::nullopt, at(1));
  const Legend legend({{KindId{"apps"}, NodeColor::sky, "Apps"}, {KindId{"infra"}, NodeColor::plum, "Infra"}}, at(1));
  Graft graft;
  graft.document.kinds = {{KindId{"apps"}, NodeColor::plum}, {KindId{"infra"}, NodeColor::sky}};
  for (const char* kind : {"apps", "infra"})
    graft.omittedKindRegisters[KindId{kind}] = {KindRegister::label, KindRegister::description,
                                                KindRegister::crossBranchExempt};
  graft.document.nodes = {spec("a", {})};
  graft.omittedNodeRegisters[nid("a")] = omittedAllBut({});
  graft.nodeKinds = {{nid("a"), KindId{"infra"}}};

  const std::variant<Graft, KindRefusal> filed = resolveKinds(legend, graft);
  REQUIRE(std::holds_alternative<Graft>(filed));
  const Repaint repaint = repaintOf(g, legend, std::get<Graft>(filed));
  CHECK((repaint.rehued == std::vector<KindId>{KindId{"apps"}, KindId{"infra"}}));
  CHECK((repaint.nodes == std::map<NodeId, NodeColor>{{nid("b"), NodeColor::plum}, {nid("c"), NodeColor::sky}}));
  g.join(graftFrame(g, legend, std::get<Graft>(filed), at(2)).graph);
  CHECK(g.nodeView(nid("a"))->color == NodeColor::sky);
  CHECK(g.nodeView(nid("b"))->color == NodeColor::plum);
  CHECK(g.nodeView(nid("c"))->color == NodeColor::sky);
}

TEST(graft_replace_leaves_new_nodes_and_nodes_not_in_the_batch_alone) {
  LooseGraph g = seeded();
  Graft graft;
  graft.document.nodes = {spec("x", {"a"})};
  graft.prerequisites = PrerequisiteMode::replace;

  const GraftFootprint footprint = footprintOf(g, graft);
  CHECK(footprint.keptEdges.empty());
  CHECK(footprint.replacedEdges.empty());

  g.join(graftState(g, graft, at(2)));
  CHECK_EQ(g.nodeView(nid("n"))->prerequisites, (std::vector<NodeId>{nid("a"), nid("c")}));
  CHECK_EQ(g.nodeView(nid("x"))->prerequisites, (std::vector<NodeId>{nid("a")}));
}

TEST(graft_tombstone_removes_the_node_and_every_edge_touching_it_at_the_one_stamp) {
  LooseGraph g = seeded();
  Graft graft;
  graft.document.nodes = {spec("b", {"a"})};
  graft.tombstones = {nid("n"), nid("n"), nid("ghost")};  // a repeat and a stranger count for nothing

  const GraftFootprint footprint = footprintOf(g, graft);
  CHECK_EQ(footprint.tombstonedNodes, (std::vector<NodeId>{nid("n")}));
  CHECK_EQ(footprint.tombstonedEdges,
           (std::vector<Edge>{{nid("a"), nid("n")}, {nid("c"), nid("n")}, {nid("n"), nid("d")}}));
  CHECK(footprint.keptEdges.empty());

  const GraphState frame = graftState(g, graft, at(2));
  for (const EdgeStateEntry& edge : frame.edges)
    if (edge.removedAt.isSet()) CHECK_EQ(edge.removedAt, at(2));

  g.join(frame);
  CHECK_FALSE(g.hasNode(nid("n")));
  CHECK(g.isTombstoned(nid("n")));
  CHECK_FALSE(g.hasNode(nid("ghost")));
  CHECK_FALSE(g.edgePresent(nid("a"), nid("n")));
  CHECK_FALSE(g.edgePresent(nid("c"), nid("n")));
  CHECK_FALSE(g.edgePresent(nid("n"), nid("d")));
  CHECK(g.edgePresent(nid("a"), nid("b")));
  CHECK(g.hasNode(nid("d")));
  CHECK(g.danglingEdges().empty());
}

TEST(graft_state_never_adds_an_edge_onto_a_node_it_tombstones) {
  LooseGraph g = seeded();
  Graft graft;
  graft.document.nodes = {spec("x", {"n"})};
  graft.tombstones = {nid("n")};

  g.join(graftState(g, graft, at(2)));
  CHECK(g.hasNode(nid("x")));
  CHECK_FALSE(g.edgePresent(nid("n"), nid("x")));
  CHECK(g.danglingEdges().empty());
}

TEST(graft_admission_is_judged_on_what_the_graft_leaves_behind) {
  LooseGraph g;
  for (std::size_t i = 0; i < kMaxNodes; ++i)
    g.createNode(NodeId{"n" + std::to_string(i)}, "N", "", NodeColor::sky, std::nullopt, at(1));

  Graft grows;
  grows.document.nodes = {spec("extra", {})};
  const std::optional<Admission> refused = admit(g, grows);
  REQUIRE(refused.has_value());
  CHECK_EQ(refused->reason, std::string("this tree would hold 10001 nodes, max 10000 — split it across "
                                        "roadmaps, or delete what it has outgrown"));

  Graft swaps = grows;
  swaps.tombstones = {nid("n0")};
  CHECK_FALSE(admit(g, swaps).has_value());
}

// A node the graph holds keeps its creation stamp when a batch re-sends it, so it keeps its place among
// siblings ordered by creation. The frame carries only what the batch changes: an echoed label and a
// held edge add nothing, the new edge lands at the graft's stamp.
TEST(graft_state_keeps_a_held_nodes_creation_stamp_and_carries_only_what_the_batch_changes) {
  LooseGraph g;
  g.createNode(nid("root"), "Root", "", NodeColor::sky, std::nullopt, at(1000));
  g.createNode(nid("x"), "X", "", NodeColor::sky, std::nullopt, at(1000));
  g.createNode(nid("a"), "A", "", NodeColor::sky, std::nullopt, at(1001));
  g.createNode(nid("b"), "B", "", NodeColor::sky, std::nullopt, at(1002));
  g.addEdge(nid("root"), nid("a"), at(1001));
  g.addEdge(nid("root"), nid("b"), at(1002));
  const NodeStateEntry held = *g.exportNode(nid("a"));

  NodeSpec resent = spec("a", {"root", "x"});
  resent.label = "A";
  Graft graft;
  graft.document.nodes = {resent};
  graft.omittedNodeRegisters[nid("a")] = omittedAllBut({NodeRegister::label});

  const GraphState frame = graftState(g, graft, at(1003));
  CHECK(frame == (GraphState{{}, {EdgeStateEntry{{nid("x"), nid("a")}, at(1003), {}}}}));

  g.join(frame);
  CHECK(*g.exportNode(nid("a")) == held);
  CHECK_EQ(g.nodeView(nid("a"))->prerequisites, (std::vector<NodeId>{nid("root"), nid("x")}));
}

// An import asserts nothing about a node it re-sends: a delete stamped before the import and joined after
// it still removes the node, as it would after a rename. What the import changed stays on the record the
// delete leaves and the edge it added dangles, so a later revival brings both back.
TEST(graft_state_loses_a_re_sent_node_to_a_delete_stamped_before_it_and_joined_after_it) {
  LooseGraph g;
  for (const char* id : {"root", "x", "a"}) g.createNode(nid(id), id, "", NodeColor::sky, std::nullopt, at(1));
  g.addEdge(nid("root"), nid("a"), at(1));

  NodeSpec renamed = spec("a", {"x"});
  renamed.label = "A2";
  Graft graft;
  graft.document.nodes = {renamed};
  graft.omittedNodeRegisters[nid("a")] = omittedAllBut({NodeRegister::label});
  g.join(graftState(g, graft, at(3)));
  g.join(GraphState{{NodeStateEntry{.id = nid("a"), .deletedAt = at(2)}}, {}});

  CHECK_FALSE(g.hasNode(nid("a")));
  CHECK(*g.exportNode(nid("a")) == (NodeStateEntry{.id = nid("a"), .createdAt = at(1), .deletedAt = at(2),
                                                  .label = "A2", .labelAt = at(3), .iconAt = at(1),
                                                  .color = NodeColor::sky, .colorAt = at(1)}));
  CHECK_EQ(g.danglingEdges(), (std::vector<Edge>{{nid("root"), nid("a")}, {nid("x"), nid("a")}}));

  Graft revive;
  revive.document.nodes = {spec("a", {})};
  revive.omittedNodeRegisters[nid("a")] = omittedAllBut({});
  g.join(graftState(g, revive, at(4)));
  CHECK(*g.exportNode(nid("a")) == (NodeStateEntry{.id = nid("a"), .createdAt = at(4), .deletedAt = at(2),
                                                  .label = "A2", .labelAt = at(3), .iconAt = at(1),
                                                  .color = NodeColor::sky, .colorAt = at(1)}));
  CHECK_EQ(g.nodeView(nid("a"))->prerequisites, (std::vector<NodeId>{nid("root"), nid("x")}));
  CHECK(g.danglingEdges().empty());
}

// One batch, three kinds of id: a new node is created at the graft's stamp with what it carries, a
// deleted one re-sent is revived at it, and a present one changes only in what it changes.
// The tree a node opens lands by the same rule as every register: sent as the node holds it, the batch
// writes nothing; changed alone, the frame carries that register alone.
TEST(graft_state_lands_the_tree_a_node_opens_only_where_the_batch_changes_it) {
  LooseGraph g;
  g.createNode(nid("n"), "N", "", NodeColor::sky, std::nullopt, at(1));
  g.setOpens(nid("n"), TreeId{"t_sub"}, at(1));

  NodeSpec resent = spec("n", {});
  resent.opens = TreeId{"t_sub"};
  Graft echo;
  echo.document.nodes = {resent};
  echo.omittedNodeRegisters[nid("n")] = omittedAllBut({NodeRegister::opens});
  CHECK(graftState(g, echo, at(2)) == GraphState{});

  resent.opens = TreeId{"t_two"};
  Graft moved;
  moved.document.nodes = {resent};
  moved.omittedNodeRegisters[nid("n")] = omittedAllBut({NodeRegister::opens});
  CHECK(graftState(g, moved, at(3)) ==
        (GraphState{{NodeStateEntry{.id = nid("n"), .opens = TreeId{"t_two"}, .opensAt = at(3)}}, {}}));
}

TEST(graft_state_creates_a_new_node_revives_a_deleted_one_and_edits_a_present_one) {
  LooseGraph g;
  for (const char* id : {"root", "gone"}) g.createNode(nid(id), id, "", NodeColor::sky, std::nullopt, at(1));
  g.deleteNode(nid("gone"), at(2));

  NodeSpec fresh = spec("fresh", {"root"});
  fresh.label = "Fresh";
  NodeSpec root = spec("root", {});
  root.label = "Root";
  Graft graft;
  graft.document.nodes = {fresh, spec("gone", {}), root};
  graft.omittedNodeRegisters[nid("fresh")] = omittedAllBut({NodeRegister::label});
  graft.omittedNodeRegisters[nid("gone")] = omittedAllBut({});
  graft.omittedNodeRegisters[nid("root")] = omittedAllBut({NodeRegister::label});

  CHECK(graftState(g, graft, at(3)) ==
        (GraphState{{NodeStateEntry{.id = nid("fresh"), .createdAt = at(3), .label = "Fresh", .labelAt = at(3)},
                     NodeStateEntry{.id = nid("gone"), .createdAt = at(3)},
                     NodeStateEntry{.id = nid("root"), .label = "Root", .labelAt = at(3)}},
                    {EdgeStateEntry{{nid("root"), nid("fresh")}, at(3), {}}}}));
}

// A register the document leaves off a node is stamped unset, so the join keeps what the graph holds;
// a register it carries lands at the graft's stamp, an empty one included.
TEST(graft_state_leaves_an_omitted_node_register_alone_and_lands_a_carried_one_even_empty) {
  LooseGraph g;
  g.createNode(nid("n"), "N", "star", NodeColor::sky, Vec2{1, 2}, at(1), "complete");
  g.setOrder(nid("n"), "a0", at(1));
  g.setDescription(nid("n"), "Read it", at(1));
  g.setLinks(nid("n"), {Link{"home", "https://windmill.works"}}, at(1));
  g.setOpens(nid("n"), TreeId{"t_sub"}, at(1));

  NodeSpec carried;
  carried.id = nid("n");
  carried.color = NodeColor::plum;
  Graft graft;
  graft.document.nodes = {carried};
  graft.omittedNodeRegisters[nid("n")] =
      omittedAllBut({NodeRegister::icon, NodeRegister::color, NodeRegister::description});

  const GraphState frame = graftState(g, graft, at(2));
  CHECK(frame == (GraphState{{NodeStateEntry{.id = nid("n"), .iconAt = at(2), .color = NodeColor::plum,
                                             .colorAt = at(2), .descriptionAt = at(2)}},
                             {}}));

  g.join(frame);
  CHECK(*g.exportNode(nid("n")) ==
        (NodeStateEntry{.id = nid("n"), .createdAt = at(1), .label = "N", .labelAt = at(1), .iconAt = at(2),
                        .color = NodeColor::plum, .colorAt = at(2), .order = "a0", .orderAt = at(1),
                        .position = Vec2{1, 2}, .positionAt = at(1), .status = "complete", .statusAt = at(1),
                        .descriptionAt = at(2), .links = {Link{"home", "https://windmill.works"}},
                        .linksAt = at(1), .opens = TreeId{"t_sub"}, .opensAt = at(1)}));
}

// The tree a node opens is a register like the rest: a document that names one sets it, one that
// carries it empty clears it, and one that leaves it out keeps it.
TEST(graft_state_sets_clears_and_leaves_the_tree_a_node_opens) {
  LooseGraph g;
  g.createNode(nid("n"), "N", "", NodeColor::sky, std::nullopt, at(1));
  const std::set<NodeRegister> allButOpens = {NodeRegister::label,    NodeRegister::icon,   NodeRegister::color,
                                              NodeRegister::order,    NodeRegister::position, NodeRegister::status,
                                              NodeRegister::description, NodeRegister::links};
  std::set<NodeRegister> everyRegister = allButOpens;
  everyRegister.insert(NodeRegister::opens);

  NodeSpec pointed;
  pointed.id = nid("n");
  pointed.opens = TreeId{"t_sub"};
  Graft sets;
  sets.document.nodes = {pointed};
  sets.omittedNodeRegisters[nid("n")] = allButOpens;
  const GraphState setFrame = graftState(g, sets, at(2));
  CHECK(setFrame == (GraphState{{NodeStateEntry{.id = nid("n"), .opens = TreeId{"t_sub"}, .opensAt = at(2)}}, {}}));
  g.join(setFrame);
  CHECK_EQ(g.nodeView(nid("n"))->opens, TreeId{"t_sub"});

  NodeSpec resent;
  resent.id = nid("n");
  Graft leaves;
  leaves.document.nodes = {resent};
  leaves.omittedNodeRegisters[nid("n")] = everyRegister;
  const GraphState leftFrame = graftState(g, leaves, at(3));
  CHECK(leftFrame == GraphState{});
  g.join(leftFrame);
  CHECK_EQ(g.nodeView(nid("n"))->opens, TreeId{"t_sub"});
  CHECK_EQ(g.exportNode(nid("n"))->opensAt, at(2));

  Graft clears;
  clears.document.nodes = {resent};
  clears.omittedNodeRegisters[nid("n")] = allButOpens;
  g.join(graftState(g, clears, at(4)));
  CHECK_EQ(g.nodeView(nid("n"))->opens, TreeId{});
  CHECK_EQ(g.exportNode(nid("n"))->opensAt, at(4));
}

// A node a delete left keeps its registers, the tree it opened among them. A graft that brings it back and names no
// tree clears that pointer, as create_node does on a reused id, so no batch restores a pointer it does not name; its
// description and links come back as they were, and a present node's omitted pointer stays.
TEST(graft_state_brings_a_deleted_node_back_opening_nothing_unless_the_document_names_a_tree) {
  LooseGraph g;
  for (const char* id : {"gone", "here"}) {
    g.createNode(nid(id), id, "", NodeColor::sky, std::nullopt, at(1));
    g.setDescription(nid(id), "Read it", at(1));
    g.setLinks(nid(id), {Link{"home", "https://windmill.works"}}, at(1));
    g.setOpens(nid(id), TreeId{"t_sub"}, at(1));
  }
  g.deleteNode(nid("gone"), at(2));

  Graft unnamed;
  unnamed.document.nodes = {spec("gone", {}), spec("here", {})};
  unnamed.omittedNodeRegisters[nid("gone")] = omittedAllBut({});
  unnamed.omittedNodeRegisters[nid("here")] = omittedAllBut({});
  const GraphState frame = graftState(g, unnamed, at(3));
  CHECK(frame == (GraphState{{NodeStateEntry{.id = nid("gone"), .createdAt = at(3), .opensAt = at(3)}}, {}}));
  LooseGraph revived = g;
  revived.join(frame);
  NodeStateEntry back = *g.exportNode(nid("gone"));
  back.createdAt = at(3);
  back.opens = TreeId{};
  back.opensAt = at(3);
  CHECK(*revived.exportNode(nid("gone")) == back);
  CHECK(revived.hasNode(nid("gone")));
  CHECK(revived.pointers() == (std::map<NodeId, TreeId>{{nid("here"), TreeId{"t_sub"}}}));

  NodeSpec named = spec("gone", {});
  named.opens = TreeId{"t_two"};
  Graft names;
  names.document.nodes = {named};
  names.omittedNodeRegisters[nid("gone")] = omittedAllBut({NodeRegister::opens});
  CHECK(graftState(g, names, at(3)) ==
        (GraphState{{NodeStateEntry{.id = nid("gone"), .createdAt = at(3), .opens = TreeId{"t_two"}, .opensAt = at(3)}}, {}}));

  NodeSpec same = spec("gone", {});
  same.opens = TreeId{"t_sub"};
  Graft resends;
  resends.document.nodes = {same};
  resends.omittedNodeRegisters[nid("gone")] = omittedAllBut({NodeRegister::opens});
  CHECK(graftState(g, resends, at(3)) == (GraphState{{NodeStateEntry{.id = nid("gone"), .createdAt = at(3)}}, {}}));
}

// A register the document leaves off a kind is stamped unset, so the join keeps what the legend
// holds; a new kind's omitted register lands as its default. Hue always lands.
TEST(graft_legend_leaves_an_omitted_kind_register_alone_and_defaults_it_on_a_new_kind) {
  Legend legend({{KindId{"build"}, NodeColor::terracotta, "Build", "Things you make", true}}, at(1));

  Graft graft;
  graft.document.kinds = {{KindId{"build"}, NodeColor::sky}, {KindId{"read"}, NodeColor::olive}};
  graft.omittedKindRegisters[KindId{"build"}] = {KindRegister::label, KindRegister::description,
                                                 KindRegister::crossBranchExempt};
  graft.omittedKindRegisters[KindId{"read"}] = {KindRegister::label, KindRegister::description,
                                                KindRegister::crossBranchExempt};

  const LegendState frame = graftLegend(legend, graft, at(5));
  REQUIRE_EQ(frame.kinds.size(), 2u);
  for (const KindStateEntry& kind : frame.kinds) {
    CHECK_EQ(kind.hueAt, at(5));
    CHECK_FALSE(kind.labelAt.isSet());
    CHECK_FALSE(kind.descriptionAt.isSet());
    CHECK_FALSE(kind.crossBranchExemptAt.isSet());
  }

  legend.join(frame);
  const Kind build = *legend.view(KindId{"build"});
  CHECK_EQ(build.hue, NodeColor::sky);
  CHECK_EQ(build.label, std::string("Build"));
  CHECK_EQ(build.description, std::string("Things you make"));
  CHECK(build.crossBranchExempt);
  const Kind read = *legend.view(KindId{"read"});
  CHECK_EQ(read.hue, NodeColor::olive);
  CHECK_EQ(read.label, std::string(""));
  CHECK_EQ(read.description, std::string(""));
  CHECK_FALSE(read.crossBranchExempt);

  // A register the document does carry lands at the graft's stamp, an empty string included.
  Graft spelled;
  spelled.document.kinds = {{KindId{"build"}, NodeColor::sky, "Builds", "", false}};
  legend.join(graftLegend(legend, spelled, at(6)));
  const Kind renamed = *legend.view(KindId{"build"});
  CHECK_EQ(renamed.label, std::string("Builds"));
  CHECK_EQ(renamed.description, std::string(""));
  CHECK_FALSE(renamed.crossBranchExempt);
}

// Rank is never on the wire, so a colliding kind keeps its place, and one sent as the legend holds it
// is left out of the frame; new kinds land after the last present one, in document order rather than
// id order — what addKind would do for each in turn.
TEST(graft_legend_keeps_a_colliding_kinds_rank_and_appends_a_new_kind_after_the_last) {
  Legend legend({{KindId{"a"}, NodeColor::terracotta}, {KindId{"b"}, NodeColor::olive}, {KindId{"c"}, NodeColor::gold}},
                at(1));

  Graft graft;
  graft.document.kinds = {{KindId{"c"}, NodeColor::gold}, {KindId{"y"}, NodeColor::plum}, {KindId{"x"}, NodeColor::sky}};
  const LegendState frame = graftLegend(legend, graft, at(5));
  CHECK(frame == (LegendState{{KindStateEntry{.id = KindId{"x"}, .createdAt = at(5), .hue = NodeColor::sky,
                                              .hueAt = at(5), .labelAt = at(5), .descriptionAt = at(5),
                                              .crossBranchExemptAt = at(5), .rank = 4, .rankAt = at(5)},
                               KindStateEntry{.id = KindId{"y"}, .createdAt = at(5), .hue = NodeColor::plum,
                                              .hueAt = at(5), .labelAt = at(5), .descriptionAt = at(5),
                                              .crossBranchExemptAt = at(5), .rank = 3, .rankAt = at(5)}}}));

  legend.join(frame);
  CHECK_EQ(legend.orderedIds(),
           (std::vector<KindId>{KindId{"a"}, KindId{"b"}, KindId{"c"}, KindId{"y"}, KindId{"x"}}));

  // A kind removed earlier is not held, so a re-sent id lands last, like addKind on the same id.
  legend.removeKind(KindId{"a"}, at(6));
  Graft revived;
  revived.document.kinds = {{KindId{"a"}, NodeColor::terracotta}};
  legend.join(graftLegend(legend, revived, at(7)));
  CHECK_EQ(legend.orderedIds(),
           (std::vector<KindId>{KindId{"b"}, KindId{"c"}, KindId{"y"}, KindId{"x"}, KindId{"a"}}));
}

// An import asserts nothing about a kind it re-sends: a remove stamped before the import and joined after
// it still removes the kind. The label the import changed stays on the record the remove leaves.
TEST(graft_legend_loses_a_re_sent_kind_to_a_remove_stamped_before_it_and_joined_after_it) {
  Legend legend({{KindId{"backend"}, NodeColor::sky, "Backend"}}, at(1));
  Graft graft;
  graft.document.kinds = {{KindId{"backend"}, NodeColor::sky, "Backend services"}};
  graft.omittedKindRegisters[KindId{"backend"}] = {KindRegister::description, KindRegister::crossBranchExempt};

  legend.join(graftLegend(legend, graft, at(3)));
  legend.join(LegendState{{KindStateEntry{.id = KindId{"backend"}, .deletedAt = at(2)}}});

  CHECK_FALSE(legend.has(KindId{"backend"}));
  CHECK(*legend.exportKind(KindId{"backend"}) ==
        (KindStateEntry{.id = KindId{"backend"}, .createdAt = at(1), .deletedAt = at(2), .hue = NodeColor::sky,
                        .hueAt = at(1), .label = "Backend services", .labelAt = at(3), .descriptionAt = at(1),
                        .crossBranchExemptAt = at(1), .rank = 0, .rankAt = at(1)}));
}

// A kind sent as the legend holds it, the way a get_tree round trip sends it, lands nothing: the frame
// leaves it out, so an offline rename and recolour stamped before the import and joined after it stand.
TEST(graft_legend_leaves_out_a_kind_sent_as_held_so_a_concurrent_rename_stands) {
  Legend legend({{KindId{"backend"}, NodeColor::sky, "Backend"}}, at(1));
  Graft graft;
  graft.document.kinds = {{KindId{"backend"}, NodeColor::sky, "Backend"}};
  graft.omittedKindRegisters[KindId{"backend"}] = {KindRegister::description, KindRegister::crossBranchExempt};

  const LegendState frame = graftLegend(legend, graft, at(3));
  CHECK(frame == LegendState{});
  legend.join(frame);
  legend.join(LegendState{{KindStateEntry{.id = KindId{"backend"}, .hue = NodeColor::plum, .hueAt = at(2),
                                          .label = "Services", .labelAt = at(2)}}});

  CHECK(*legend.exportKind(KindId{"backend"}) ==
        (KindStateEntry{.id = KindId{"backend"}, .createdAt = at(1), .hue = NodeColor::plum, .hueAt = at(2),
                        .label = "Services", .labelAt = at(2), .descriptionAt = at(1), .crossBranchExemptAt = at(1),
                        .rank = 0, .rankAt = at(1)}));
}

TEST(graft_legend_is_empty_when_the_document_carries_no_kinds) {
  CHECK(graftLegend(Legend{}, Graft{}, at(1)) == LegendState{});
}

// One batch can add a kind and file nodes under it: a node's kind lands as the hue it wears in the legend
// the batch leaves, and the node carries its colour register as if it had sent the hue.
TEST(resolve_kinds_files_nodes_under_the_legend_the_batch_leaves) {
  const Legend legend({{KindId{"build"}, NodeColor::terracotta, "Build"}}, at(1));
  Graft graft;
  graft.document.kinds = {{KindId{"owner"}, NodeColor::gold}, {KindId{"build"}, NodeColor::sky}};
  graft.document.nodes = {spec("a", {}), spec("b", {})};
  graft.omittedNodeRegisters[nid("a")] = omittedAllBut({});
  graft.omittedNodeRegisters[nid("b")] = omittedAllBut({NodeRegister::color});
  graft.document.nodes[1].color = NodeColor::sky;
  graft.nodeKinds = {{nid("a"), KindId{"owner"}}, {nid("b"), KindId{"build"}}};

  const std::variant<Graft, KindRefusal> filed = resolveKinds(legend, graft);
  REQUIRE(std::holds_alternative<Graft>(filed));
  const Graft& landed = std::get<Graft>(filed);
  CHECK_EQ(landed.document.nodes[0].color, NodeColor::gold);
  CHECK_EQ(landed.document.nodes[1].color, NodeColor::sky);
  CHECK(landed.omittedNodeRegisters.at(nid("a")) == omittedAllBut({NodeRegister::color}));
  CHECK(landed.omittedNodeRegisters.at(nid("b")) == omittedAllBut({NodeRegister::color}));
  CHECK(landed.nodeKinds == graft.nodeKinds);

  graft.nodeKinds[nid("b")] = KindId{"ghost"};
  const std::variant<Graft, KindRefusal> refused = resolveKinds(legend, graft);
  REQUIRE(std::holds_alternative<KindRefusal>(refused));
  CHECK((std::get<KindRefusal>(refused) ==
         KindRefusal{KindRefusal::Reason::unknownKind,
                     "nodes[1].kind \"ghost\" is not a kind of this tree; its legend holds \"build\", \"owner\""}));
}

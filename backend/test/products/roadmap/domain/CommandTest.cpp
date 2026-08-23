#include "products/roadmap/domain/Command.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "test/testing.h"

#include <limits>

using namespace wm;

static NodeId nid(const char* s) { return NodeId{std::string(s)}; }
static KindId kid(const char* s) { return KindId{std::string(s)}; }
static Hlc at(std::uint64_t ms, const char* actor = "a") { return Hlc{ms, 0, actor}; }

static LooseGraph seeded() {
  LooseGraph g;
  g.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(1));
  g.createNode(nid("b"), "B", "x", NodeColor::gold, Vec2{3, 4}, at(1));
  g.addEdge(nid("a"), nid("b"), at(2));
  return g;
}

TEST(transitive_reduction_drops_redundant_edge) {
  LooseGraph g;
  Legend legend;
  g.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(1));
  g.createNode(nid("b"), "B", "x", NodeColor::sky, std::nullopt, at(1));
  g.createNode(nid("c"), "C", "x", NodeColor::sky, std::nullopt, at(1));
  g.addEdge(nid("a"), nid("b"), at(2));
  g.addEdge(nid("b"), nid("c"), at(2));
  g.addEdge(nid("a"), nid("c"), at(2));  // redundant: a reaches c through b

  auto redundant = g.redundantEdges();
  REQUIRE_EQ(redundant.size(), 1u);
  CHECK_EQ(redundant[0], (Edge{nid("a"), nid("c")}));

  merge(g, legend, Command{TransitiveReduction{}}, at(5));
  CHECK_FALSE(g.edgePresent(nid("a"), nid("c")));
  CHECK(g.edgePresent(nid("a"), nid("b")));
  CHECK(g.edgePresent(nid("b"), nid("c")));
}

TEST(recolor_kind_swaps_hue_and_repaints_nodes) {
  LooseGraph g;
  g.createNode(nid("a"), "A", "x", NodeColor::olive, std::nullopt, at(1));
  g.createNode(nid("b"), "B", "x", NodeColor::olive, std::nullopt, at(1));
  g.createNode(nid("c"), "C", "x", NodeColor::gold, std::nullopt, at(1));
  Legend legend({{kid("learn"), NodeColor::olive, "Learn", ""}}, at(1));

  merge(g, legend, Command{RecolorKind{kid("learn"), NodeColor::sky}}, at(5));

  CHECK_EQ(legend.hueOf(kid("learn")).value(), NodeColor::sky);
  CHECK_EQ(g.nodeView(nid("a"))->color, NodeColor::sky);   // olive nodes repainted
  CHECK_EQ(g.nodeView(nid("b"))->color, NodeColor::sky);
  CHECK_EQ(g.nodeView(nid("c"))->color, NodeColor::gold);  // gold untouched
}

TEST(validate_passes_graph_commands_always) {
  LooseGraph g = seeded();
  Legend legend;
  CHECK_FALSE(validate(g, legend, Command{RenameNode{nid("b"), "x"}}).has_value());
  CHECK_FALSE(validate(g, legend, Command{DeleteNode{nid("nope")}}).has_value());
  CHECK_FALSE(validate(g, legend, Command{AddEdge{nid("a"), nid("b")}}).has_value());
}

TEST(validate_add_kind_rejects_taken_hue_and_full_legend) {
  LooseGraph g;
  Legend legend = Legend::seededDefaults(at(1));  // terracotta, olive, gold taken
  CHECK(validate(g, legend, Command{AddKind{kid("dupe"), NodeColor::olive}}).has_value());
  CHECK_FALSE(validate(g, legend, Command{AddKind{kid("fresh"), NodeColor::sky}}).has_value());

  legend.addKind(kid("a"), NodeColor::sky, at(2));
  legend.addKind(kid("b"), NodeColor::brick, at(3));
  legend.addKind(kid("c"), NodeColor::plum, at(4));  // now 6 kinds — full
  CHECK(validate(g, legend, Command{AddKind{kid("seventh"), NodeColor::terracotta}}).has_value());
}

TEST(validate_remove_kind_rejects_while_in_use) {
  LooseGraph g;
  g.createNode(nid("n"), "N", "x", NodeColor::olive, std::nullopt, at(1));
  Legend legend = Legend::seededDefaults(at(1));
  CHECK(validate(g, legend, Command{RemoveKind{kid("learn")}}).has_value());       // olive is worn
  CHECK_FALSE(validate(g, legend, Command{RemoveKind{kid("milestone")}}).has_value());  // gold is free
  CHECK(validate(g, legend, Command{RemoveKind{kid("ghost")}}).has_value());       // no such kind
}

TEST(validate_length_caps_and_recolor_hue_uniqueness) {
  LooseGraph g;
  Legend legend = Legend::seededDefaults(at(1));
  CHECK(validate(g, legend, Command{RenameKind{kid("build"), std::string(25, 'x')}}).has_value());
  CHECK_FALSE(validate(g, legend, Command{RenameKind{kid("build"), std::string(24, 'x')}}).has_value());
  CHECK(validate(g, legend, Command{DescribeKind{kid("build"), std::string(81, 'y')}}).has_value());

  CHECK(validate(g, legend, Command{RecolorKind{kid("build"), NodeColor::olive}}).has_value());  // taken
  CHECK_FALSE(validate(g, legend, Command{RecolorKind{kid("build"), NodeColor::sky}}).has_value());  // free
  CHECK_FALSE(validate(g, legend, Command{RecolorKind{kid("build"), NodeColor::terracotta}}).has_value());  // its own hue
}

TEST(validate_rejects_over_long_node_label) {
  LooseGraph g = seeded();
  Legend legend;
  CHECK_EQ(validate(g, legend, Command{RenameNode{nid("a"), std::string(kMaxNodeLabelLength + 1, 'x')}}),
           std::optional<std::string>("label is too long (max 200 characters)"));
  CHECK_FALSE(validate(g, legend, Command{RenameNode{nid("a"), std::string(kMaxNodeLabelLength, 'x')}}).has_value());
}

TEST(validate_rejects_non_finite_reposition) {
  LooseGraph g = seeded();
  Legend legend;
  double inf = std::numeric_limits<double>::infinity();
  double nan = std::numeric_limits<double>::quiet_NaN();
  CHECK_EQ(validate(g, legend, Command{RepositionNode{nid("a"), Vec2{inf, 0}}}),
           std::optional<std::string>("position is not finite"));
  CHECK_EQ(validate(g, legend, Command{RepositionNode{nid("a"), Vec2{0, nan}}}),
           std::optional<std::string>("position is not finite"));
  CHECK_FALSE(validate(g, legend, Command{RepositionNode{nid("a"), Vec2{1.5, -2.5}}}).has_value());
}

TEST(validate_rejects_new_create_at_node_capacity) {
  LooseGraph g;
  Legend legend;
  for (std::size_t i = 0; i < kMaxNodes; ++i) {
    g.createNode(nid(("n" + std::to_string(i)).c_str()), "L", "i", NodeColor::sky, std::nullopt, at(1));
  }
  CHECK_EQ(g.presentNodeIds().size(), kMaxNodes);
  CHECK_EQ(validate(g, legend, Command{CreateNode{nid("overflow"), "L", "i"}}),
           std::optional<std::string>(
               "tree is at node capacity (10000 nodes) — delete a node before adding another"));
  CHECK_FALSE(validate(g, legend, Command{CreateNode{nid("n0"), "L", "i"}}).has_value());  // existing node, not new
}

TEST(validate_admits_normal_create_and_add_edge) {
  LooseGraph g = seeded();
  Legend legend;
  Command create = CreateNode{nid("c"), "C", "icon", NodeColor::sky, {}, Vec2{1.5, -2.5}};
  CHECK_FALSE(validate(g, legend, create).has_value());
  CHECK_FALSE(validate(g, legend, Command{AddEdge{nid("a"), nid("b")}}).has_value());
}

namespace {
NodeStateEntry nodeWrite(const char* id) { NodeStateEntry n; n.id = nid(id); return n; }
KindStateEntry kindWrite(const char* id) { KindStateEntry k; k.id = kid(id); return k; }
}

TEST(headline_create_wins_over_the_parent_edge_it_drags_in) {
  GraphState g;
  NodeStateEntry n = nodeWrite("a");
  n.label = "A"; n.createdAt = at(1); n.color = NodeColor::sky; n.colorAt = at(1);
  g.nodes.push_back(n);
  EdgeStateEntry e; e.edge = Edge{nid("p"), nid("a")}; e.addedAt = at(1);
  g.edges.push_back(e);

  std::optional<Command> deed = headline(g, LegendState{});
  const CreateNode* c = deed ? std::get_if<CreateNode>(&*deed) : nullptr;
  REQUIRE(c != nullptr);
  CHECK_EQ(c->id, nid("a"));
  CHECK_EQ(c->label, std::string("A"));
}

TEST(headline_delete_wins_over_the_spliced_edges) {
  GraphState g;
  NodeStateEntry n = nodeWrite("a");
  n.deletedAt = at(2);
  g.nodes.push_back(n);
  EdgeStateEntry gone; gone.edge = Edge{nid("p"), nid("a")}; gone.removedAt = at(2);
  EdgeStateEntry bypass; bypass.edge = Edge{nid("p"), nid("c")}; bypass.addedAt = at(2);
  g.edges.push_back(gone);
  g.edges.push_back(bypass);

  std::optional<Command> deed = headline(g, LegendState{});
  const DeleteNode* c = deed ? std::get_if<DeleteNode>(&*deed) : nullptr;
  REQUIRE(c != nullptr);
  CHECK_EQ(c->id, nid("a"));
}

TEST(headline_recolor_kind_wins_over_the_node_colors_it_fans_out) {
  GraphState g;
  NodeStateEntry n = nodeWrite("a");
  n.color = NodeColor::sky; n.colorAt = at(3);
  g.nodes.push_back(n);
  LegendState legend;
  KindStateEntry k = kindWrite("learn");
  k.hue = NodeColor::sky; k.hueAt = at(3);
  legend.kinds.push_back(k);

  std::optional<Command> deed = headline(g, legend);
  const RecolorKind* c = deed ? std::get_if<RecolorKind>(&*deed) : nullptr;
  REQUIRE(c != nullptr);
  CHECK_EQ(c->id, kid("learn"));
  CHECK_EQ(c->hue, NodeColor::sky);
}

TEST(headline_reads_rename_relabel_and_edges) {
  GraphState rename;
  NodeStateEntry r = nodeWrite("a"); r.label = "New"; r.labelAt = at(4);
  rename.nodes.push_back(r);
  std::optional<Command> renameDeed = headline(rename, LegendState{});
  const RenameNode* renamed = renameDeed ? std::get_if<RenameNode>(&*renameDeed) : nullptr;
  REQUIRE(renamed != nullptr);
  CHECK_EQ(renamed->label, std::string("New"));

  GraphState link;
  EdgeStateEntry added; added.edge = Edge{nid("a"), nid("b")}; added.addedAt = at(4);
  link.edges.push_back(added);
  std::optional<Command> linkDeed = headline(link, LegendState{});
  const AddEdge* linked = linkDeed ? std::get_if<AddEdge>(&*linkDeed) : nullptr;
  REQUIRE(linked != nullptr);
  CHECK_EQ(linked->from, nid("a"));
  CHECK_EQ(linked->to, nid("b"));

  GraphState unlink;
  EdgeStateEntry removed; removed.edge = Edge{nid("a"), nid("b")}; removed.removedAt = at(4);
  unlink.edges.push_back(removed);
  std::optional<Command> unlinkDeed = headline(unlink, LegendState{});
  REQUIRE(unlinkDeed.has_value());
  CHECK(std::get_if<RemoveEdge>(&*unlinkDeed) != nullptr);
}

TEST(headline_is_empty_for_a_nudge_or_an_empty_frame) {
  GraphState moved;
  NodeStateEntry m = nodeWrite("a"); m.position = Vec2{1, 2}; m.positionAt = at(5);
  moved.nodes.push_back(m);
  CHECK_FALSE(headline(moved, LegendState{}).has_value());  // a reposition is not feed-worthy
  CHECK_FALSE(headline(GraphState{}, LegendState{}).has_value());
}

TEST(create_node_wires_every_prerequisite_and_seeds_annotation) {
  LooseGraph g;
  Legend legend;
  g.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(1));
  g.createNode(nid("b"), "B", "x", NodeColor::sky, std::nullopt, at(1));
  merge(g, legend, Command{CreateNode{nid("c"), "C", "x", NodeColor::sky, {nid("a"), nid("b")},
                                      std::nullopt, "notes", {Link{"Doc", "https://d"}}}}, at(2));

  CHECK(g.edgePresent(nid("a"), nid("c")));
  CHECK(g.edgePresent(nid("b"), nid("c")));
  NodeSpec view = *g.nodeView(nid("c"));
  CHECK_EQ(view.description, std::string("notes"));
  REQUIRE_EQ(view.links.size(), 1u);
  CHECK_EQ(view.links[0], (Link{"Doc", "https://d"}));
}

TEST(annotate_node_sets_only_the_fields_it_carries) {
  LooseGraph g;
  Legend legend;
  g.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(1));
  merge(g, legend, Command{AnnotateNode{nid("a"), std::string("body"), std::nullopt}}, at(2));
  merge(g, legend, Command{AnnotateNode{nid("a"), std::nullopt, std::vector<Link>{Link{"", "u"}}}}, at(3));

  NodeSpec view = *g.nodeView(nid("a"));
  CHECK_EQ(view.description, std::string("body"));  // set at at(2), untouched by the links-only frame
  REQUIRE_EQ(view.links.size(), 1u);
  CHECK_EQ(view.links[0].url, std::string("u"));

  merge(g, legend, Command{AnnotateNode{nid("a"), std::string("newer"), std::nullopt}}, at(4));
  CHECK_EQ(g.nodeView(nid("a"))->description, std::string("newer"));
  CHECK_EQ(g.nodeView(nid("a"))->links.size(), 1u);  // links register untouched
}

TEST(annotate_and_create_bounds_are_enforced) {
  LooseGraph g;
  Legend legend;
  std::vector<Link> tooMany(kMaxNodeLinks + 1, Link{"", "u"});
  CHECK_EQ(validate(g, legend, Command{AnnotateNode{nid("a"), std::nullopt, tooMany}}),
           std::optional<std::string>("too many links (max 32)"));
  CHECK_EQ(validate(g, legend, Command{AnnotateNode{nid("a"), std::string(kMaxNodeDescriptionLength + 1, 'x'),
                                                    std::nullopt}}),
           std::optional<std::string>("description is too long (max 4000 characters)"));
  CHECK_FALSE(validate(g, legend, Command{AnnotateNode{nid("a"), std::string("ok"),
                                                       std::vector<Link>{Link{"L", "u"}}}}).has_value());
}

TEST(add_kind_seeds_label_and_description_inline) {
  LooseGraph g;
  Legend legend;
  merge(g, legend, Command{AddKind{kid("infra"), NodeColor::sky, "Infra", "platform work"}}, at(1));

  Kind kind = *legend.view(kid("infra"));
  CHECK_EQ(kind.hue, NodeColor::sky);
  CHECK_EQ(kind.label, std::string("Infra"));
  CHECK_EQ(kind.description, std::string("platform work"));

  CHECK_EQ(validate(g, legend, Command{AddKind{kid("x"), NodeColor::gold, std::string(25, 'x'), ""}}),
           std::optional<std::string>("label is 25 characters, max 24"));
}

TEST(prune_dangling_drops_self_and_missing_endpoint_edges_only) {
  LooseGraph g;
  Legend legend;
  g.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(1));
  g.createNode(nid("b"), "B", "x", NodeColor::sky, std::nullopt, at(1));
  g.addEdge(nid("a"), nid("b"), at(2));   // live
  g.addEdge(nid("a"), nid("a"), at(2));   // self
  g.addEdge(nid("a"), nid("ghost"), at(2));  // missing endpoint

  std::vector<Edge> dangling = g.danglingEdges();
  CHECK_EQ(dangling.size(), 2u);

  merge(g, legend, Command{PruneDangling{}}, at(3));
  CHECK(g.edgePresent(nid("a"), nid("b")));            // live edge kept
  CHECK_FALSE(g.edgePresent(nid("a"), nid("a")));      // self dropped
  CHECK_FALSE(g.edgePresent(nid("a"), nid("ghost")));  // dangling dropped
}

TEST(headline_reads_an_annotation_frame) {
  GraphState g;
  NodeStateEntry n = nodeWrite("a");
  n.description = "hello"; n.descriptionAt = at(4);
  g.nodes.push_back(n);

  std::optional<Command> deed = headline(g, LegendState{});
  const AnnotateNode* c = deed ? std::get_if<AnnotateNode>(&*deed) : nullptr;
  REQUIRE(c != nullptr);
  REQUIRE(c->description.has_value());
  CHECK_EQ(*c->description, std::string("hello"));
  CHECK_FALSE(c->links.has_value());
}

TEST(admit_refuses_a_document_past_the_node_ceiling) {
  TreeData data;
  data.title = "Too big";
  for (std::size_t i = 0; i <= kMaxNodes; ++i) {
    NodeSpec node;
    node.id = nid(("n" + std::to_string(i)).c_str());
    data.nodes.push_back(std::move(node));
  }

  std::optional<Admission> refusal = admit(data);
  REQUIRE(refusal.has_value());
  CHECK(refusal->verdict == Admission::Verdict::tooLarge);
  CHECK_EQ(refusal->reason,
           std::string("this tree would hold 10001 nodes, max 10000 — split it across roadmaps, "
                       "or delete what it has outgrown"));
}

TEST(admit_names_the_node_whose_field_is_over_its_cap) {
  TreeData data;
  NodeSpec node;
  node.id = nid("hull");
  node.description = std::string(kMaxNodeDescriptionLength + 1, 'x');
  data.nodes.push_back(std::move(node));

  std::optional<Admission> refusal = admit(data);
  REQUIRE(refusal.has_value());
  CHECK(refusal->verdict == Admission::Verdict::malformed);
  CHECK_EQ(refusal->reason, std::string("node \"hull\": description is 4001 characters, max 4000"));
}

// A title is counted in codepoints, exactly as the rename path truncates it.
TEST(admit_counts_a_title_in_codepoints_not_bytes) {
  TreeData wide;
  for (std::size_t i = 0; i < kMaxTitleChars; ++i) wide.title += "学";  // 200 characters, 600 bytes
  CHECK_FALSE(admit(wide).has_value());

  TreeData over = wide;
  over.title += "学";
  std::optional<Admission> refusal = admit(over);
  REQUIRE(refusal.has_value());
  CHECK_EQ(refusal->reason, std::string("the title is 201 characters, max 200"));
}

// A graft is judged on what the tree would HOLD: an id already present is an upsert and costs nothing.
TEST(admit_of_a_graft_counts_the_resulting_tree_not_the_batch) {
  LooseGraph graph;
  TreeData batch;
  for (std::size_t i = 0; i < kMaxNodes; ++i) {
    graph.createNode(nid(("n" + std::to_string(i)).c_str()), "N", "", NodeColor::sky, std::nullopt, at(1));
    NodeSpec node;
    node.id = nid(("n" + std::to_string(i)).c_str());
    batch.nodes.push_back(std::move(node));
  }
  CHECK_FALSE(admit(graph, batch).has_value());  // a full-tree upsert adds nothing

  NodeSpec extra;
  extra.id = nid("one-more");
  batch.nodes.push_back(std::move(extra));
  std::optional<Admission> refusal = admit(graph, batch);
  REQUIRE(refusal.has_value());
  CHECK_EQ(refusal->reason,
           std::string("this tree would hold 10001 nodes, max 10000 — split it across roadmaps, "
                       "or delete what it has outgrown"));
}

// A frame's own tombstone lowers the count it is judged against, so an account at the ceiling can trade a node for a node.
TEST(admit_of_a_frame_lets_a_tombstone_pay_for_a_new_node) {
  LooseGraph graph;
  for (std::size_t i = 0; i < kMaxNodes; ++i)
    graph.createNode(nid(("n" + std::to_string(i)).c_str()), "N", "", NodeColor::sky, std::nullopt, at(1));

  GraphState frame;
  NodeStateEntry born;
  born.id = nid("fresh");
  born.createdAt = at(9);
  frame.nodes.push_back(born);
  std::optional<Admission> refusal = admit(graph, frame);
  REQUIRE(refusal.has_value());
  CHECK(refusal->verdict == Admission::Verdict::tooLarge);

  NodeStateEntry buried;
  buried.id = nid("n0");
  buried.createdAt = at(1);
  buried.deletedAt = at(9);
  frame.nodes.push_back(buried);
  CHECK_FALSE(admit(graph, frame).has_value());
}

TEST(admit_of_a_frame_refuses_a_node_field_over_its_cap) {
  LooseGraph graph;
  GraphState frame;
  NodeStateEntry entry;
  entry.id = nid("hull");
  entry.createdAt = at(1);
  entry.label = std::string(kMaxNodeLabelLength + 1, 'x');
  frame.nodes.push_back(std::move(entry));

  std::optional<Admission> refusal = admit(graph, frame);
  REQUIRE(refusal.has_value());
  CHECK(refusal->verdict == Admission::Verdict::malformed);
  CHECK_EQ(refusal->reason, std::string("node \"hull\": label is 201 characters, max 200"));
}

TEST(admit_refuses_an_oversized_id_without_quoting_it_back) {
  TreeData data;
  NodeSpec node;
  node.id = nid(std::string(20000, 'x').c_str());
  data.nodes.push_back(std::move(node));

  std::optional<Admission> refusal = admit(data);
  REQUIRE(refusal.has_value());
  CHECK_EQ(refusal->reason, std::string("a node id is 20000 characters, max 128"));
}

// A ceiling refuses growth, not size: trees already past the caps must stay renameable and thinnable.
TEST(admit_still_lets_an_over_cap_tree_be_edited_and_thinned) {
  LooseGraph graph;
  for (std::size_t i = 0; i <= kMaxNodes; ++i)  // 10001 present nodes: already past the ceiling
    graph.createNode(nid(("n" + std::to_string(i)).c_str()), "N", "", NodeColor::sky, std::nullopt, at(1));

  GraphState rename;
  NodeStateEntry renamed;
  renamed.id = nid("n0");
  renamed.createdAt = at(1);
  renamed.label = "Renamed";
  renamed.labelAt = at(9);
  rename.nodes.push_back(renamed);
  CHECK_FALSE(admit(graph, rename).has_value());  // adds nothing: still admissible

  GraphState grow;
  NodeStateEntry born;
  born.id = nid("one-more");
  born.createdAt = at(9);
  grow.nodes.push_back(born);
  REQUIRE(admit(graph, grow).has_value());  // one more node is growth, and growth is refused
  CHECK_EQ(admit(graph, grow)->reason,
           std::string("this tree would hold 10002 nodes, max 10000 — split it across roadmaps, "
                       "or delete what it has outgrown"));
}

// The join is PERFORMED, not estimated: a frame entry whose deletedAt beats its own createdAt still loses to the stamp the graph holds, so it lowers nothing.
TEST(admit_does_not_let_a_losing_tombstone_buy_headroom) {
  LooseGraph graph;
  for (std::size_t i = 0; i < kMaxNodes; ++i)
    graph.createNode(nid(("n" + std::to_string(i)).c_str()), "N", "", NodeColor::sky, std::nullopt,
                     Hlc{1, 0, "genesis"});

  GraphState frame;
  NodeStateEntry forged;
  forged.id = nid("n0");
  forged.createdAt = Hlc{1, 0, "A"};
  forged.deletedAt = Hlc{1, 0, "a"};
  frame.nodes.push_back(forged);
  NodeStateEntry born;
  born.id = nid("fresh");
  born.createdAt = Hlc{9, 0, "client"};
  frame.nodes.push_back(born);

  std::optional<Admission> refusal = admit(graph, frame);
  REQUIRE(refusal.has_value());
  CHECK(refusal->verdict == Admission::Verdict::tooLarge);
  CHECK_EQ(refusal->reason,
           std::string("this tree would hold 10001 nodes, max 10000 — split it across roadmaps, "
                       "or delete what it has outgrown"));
}

// One key moves the count by at most one, however many times the frame names it.
TEST(admit_counts_a_repeated_id_once_however_often_a_frame_names_it) {
  LooseGraph graph;
  for (std::size_t i = 0; i < kMaxNodes; ++i)
    graph.createNode(nid(("n" + std::to_string(i)).c_str()), "N", "", NodeColor::sky, std::nullopt, at(1));

  GraphState frame;
  for (int repeat = 0; repeat < 500; ++repeat) {  // the same real deletion, 500 times over
    NodeStateEntry buried;
    buried.id = nid("n0");
    buried.createdAt = at(1);
    buried.deletedAt = at(9);
    frame.nodes.push_back(buried);
  }
  for (int i = 0; i < 2; ++i) {  // one node paid for by the deletion, one over the top
    NodeStateEntry born;
    born.id = nid(("fresh" + std::to_string(i)).c_str());
    born.createdAt = at(9);
    frame.nodes.push_back(born);
  }

  std::optional<Admission> refusal = admit(graph, frame);
  REQUIRE(refusal.has_value());
  CHECK_EQ(refusal->reason,
           std::string("this tree would hold 10001 nodes, max 10000 — split it across roadmaps, "
                       "or delete what it has outgrown"));
}

// An edge is one edge however often the batch asks for it.
TEST(admit_counts_a_repeated_prerequisite_once) {
  LooseGraph graph;
  TreeData batch;
  NodeSpec hub;
  hub.id = nid("hub");
  batch.nodes.push_back(hub);
  NodeSpec child;
  child.id = nid("child");
  for (std::size_t i = 0; i <= kMaxEdges + 10000; ++i) child.prerequisites.push_back(nid("hub"));
  batch.nodes.push_back(child);

  CHECK_FALSE(admit(graph, batch).has_value());  // 30001 prerequisites, one edge
}

// The legend rides the same frame the graph does, under the same growth rule.
TEST(admit_bounds_the_legend_a_frame_would_leave_behind) {
  Legend legend = Legend::seededDefaults(at(1));
  LegendState arriving;
  for (int i = 0; i < 200; ++i) {
    KindStateEntry kind;
    kind.id = kid(("k" + std::to_string(i)).c_str());
    kind.createdAt = at(9);
    arriving.kinds.push_back(std::move(kind));
  }

  std::optional<Admission> refusal = admit(legend, arriving);
  REQUIRE(refusal.has_value());
  CHECK(refusal->verdict == Admission::Verdict::tooLarge);
  CHECK_EQ(refusal->reason,
           std::string("this legend would hold 203 kinds, max 6 — remove a kind before adding another"));

  LegendState oneMore;
  KindStateEntry kind;
  kind.id = kid("craft");
  kind.createdAt = at(9);
  kind.label = "Craft";
  oneMore.kinds.push_back(kind);
  CHECK_FALSE(admit(legend, oneMore).has_value());  // 3 seeded + 1 is still under six
}

TEST(admit_names_the_kind_whose_field_is_over_its_cap) {
  LegendState arriving;
  KindStateEntry kind;
  kind.id = kid("craft");
  kind.createdAt = at(9);
  kind.label = std::string(kMaxKindLabelLength + 1, 'x');
  arriving.kinds.push_back(std::move(kind));

  std::optional<Admission> refusal = admit(Legend{}, arriving);
  REQUIRE(refusal.has_value());
  CHECK(refusal->verdict == Admission::Verdict::malformed);
  CHECK_EQ(refusal->reason, std::string("kind \"craft\": label is 25 characters, max 24"));
}

TEST(admit_title_bounds_the_register_a_frame_would_set) {
  CHECK_FALSE(admitTitle("Learn to sail").has_value());
  std::optional<Admission> refusal = admitTitle(std::string(40000, 'x'));
  REQUIRE(refusal.has_value());
  CHECK(refusal->verdict == Admission::Verdict::malformed);
  CHECK_EQ(refusal->reason, std::string("the title is 40000 characters, max 200"));
}

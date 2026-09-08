#include "products/roadmap/domain/Command.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "test/testing.h"

#include <limits>

using namespace wm;

static NodeId nid(const char* s) { return NodeId{std::string(s)}; }
static KindId kid(const char* s) { return KindId{std::string(s)}; }
static Hlc at(std::uint64_t ms, const char* actor = "a") { return Hlc{ms, 0, actor}; }

static Command createNodeCommand(const char* id) {
  return CreateNode{nid(id), id, "", NodeColor::sky, {}, std::nullopt};
}

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
           std::optional<std::string>("label would be 201 characters, 1 over the 200 cap"));
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
  g.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(1));
  std::vector<Link> tooMany(kMaxNodeLinks + 1, Link{"", "u"});
  CHECK_EQ(validate(g, legend, Command{AnnotateNode{nid("a"), std::nullopt, tooMany}}),
           std::optional<std::string>("links has 33 items, max 32"));
  CHECK_EQ(validate(g, legend, Command{AnnotateNode{nid("a"), std::string(kMaxNodeDescriptionLength + 1, 'x'),
                                                    std::nullopt}}),
           std::optional<std::string>("description would be 16001 characters, 1 over the 16000 cap"));
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
           std::optional<std::string>("label would be 25 characters, 1 over the 24 cap"));
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
  CHECK_EQ(refusal->reason, std::string("node \"hull\": description would be 16001 characters, 1 over the 16000 cap"));
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
  CHECK_EQ(refusal->reason, std::string("the title would be 201 characters, 1 over the 200 cap"));
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
  CHECK_EQ(refusal->reason, std::string("node \"hull\": label would be 201 characters, 1 over the 200 cap"));
}

TEST(admit_refuses_an_oversized_id_without_quoting_it_back) {
  TreeData data;
  NodeSpec node;
  node.id = nid(std::string(20000, 'x').c_str());
  data.nodes.push_back(std::move(node));

  std::optional<Admission> refusal = admit(data);
  REQUIRE(refusal.has_value());
  CHECK_EQ(refusal->reason, std::string("a node id would be 20000 characters, 19872 over the 128 cap"));
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
  CHECK_EQ(refusal->reason, std::string("kind \"craft\": label would be 25 characters, 1 over the 24 cap"));
}

TEST(admit_title_bounds_the_register_a_frame_would_set) {
  CHECK_FALSE(admitTitle("Learn to sail").has_value());
  std::optional<Admission> refusal = admitTitle(std::string(40000, 'x'));
  REQUIRE(refusal.has_value());
  CHECK(refusal->verdict == Admission::Verdict::malformed);
  CHECK_EQ(refusal->reason, std::string("the title would be 40000 characters, 39800 over the 200 cap"));
}

TEST(describe_kind_writes_only_the_registers_it_carries) {
  LooseGraph g;
  Legend legend = Legend::seededDefaults(at(1));

  merge(g, legend, Command{DescribeKind{kid("build"), std::nullopt, true}}, at(2));
  Kind flagged = *legend.view(kid("build"));
  CHECK(flagged.crossBranchExempt);
  CHECK_EQ(flagged.description, std::string("Things you make"));

  merge(g, legend, Command{DescribeKind{kid("build"), std::string("Made things"), std::nullopt}}, at(3));
  Kind described = *legend.view(kid("build"));
  CHECK(described.crossBranchExempt);
  CHECK_EQ(described.description, std::string("Made things"));
  CHECK_EQ(legend.exportKind(kid("build"))->crossBranchExemptAt, at(2));

  CHECK_EQ(validate(g, legend, Command{DescribeKind{kid("build"), std::nullopt, false}}), std::nullopt);
  CHECK_EQ(validate(g, legend, Command{DescribeKind{kid("nope"), std::nullopt, true}}),
           std::optional<std::string>("no kind \"nope\" in this legend"));
  CHECK_EQ(validate(g, legend, Command{DescribeKind{kid("build"), std::string(81, 'y'), true}}),
           std::optional<std::string>("description would be 81 characters, 1 over the 80 cap"));
}

TEST(add_kind_seeds_the_exemption_inline) {
  LooseGraph g;
  Legend legend;
  merge(g, legend, Command{AddKind{kid("drill"), NodeColor::gold, "Drill", "", true}}, at(1));
  merge(g, legend, Command{AddKind{kid("build"), NodeColor::sky, "Build", ""}}, at(2));
  CHECK(legend.view(kid("drill"))->crossBranchExempt);
  CHECK_FALSE(legend.view(kid("build"))->crossBranchExempt);
  CHECK_EQ(legend.exportKind(kid("drill"))->crossBranchExemptAt, at(1));
  CHECK_EQ(legend.exportKind(kid("build"))->crossBranchExemptAt, Hlc{});  // false was never written
}

TEST(annotate_node_sets_and_clears_the_icon) {
  LooseGraph g;
  Legend legend;
  g.createNode(nid("a"), "A", "", NodeColor::sky, std::nullopt, at(1));
  CHECK_EQ(g.nodeView(nid("a"))->icon, std::string(""));

  AnnotateNode setIcon{nid("a")};
  setIcon.icon = "star";
  merge(g, legend, Command{setIcon}, at(2));
  CHECK_EQ(g.nodeView(nid("a"))->icon, std::string("star"));
  CHECK_EQ(g.exportNode(nid("a"))->iconAt, at(2));

  AnnotateNode clearIcon{nid("a")};
  clearIcon.icon = "";
  merge(g, legend, Command{clearIcon}, at(3));
  CHECK_EQ(g.nodeView(nid("a"))->icon, std::string(""));
  CHECK_EQ(g.exportNode(nid("a"))->iconAt, at(3));

  AnnotateNode stale{nid("a")};
  stale.icon = "moon";
  merge(g, legend, Command{stale}, at(2));  // older than the clear: the register keeps the clear
  CHECK_EQ(g.nodeView(nid("a"))->icon, std::string(""));
  CHECK_EQ(g.nodeView(nid("a"))->label, std::string("A"));  // untouched register
}

TEST(annotate_node_appends_to_the_description_after_a_blank_line) {
  LooseGraph g;
  Legend legend;
  g.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(1));

  AnnotateNode first{nid("a")};
  first.appendDescription = "first entry";
  merge(g, legend, Command{first}, at(2));
  CHECK_EQ(g.nodeView(nid("a"))->description, std::string("first entry"));  // an empty body opens with no leading blank line

  AnnotateNode second{nid("a")};
  second.appendDescription = "second entry";
  merge(g, legend, Command{second}, at(3));
  CHECK_EQ(g.nodeView(nid("a"))->description, std::string("first entry\n\nsecond entry"));
  CHECK_EQ(g.exportNode(nid("a"))->descriptionAt, at(3));

  AnnotateNode replace{nid("a")};
  replace.description = "fresh";
  merge(g, legend, Command{replace}, at(4));
  CHECK_EQ(g.nodeView(nid("a"))->description, std::string("fresh"));
}

TEST(annotate_node_refuses_description_and_append_together) {
  LooseGraph g;
  Legend legend;
  g.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(1));
  AnnotateNode both{nid("a")};
  both.description = "one";
  both.appendDescription = "two";
  CHECK_EQ(validate(g, legend, Command{both}),
           std::optional<std::string>("description and appendDescription are both set — pass one: "
                                      "description replaces the body, appendDescription joins onto it"));
}

TEST(annotate_node_holds_the_cap_against_the_appended_result) {
  LooseGraph g;
  Legend legend;
  g.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(1));
  g.setDescription(nid("a"), std::string(16000, 'x'), at(1));

  AnnotateNode tail{nid("a")};
  tail.appendDescription = std::string(1179, 'y');  // 16000 + 2 (the blank line) + 1179 = 17181
  CHECK_EQ(validate(g, legend, Command{tail}),
           std::optional<std::string>("description would be 17181 characters, 1181 over the 16000 cap"));

  g.setDescription(nid("a"), std::string(15990, 'x'), at(2));
  AnnotateNode fits{nid("a")};
  fits.appendDescription = std::string(8, 'y');  // 15990 + 2 + 8 = 16000, exactly the cap
  CHECK_EQ(validate(g, legend, Command{fits}), std::nullopt);
}

TEST(a_cap_refusal_names_every_field_over_its_cap) {
  LooseGraph g;
  Legend legend;
  CreateNode wide{nid("n"), std::string(250, 'l'), std::string(65, 'i')};
  wide.description = std::string(17181, 'd');
  wide.links = {Link{std::string(201, 'L'), "https://ok"}};
  CHECK_EQ(validate(g, legend, Command{wide}),
           std::optional<std::string>(
               "label would be 250 characters, 50 over the 200 cap; icon would be 65 characters, 1 over the "
               "64 cap; description would be 17181 characters, 1181 over the 16000 cap; links[0].label would "
               "be 201 characters, 1 over the 200 cap"));

  AnnotateNode both{nid("n")};
  both.icon = std::string(65, 'i');
  both.description = std::string(16001, 'd');
  CHECK_EQ(validate(g, legend, Command{both}),
           std::optional<std::string>("icon would be 65 characters, 1 over the 64 cap; description would be "
                                      "16001 characters, 1 over the 16000 cap"));
}

TEST(every_cap_counts_code_points_not_bytes) {
  CHECK_EQ(codePointCount(""), 0u);
  CHECK_EQ(codePointCount("abc"), 3u);
  CHECK_EQ(codePointCount("h\xC3\xA9llo"), 5u);             // é is two bytes
  CHECK_EQ(codePointCount("\xE5\xAD\x97\xE5\xAD\x97"), 2u);  // 字字, six bytes
  CHECK_EQ(codePointCount("\xF0\x9F\x98\x80"), 1u);          // one emoji, four bytes
  CHECK_EQ(byteOffsetOfCodePoint("a\xC3\xA9z", 0), 0u);
  CHECK_EQ(byteOffsetOfCodePoint("a\xC3\xA9z", 1), 1u);
  CHECK_EQ(byteOffsetOfCodePoint("a\xC3\xA9z", 2), 3u);
  CHECK_EQ(byteOffsetOfCodePoint("a\xC3\xA9z", 3), std::string::npos);

  LooseGraph g = seeded();
  Legend legend;
  std::string grins;
  for (std::size_t i = 0; i < kMaxNodeLabelLength; ++i) grins += "\xF0\x9F\x98\x80";  // 200 code points, 800 bytes
  CHECK_EQ(validate(g, legend, Command{RenameNode{nid("a"), grins}}), std::nullopt);
  CHECK_EQ(validate(g, legend, Command{CreateNode{nid("c"), grins, "\xF0\x9F\x98\x80"}}), std::nullopt);
  CHECK_EQ(validate(g, legend, Command{RenameNode{nid("a"), grins + "\xF0\x9F\x98\x80"}}),
           std::optional<std::string>("label would be 201 characters, 1 over the 200 cap"));

  TreeData document;
  NodeSpec node;
  node.id = nid("hull");
  node.label = grins;
  document.nodes.push_back(std::move(node));
  CHECK_FALSE(admit(document).has_value());

  std::string cjkTitle;
  for (std::size_t i = 0; i < kMaxTitleChars; ++i) cjkTitle += "\xE5\xAD\x97";
  CHECK_FALSE(admitTitle(cjkTitle).has_value());
}

TEST(malformed_utf8_is_refused_at_every_door_before_any_cap_is_counted) {
  CHECK(isValidUtf8(""));
  CHECK(isValidUtf8("plain ascii"));
  CHECK(isValidUtf8("h\xC3\xA9llo \xE5\xAD\x97 \xF0\x9F\x98\x80"));
  CHECK(isValidUtf8("\xF4\x8F\xBF\xBF"));           // U+10FFFF, the last scalar value
  CHECK_FALSE(isValidUtf8("\xFF"));                  // no such lead byte
  CHECK_FALSE(isValidUtf8("\x80"));                  // a lone continuation byte
  CHECK_FALSE(isValidUtf8("\xE2\x82"));              // truncated: two bytes of a three-byte sequence
  CHECK_FALSE(isValidUtf8("a\xC3"));                 // truncated at the end of the text
  CHECK_FALSE(isValidUtf8("\xC0\x80"));              // overlong NUL
  CHECK_FALSE(isValidUtf8("\xE0\x80\x80"));          // overlong three-byte form
  CHECK_FALSE(isValidUtf8("\xF0\x80\x80\x80"));      // overlong four-byte form
  CHECK_FALSE(isValidUtf8("\xED\xA0\x80"));          // U+D800, a surrogate
  CHECK_FALSE(isValidUtf8("\xF4\x90\x80\x80"));      // U+110000, past the last scalar value
  CHECK_FALSE(isValidUtf8("\xF5\x80\x80\x80"));      // a lead past F4
  CHECK_FALSE(isValidUtf8("\xC3\x41"));              // a lead followed by a non-continuation byte

  // 100000 continuation bytes count as zero characters, so without the gate every cap passes.
  const std::string continuation(100000, '\x80');
  CHECK_EQ(codePointCount(continuation), 0u);
  LooseGraph g = seeded();
  Legend legend;
  CreateNode description{nid("c"), "L", ""};
  description.description = continuation;
  CHECK_EQ(validate(g, legend, Command{description}),
           std::optional<std::string>("description is not valid UTF-8"));
  CHECK_EQ(validate(g, legend, Command{CreateNode{NodeId{continuation}, "L", ""}}),
           std::optional<std::string>("node id is not valid UTF-8"));
  CHECK_EQ(validate(g, legend, Command{CreateNode{nid("c"), "\xFF", "\xE2\x82"}}),
           std::optional<std::string>("label is not valid UTF-8; icon is not valid UTF-8"));
  CHECK_EQ(validate(g, legend, Command{RenameNode{nid("a"), "\xC0\x80"}}),
           std::optional<std::string>("label is not valid UTF-8"));
  AnnotateNode links{nid("a")};
  links.links = std::vector<Link>{Link{"ok", "https://x/\xED\xA0\x80"}};
  CHECK_EQ(validate(g, legend, Command{links}), std::optional<std::string>("links[0].url is not valid UTF-8"));
  CHECK_EQ(validate(g, legend, Command{AddKind{kid("k"), NodeColor::sky, "\xF5\x80\x80\x80", ""}}),
           std::optional<std::string>("label is not valid UTF-8"));

  // The HTTP save door: a posted document.
  TreeData document;
  document.title = "Mine";
  NodeSpec hull;
  hull.id = nid("hull");
  hull.label = "hull";
  hull.description = continuation;
  document.nodes.push_back(hull);
  std::optional<Admission> posted = admit(document);
  REQUIRE(posted.has_value());
  CHECK(posted->verdict == Admission::Verdict::malformed);
  CHECK_EQ(posted->reason, std::string("node \"hull\": description is not valid UTF-8"));
  document.nodes[0].description = "";
  document.nodes[0].id = NodeId{std::string(5000, '\x80')};
  CHECK_EQ(admit(document)->reason, std::string("a node id is not valid UTF-8"));
  document.nodes[0].id = nid("hull");
  document.title = "\xE2\x82";
  CHECK_EQ(admit(document)->reason, std::string("the title is not valid UTF-8"));
  CHECK_EQ(admitTitle(std::string(300, '\x80'))->reason, std::string("the title is not valid UTF-8"));
  document.title = "Mine";
  Kind kind;
  kind.id = kid("k");
  kind.hue = NodeColor::sky;
  kind.description = "\xFF";
  document.kinds.push_back(kind);
  CHECK_EQ(admit(document)->reason, std::string("kind \"k\": description is not valid UTF-8"));

  // The socket door: a client lattice frame, whose edges name ids no node in the frame carries.
  LooseGraph client;
  client.createNode(nid("hull"), "hull", "", NodeColor::sky, std::nullopt, at(100, "client"));
  client.setDescription(nid("hull"), continuation, at(101, "client"));
  std::optional<Admission> frame = admit(g, client.exportState());
  REQUIRE(frame.has_value());
  CHECK(frame->verdict == Admission::Verdict::malformed);
  CHECK_EQ(frame->reason, std::string("node \"hull\": description is not valid UTF-8"));
  LooseGraph dangling;
  dangling.addEdge(NodeId{"\x80\x80"}, nid("a"), at(100, "client"));
  CHECK_EQ(admit(g, dangling.exportState())->reason, std::string("an edge endpoint is not valid UTF-8"));
  LooseGraph longEdge;
  longEdge.addEdge(nid("a"), NodeId{std::string(129, 'e')}, at(100, "client"));
  CHECK_EQ(admit(g, longEdge.exportState())->reason,
           std::string("an edge endpoint would be 129 characters, 1 over the 128 cap"));
  LegendState legendFrame;
  KindStateEntry entry;
  entry.id = kid("k");
  entry.label = "\xC3";
  legendFrame.kinds.push_back(entry);
  CHECK_EQ(admit(legend, legendFrame)->reason, std::string("kind \"k\": label is not valid UTF-8"));

  // Valid four-byte text is still counted by code point, at the cap and one over it.
  std::string grins;
  for (std::size_t i = 0; i < kMaxNodeDescriptionLength; ++i) grins += "\xF0\x9F\x98\x80";
  CHECK_EQ(codePointCount(grins), kMaxNodeDescriptionLength);
  AnnotateNode full{nid("a")};
  full.description = grins;
  CHECK_EQ(validate(g, legend, Command{full}), std::nullopt);
  full.description = grins + "\xF0\x9F\x98\x80";
  CHECK_EQ(validate(g, legend, Command{full}),
           std::optional<std::string>("description would be 16001 characters, 1 over the 16000 cap"));
}

TEST(a_node_edit_naming_no_present_node_is_refused_before_it_can_plant_a_phantom) {
  LooseGraph g = seeded();
  Legend legend;
  const std::optional<std::string> missing("no node in this tree is named \"ghost\"");
  AnnotateNode annotate{nid("ghost")};
  annotate.appendDescription = "boo";
  CHECK_EQ(validate(g, legend, Command{annotate}), missing);
  CHECK_EQ(validate(g, legend, Command{RenameNode{nid("ghost"), "Ghost"}}), missing);
  CHECK_EQ(validate(g, legend, Command{SetNodeColor{nid("ghost"), NodeColor::gold}}), missing);
  CHECK_EQ(validate(g, legend, Command{RepositionNode{nid("ghost"), Vec2{1, 2}}}), missing);
  CHECK_EQ(validate(g, legend, Command{Batch{{createNodeCommand("c"), Command{annotate}}}}), missing);

  // A tombstoned id is as absent as one never created.
  g.deleteNode(nid("a"), at(9));
  AnnotateNode dead{nid("a")};
  dead.icon = "zombie";
  CHECK_EQ(validate(g, legend, Command{dead}), std::optional<std::string>("no node in this tree is named \"a\""));
  CHECK_EQ(validate(g, legend, Command{RenameNode{nid("a"), "Back"}}),
           std::optional<std::string>("no node in this tree is named \"a\""));

  // A present node passes, and a cap is still named ahead of existence.
  AnnotateNode fine{nid("b")};
  fine.icon = "star";
  CHECK_EQ(validate(g, legend, Command{fine}), std::nullopt);
  CHECK_EQ(validate(g, legend, Command{RenameNode{nid("ghost"), std::string(201, 'l')}}),
           std::optional<std::string>("label would be 201 characters, 1 over the 200 cap"));
  CHECK_EQ(g.presentNodeCount(), 1u);
}

TEST(node_patch_plan_preserves_omitted_fields_and_retries_without_commands) {
  LooseGraph graph = seeded();
  Legend legend;
  NodePatch first;
  first.nodeId = nid("a");
  first.label = "New A";
  NodePatch second;
  second.nodeId = nid("b");
  second.description = "New description";
  second.links = std::vector<Link>{{"Reference", "https://example.com"}};
  const auto result = planNodePatches(graph, legend, {first, second});
  REQUIRE(std::holds_alternative<NodePatchPlan>(result));
  const NodePatchPlan& plan = std::get<NodePatchPlan>(result);
  CHECK_EQ(plan.changedNodeIds, (std::vector<NodeId>{nid("a"), nid("b")}));
  merge(graph, legend, plan.batch, at(10));
  CHECK_EQ(graph.nodeView(nid("a"))->label, std::string("New A"));
  CHECK_EQ(graph.nodeView(nid("a"))->icon, std::string("x"));
  CHECK_EQ(graph.nodeView(nid("b"))->position, (std::optional<Vec2>{Vec2{3, 4}}));
  CHECK_EQ(graph.nodeView(nid("b"))->prerequisites, (std::vector<NodeId>{nid("a")}));
  const auto retry = planNodePatches(graph, legend, {first, second});
  REQUIRE(std::holds_alternative<NodePatchPlan>(retry));
  CHECK(std::get<NodePatchPlan>(retry).batch.commands.empty());
  CHECK(std::get<NodePatchPlan>(retry).changedNodeIds.empty());
}

TEST(node_patch_plan_rejects_invalid_last_row_duplicates_and_empty_patches) {
  const LooseGraph graph = seeded();
  Legend legend;
  NodePatch first;
  first.nodeId = nid("a");
  first.label = "New A";
  NodePatch last;
  last.nodeId = nid("b");
  last.description = std::string(kMaxNodeDescriptionLength + 1, 'x');
  CHECK(std::holds_alternative<std::string>(planNodePatches(graph, legend, {first, last})));
  CHECK_EQ(graph.nodeView(nid("a"))->label, std::string("A"));
  CHECK(std::holds_alternative<std::string>(planNodePatches(graph, legend, {first, first})));
  CHECK(std::holds_alternative<std::string>(planNodePatches(graph, legend, {NodePatch{nid("a")}})));
  last.description = std::string("bad\0text", 8);
  CHECK(std::holds_alternative<std::string>(planNodePatches(graph, legend, {first, last})));
  last.nodeId = nid("missing");
  CHECK(std::holds_alternative<std::string>(planNodePatches(graph, legend, {first, last})));
}

TEST(edge_change_plan_validates_net_capacity_and_all_endpoints_before_apply) {
  LooseGraph graph = seeded();
  Legend legend;
  for (std::size_t i = 1; i < kMaxEdges; ++i)
    graph.addEdge(nid("a"), NodeId{"missing-" + std::to_string(i)}, at(2));
  const EdgeChanges replace{{Edge{nid("b"), nid("a")}}, {Edge{nid("a"), nid("b")}}};
  const auto result = planEdgeChanges(graph, replace);
  REQUIRE(std::holds_alternative<EdgeChangePlan>(result));
  CHECK_EQ(std::get<EdgeChangePlan>(result).batch.commands.size(), 2u);
  CHECK(std::holds_alternative<std::string>(planEdgeChanges(graph, EdgeChanges{replace.add, {}})));
  EdgeChanges invalid = replace;
  invalid.add.push_back(Edge{nid("a"), nid("absent")});
  CHECK(std::holds_alternative<std::string>(planEdgeChanges(graph, invalid)));
  CHECK(graph.edgePresent(nid("a"), nid("b")));
  merge(graph, legend, std::get<EdgeChangePlan>(result).batch, at(10));
  CHECK_FALSE(graph.edgePresent(nid("a"), nid("b")));
  CHECK(graph.edgePresent(nid("b"), nid("a")));
  const auto retry = planEdgeChanges(graph, replace);
  REQUIRE(std::holds_alternative<EdgeChangePlan>(retry));
  CHECK(std::get<EdgeChangePlan>(retry).batch.commands.empty());
  CHECK(std::holds_alternative<std::string>(planEdgeChanges(graph, EdgeChanges{replace.add, replace.add})));
  CHECK(std::holds_alternative<std::string>(planEdgeChanges(graph, EdgeChanges{replace.add, {replace.remove[0], replace.remove[0]}})));
}

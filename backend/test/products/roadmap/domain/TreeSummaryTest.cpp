#include "products/roadmap/domain/TreeSummary.h"
#include "test/testing.h"

#include <set>
#include <string>
#include <vector>

using namespace wm;

static NodeId nid(const char* s) { return NodeId{std::string(s)}; }

static NodeSpec spec(const char* id, NodeColor color, std::vector<NodeId> prereqs) {
  NodeSpec node;
  node.id = nid(id);
  node.label = id;
  node.color = color;
  node.prerequisites = std::move(prereqs);
  return node;
}

static TreeData tree(const char* id, std::vector<NodeSpec> nodes) {
  TreeData data;
  data.id = TreeId{std::string(id)};
  data.title = id;
  data.nodes = std::move(nodes);
  return data;
}

TEST(stats_count_total_and_done_clamped_to_present_nodes) {
  TreeData data = tree("t", {spec("a", NodeColor::sky, {}), spec("b", NodeColor::sky, {nid("a")}),
                             spec("c", NodeColor::sky, {nid("b")})});
  Progress progress;
  progress.completed = {nid("a"), nid("b"), nid("ghost")};  // ghost no longer exists

  TreeStats stats = treeStats(data, progress);
  CHECK_EQ(stats.total, 3);
  CHECK_EQ(stats.done, 2);  // ghost is clamped out, so done never exceeds total
}

TEST(dominant_kind_is_the_most_worn_color) {
  TreeData data = tree("t", {spec("a", NodeColor::olive, {}), spec("b", NodeColor::olive, {nid("a")}),
                             spec("c", NodeColor::sky, {nid("b")})});
  TreeStats stats = treeStats(data, Progress{});
  CHECK_EQ(stats.dominantKind, NodeColor::olive);
}

TEST(dominant_kind_breaks_a_tie_to_the_root_color) {
  // one gold, one sky — a tie; the root (no prerequisites) is 'a', so gold wins.
  TreeData data = tree("t", {spec("a", NodeColor::gold, {}), spec("b", NodeColor::sky, {nid("a")})});
  TreeStats stats = treeStats(data, Progress{});
  CHECK_EQ(stats.dominantKind, NodeColor::gold);
}

TEST(dominant_kind_of_an_empty_tree_is_absent) {
  TreeStats stats = treeStats(tree("t", {}), Progress{});
  CHECK_EQ(stats.total, 0);
  CHECK_FALSE(stats.dominantKind.has_value());
}

TEST(registry_orders_by_recency_then_id_and_a_progress_mark_bumps_a_row) {
  std::vector<LoadedTree> loaded;
  loaded.push_back({tree("c", {}), 10, 100, Progress{}, 0});    // recency 100
  loaded.push_back({tree("b", {}), 20, 50, Progress{}, 200});   // progress mark lifts 50 -> 200
  loaded.push_back({tree("a", {}), 30, 200, Progress{}, 0});    // recency 200

  std::vector<TreeSummary> summaries = registrySummaries(loaded);
  REQUIRE_EQ(summaries.size(), 3u);
  CHECK_EQ(summaries[0].id, TreeId{std::string("a")});  // 200, ties broken by id (a < b)
  CHECK_EQ(summaries[1].id, TreeId{std::string("b")});  // 200, from its progress mark
  CHECK_EQ(summaries[2].id, TreeId{std::string("c")});  // 100
  CHECK_EQ(summaries[0].updatedAt, 200u);
  CHECK_EQ(summaries[1].updatedAt, 200u);
  CHECK_EQ(summaries[2].updatedAt, 100u);
}

TEST(registry_carries_the_planting_time_untouched_by_recency) {
  std::vector<LoadedTree> loaded;
  loaded.push_back({tree("a", {}), 1'000, 5'000, Progress{}, 0});
  loaded.push_back({tree("b", {}), 2'000, 4'000, Progress{}, 9'000});  // a mark far past its planting
  loaded.push_back({tree("c", {}), 0, 0, Progress{}, 0});              // no recorded planting -> 0

  std::vector<TreeSummary> summaries = registrySummaries(loaded);
  REQUIRE_EQ(summaries.size(), 3u);
  CHECK_EQ(summaries[0].id, TreeId{std::string("b")});
  CHECK_EQ(summaries[0].createdAt, 2'000u);  // the mark bumped updatedAt, never the birth stamp
  CHECK_EQ(summaries[0].updatedAt, 9'000u);
  CHECK_EQ(summaries[1].id, TreeId{std::string("a")});
  CHECK_EQ(summaries[1].createdAt, 1'000u);
  CHECK_EQ(summaries[1].updatedAt, 5'000u);
  CHECK_EQ(summaries[2].id, TreeId{std::string("c")});
  CHECK_EQ(summaries[2].createdAt, 0u);
  CHECK_EQ(summaries[2].updatedAt, 0u);
}

TEST(registry_counts_a_node_that_opens_a_tree_as_done_when_that_tree_is_complete_whatever_mark_it_holds) {
  NodeSpec idea = spec("idea", NodeColor::sky, {});
  idea.opens = TreeId{std::string("sub")};
  NodeSpec stalled = spec("stalled", NodeColor::sky, {});
  stalled.opens = TreeId{std::string("open")};
  NodeSpec stray = spec("stray", NodeColor::sky, {});
  stray.opens = TreeId{std::string("someone-elses")};
  Progress onMain;
  onMain.completed = {nid("stalled"), nid("stray")};
  Progress onSub;
  onSub.completed = {nid("s")};
  std::vector<LoadedTree> loaded;
  loaded.push_back({tree("main", {idea, stalled, stray, spec("plain", NodeColor::sky, {})}), 0, 0, onMain, 0});
  loaded.push_back({tree("sub", {spec("s", NodeColor::sky, {})}), 0, 0, onSub, 0});
  loaded.push_back({tree("open", {spec("o", NodeColor::sky, {})}), 0, 0, Progress{}, 0});

  const OpenedTrees opened = openedAmong(loaded);
  std::vector<std::set<NodeId>> completed;
  for (const LoadedTree& tree : loaded) completed.push_back(opened.followed(tree.data, tree.progress).completed);
  CHECK(completed == (std::vector<std::set<NodeId>>{{nid("idea"), nid("stray")}, {nid("s")}, {}}));

  std::vector<std::string> doneOfTotal;
  for (const TreeSummary& summary : registrySummaries(loaded))
    doneOfTotal.push_back(summary.id.str() + " " + std::to_string(summary.stats.done) + "/" + std::to_string(summary.stats.total));
  CHECK_EQ(doneOfTotal, (std::vector<std::string>{"main 2/4", "open 0/1", "sub 1/1"}));
}

// A subtree is no row of the list: it counts in its parent as the one step that owns it, done once its own steps all
// are, however deep, unfinished while it holds none, and open again when a leaf below reopens.
TEST(registry_lists_roots_alone_and_counts_a_step_that_owns_a_subtree_done_when_the_subtree_is) {
  NodeSpec sail = spec("sail", NodeColor::sky, {});
  sail.opens = TreeId{std::string("t_s")};
  NodeSpec empty = spec("empty", NodeColor::sky, {});
  empty.opens = TreeId{std::string("t_e")};
  NodeSpec rig = spec("rig", NodeColor::sky, {});
  rig.opens = TreeId{std::string("t_r")};
  Progress onRoot;
  onRoot.completed = {nid("coast")};
  Progress onSail;
  onSail.completed = {nid("knot")};
  Progress onRig;
  onRig.completed = {nid("bowline")};
  const OwningStep underSail{TreeId{std::string("t_a")}, nid("sail")};
  std::vector<LoadedTree> loaded;
  loaded.push_back({tree("t_a", {sail, spec("coast", NodeColor::sky, {nid("sail")}), empty}), 0, 2, onRoot, 0});
  loaded.push_back({tree("t_s", {rig, spec("knot", NodeColor::sky, {})}), 0, 3, onSail, 0, underSail});
  loaded.push_back({tree("t_r", {spec("bowline", NodeColor::sky, {})}), 0, 4, onRig, 0,
                    OwningStep{TreeId{std::string("t_s")}, nid("rig")}});
  loaded.push_back({tree("t_e", {}), 0, 5, Progress{}, 0, OwningStep{TreeId{std::string("t_a")}, nid("empty")}});
  const auto rows = [&] {
    std::vector<std::string> doneOfTotal;
    for (const TreeSummary& summary : registrySummaries(loaded))
      doneOfTotal.push_back(summary.id.str() + " " + std::to_string(summary.stats.done) + "/" +
                            std::to_string(summary.stats.total));
    return doneOfTotal;
  };

  CHECK_EQ(rows(), (std::vector<std::string>{"t_a 2/3"}));
  loaded[2].progress = Progress{};
  CHECK_EQ(rows(), (std::vector<std::string>{"t_a 1/3"}));
}

// A step pointing at another root's subtree is an ordinary step there: its own mark counts, the subtree it names gives it
// nothing, and that root is named among no tree's openers by it.
TEST(registry_counts_a_step_pointing_at_a_subtree_by_its_own_mark) {
  NodeSpec sail = spec("sail", NodeColor::sky, {});
  sail.opens = TreeId{std::string("t_s")};
  NodeSpec far = spec("far", NodeColor::sky, {});
  far.opens = TreeId{std::string("t_s")};
  NodeSpec unmarked = spec("unmarked", NodeColor::sky, {});
  unmarked.opens = TreeId{std::string("t_s")};
  Progress onOther;
  onOther.completed = {nid("far")};
  Progress onSail;
  onSail.completed = {nid("knot")};
  std::vector<LoadedTree> loaded;
  loaded.push_back({tree("t_a", {sail}), 0, 2, Progress{}, 0});
  loaded.push_back({tree("t_b", {far, unmarked}), 0, 1, onOther, 0});
  loaded.push_back({tree("t_s", {spec("knot", NodeColor::sky, {})}), 0, 3, onSail, 0,
                    OwningStep{TreeId{std::string("t_a")}, nid("sail")}});

  std::vector<std::string> rows;
  for (const TreeSummary& summary : registrySummaries(loaded))
    rows.push_back(summary.id.str() + " " + std::to_string(summary.stats.done) + "/" +
                   std::to_string(summary.stats.total) + " openers " + std::to_string(summary.openers.size()));
  CHECK_EQ(rows, (std::vector<std::string>{"t_a 1/1 openers 0", "t_b 1/2 openers 0"}));
}

// A root's row counts what its removal takes: every subtree reached down its present owning steps, at any depth, and the
// steps of the root and of each of them. A subtree whose owning step is absent is no part of it.
TEST(registry_rows_count_the_branch_a_roots_removal_takes) {
  const auto owning = [](const char* id, const char* subtree) {
    NodeSpec node = spec(id, NodeColor::sky, {});
    node.opens = TreeId{std::string(subtree)};
    return node;
  };
  const auto under = [](const char* tree, const char* step) {
    return std::optional<OwningStep>(OwningStep{TreeId{std::string(tree)}, nid(step)});
  };
  std::vector<LoadedTree> loaded;
  loaded.push_back({tree("t_a", {owning("sail", "t_s"), owning("swim", "t_w"), spec("coast", NodeColor::sky, {})}),
                    0, 2, Progress{}, 0});
  loaded.push_back({tree("t_s", {owning("rig", "t_r"), spec("knot", NodeColor::sky, {})}), 0, 3, Progress{}, 0,
                    under("t_a", "sail")});
  loaded.push_back({tree("t_r", {spec("bowline", NodeColor::sky, {})}), 0, 4, Progress{}, 0, under("t_s", "rig")});
  loaded.push_back({tree("t_w", {}), 0, 5, Progress{}, 0, under("t_a", "swim")});
  loaded.push_back({tree("t_gone", {spec("lost", NodeColor::sky, {})}), 0, 6, Progress{}, 0, under("t_a", "dive")});
  loaded.push_back({tree("t_b", {spec("alone", NodeColor::sky, {})}), 0, 1, Progress{}, 0});

  std::vector<std::string> branches;
  for (const TreeSummary& summary : registrySummaries(loaded))
    branches.push_back(summary.id.str() + " " + std::to_string(summary.branch.subtrees) + " subtrees, " +
                       std::to_string(summary.branch.steps) + " steps");
  CHECK_EQ(branches, (std::vector<std::string>{"t_a 3 subtrees, 6 steps", "t_b 0 subtrees, 1 steps"}));
}

TEST(registry_counts_a_chain_of_twenty_trees_as_done_from_the_mark_at_its_end) {
  const auto name = [](int k) { return std::string(k < 10 ? "t0" : "t") + std::to_string(k); };
  std::vector<LoadedTree> loaded;
  for (int k = 0; k < 20; ++k) {
    NodeSpec node = spec("n", NodeColor::sky, {});
    if (k < 19) node.opens = TreeId{name(k + 1)};
    loaded.push_back({tree(name(k).c_str(), {node}), 0, 0, Progress{}, 0});
  }
  const auto doneOfTotal = [&] {
    std::vector<std::string> counts;
    for (const TreeSummary& summary : registrySummaries(loaded))
      counts.push_back(std::to_string(summary.stats.done) + "/" + std::to_string(summary.stats.total));
    return counts;
  };

  CHECK_EQ(doneOfTotal(), std::vector<std::string>(20, "0/1"));
  loaded.back().progress.completed = {nid("n")};
  CHECK_EQ(doneOfTotal(), std::vector<std::string>(20, "1/1"));
}

TEST(registry_reads_an_account_of_three_hundred_trees_that_each_open_every_later_one) {
  const auto name = [](int k) { return "t" + std::to_string(1000 + k); };
  std::vector<LoadedTree> loaded;
  for (int k = 0; k < 300; ++k) {
    std::vector<NodeSpec> nodes{spec("plain", NodeColor::sky, {})};
    for (int later = k + 1; later < 300; ++later) {
      NodeSpec opener = spec(("to-" + name(later)).c_str(), NodeColor::sky, {});
      opener.opens = TreeId{name(later)};
      nodes.push_back(opener);
    }
    Progress marks;
    marks.completed = {nid("plain")};
    loaded.push_back({tree(name(k).c_str(), nodes), 0, 0, marks, 0});
  }

  int trees = 0;
  int incomplete = 0;
  for (const TreeSummary& summary : registrySummaries(loaded)) {
    ++trees;
    if (summary.stats.done != summary.stats.total) ++incomplete;
  }
  CHECK_EQ(trees, 300);
  CHECK_EQ(incomplete, 0);
  CHECK_EQ(openedAmong(loaded).walked(), 300u * 299u / 2u);
}

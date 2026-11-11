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

  std::vector<std::set<NodeId>> completed;
  for (const Progress& followed : followedProgress(loaded)) completed.push_back(followed.completed);
  CHECK(completed == (std::vector<std::set<NodeId>>{{nid("idea"), nid("stray")}, {nid("s")}, {}}));

  std::vector<std::string> doneOfTotal;
  for (const TreeSummary& summary : registrySummaries(loaded))
    doneOfTotal.push_back(summary.id.str() + " " + std::to_string(summary.stats.done) + "/" + std::to_string(summary.stats.total));
  CHECK_EQ(doneOfTotal, (std::vector<std::string>{"main 2/4", "open 0/1", "sub 1/1"}));
}

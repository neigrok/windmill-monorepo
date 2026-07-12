#include "application/TreeRegistry.h"

#include "domain/LooseGraph.h"
#include "test/application/Fakes.h"
#include "test/testing.h"

#include <string>
#include <vector>

using namespace wm;
using namespace wm::fake;

static NodeSpec spec(const char* id, NodeColor color, std::vector<NodeId> prereqs = {}) {
  NodeSpec node;
  node.id = nid(id);
  node.label = id;
  node.color = color;
  node.prerequisites = std::move(prereqs);
  return node;
}

static void seed(FakeTreeRepository& trees, const char* id, const UserId& owner,
                 std::uint64_t updatedAt, std::vector<NodeSpec> nodes) {
  TreeData data;
  data.id = TreeId{std::string(id)};
  data.title = id;
  data.nodes = std::move(nodes);
  GraphState state = LooseGraph(data, Hlc{1, 0, "seed"}).exportState();
  trees.byId[id] = StoredTree{state, LegendState{}, data.title, 0, owner};
  trees.updatedAt[id] = updatedAt;
}

TEST(list_orders_owned_trees_newest_first_and_excludes_other_owners) {
  FakeTreeRepository trees;
  FakeProgressRepository progress;
  UserId me = uid("me");
  seed(trees, "old", me, 100, {spec("a", NodeColor::olive), spec("b", NodeColor::olive)});
  seed(trees, "fresh", me, 300, {spec("x", NodeColor::sky)});
  seed(trees, "notmine", uid("other"), 999, {spec("z", NodeColor::gold)});
  progress.setStatus(tid("old"), me, nid("a"), ProgressStatus::complete, at(150, "me"));

  TreeRegistry registry(trees, progress);
  std::vector<TreeSummary> rows = registry.list(me);

  CHECK_EQ(rows.size(), 2u);
  CHECK_EQ(rows[0].id, TreeId{std::string("fresh")});
  CHECK_EQ(rows[0].updatedAt, 300u);
  CHECK_EQ(rows[0].stats.total, 1);
  CHECK_EQ(rows[0].stats.done, 0);
  CHECK_EQ(rows[0].stats.dominantKind, NodeColor::sky);
  CHECK_EQ(rows[1].id, TreeId{std::string("old")});
  CHECK_EQ(rows[1].updatedAt, 150u);  // the progress mark (150) beat the structural stamp (100)
  CHECK_EQ(rows[1].stats.total, 2);
  CHECK_EQ(rows[1].stats.done, 1);
  CHECK_EQ(rows[1].stats.dominantKind, NodeColor::olive);
}

TEST(remove_soft_deletes_an_owned_tree_and_it_leaves_the_list) {
  FakeTreeRepository trees;
  FakeProgressRepository progress;
  UserId me = uid("me");
  seed(trees, "t", me, 100, {spec("a", NodeColor::sky)});
  TreeRegistry registry(trees, progress);

  CHECK_EQ(registry.list(me).size(), 1u);
  CHECK(registry.remove(tid("t"), me) == TreeRegistry::Removal::deleted);
  CHECK_EQ(registry.list(me).size(), 0u);
}

TEST(remove_refuses_a_non_owner_and_an_unknown_tree) {
  FakeTreeRepository trees;
  FakeProgressRepository progress;
  seed(trees, "t", uid("owner"), 100, {spec("a", NodeColor::sky)});
  TreeRegistry registry(trees, progress);

  CHECK(registry.remove(tid("t"), uid("intruder")) == TreeRegistry::Removal::notOwner);
  CHECK(registry.remove(tid("ghost"), uid("owner")) == TreeRegistry::Removal::notFound);
  CHECK_EQ(registry.list(uid("owner")).size(), 1u);  // the refusal left it intact
}

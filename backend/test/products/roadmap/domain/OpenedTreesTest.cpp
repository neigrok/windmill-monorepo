#include "products/roadmap/domain/OpenedTrees.h"
#include "products/roadmap/domain/UnlockRules.h"
#include "test/testing.h"

#include <algorithm>
#include <map>
#include <string>
#include <vector>

using namespace wm;

namespace {

NodeId nid(const std::string& id) { return NodeId{id}; }
TreeId tid(const std::string& id) { return TreeId{id}; }

NodeSpec step(const std::string& id, const std::string& opens = "", std::vector<NodeId> prerequisites = {}) {
  NodeSpec node;
  node.id = nid(id);
  node.label = id;
  node.opens = tid(opens);
  node.prerequisites = std::move(prerequisites);
  return node;
}

TreeData tree(const std::string& id, std::vector<NodeSpec> nodes) {
  TreeData data;
  data.id = tid(id);
  data.title = "Tree " + id;
  data.nodes = std::move(nodes);
  return data;
}

Progress marks(std::vector<std::string> completed) {
  Progress progress;
  for (const std::string& id : completed) progress.completed.insert(nid(id));
  return progress;
}

// One owner's trees, each with the marks given for it; an id with no marks is unmarked.
std::map<TreeId, OpenedTree> standing(const std::vector<TreeData>& trees,
                                      const std::map<std::string, Progress>& marked = {}) {
  std::map<TreeId, OpenedTree> known;
  for (const TreeData& data : trees) {
    const auto own = marked.find(data.id.str());
    known.emplace(data.id, OpenedTree(data, own == marked.end() ? Progress{} : own->second));
  }
  return known;
}

// A root whose one node opens t1, each t(k) opening t(k+1), and the last tree one marked step.
std::vector<TreeData> chain(int pointers) {
  std::vector<TreeData> trees{tree("root", {step("r", "t1")})};
  for (int k = 1; k < pointers; ++k)
    trees.push_back(tree("t" + std::to_string(k), {step("n", "t" + std::to_string(k + 1))}));
  trees.push_back(tree("t" + std::to_string(pointers), {step("n")}));
  return trees;
}

}

TEST(an_opened_tree_counts_its_nodes_the_marks_on_plain_ones_and_the_nodes_that_hold_a_pointer) {
  const TreeData data = tree("a", {step("plain-done"), step("plain"), step("opener-done", "b"), step("opener", "c")});

  const OpenedTree opened(data, marks({"plain-done", "opener-done", "ghost"}));

  OpenedTree expected;
  expected.title = "Tree a";
  expected.total = 4;
  expected.marked = 1;
  expected.openers = {{nid("opener-done"), tid("b"), true}, {nid("opener"), tid("c"), false}};
  CHECK(opened == expected);
  CHECK(treesOpenedBy(data) == (std::set<TreeId>{tid("b"), tid("c")}));
}

TEST(a_node_is_complete_when_the_tree_it_opens_is_complete_and_open_until_then) {
  const TreeData root = tree("root", {step("idea", "sub")});
  const TreeData sub = tree("sub", {step("s1"), step("s2")});

  const OpenedTrees halfway(root, standing({root, sub}, {{"sub", marks({"s1"})}}));
  CHECK(halfway.openings == (std::map<NodeId, Opening>{{nid("idea"), {tid("sub"), false, "Tree sub", false, 1, 2, false}}}));
  CHECK(halfway.followed(Progress{}).completed == std::set<NodeId>{});

  const OpenedTrees finished(root, standing({root, sub}, {{"sub", marks({"s1", "s2"})}}));
  CHECK(finished.openings == (std::map<NodeId, Opening>{{nid("idea"), {tid("sub"), false, "Tree sub", true, 2, 2, false}}}));
  CHECK(finished.followed(Progress{}).completed == std::set<NodeId>{nid("idea")});
}

TEST(two_trees_that_open_each_other_are_never_complete) {
  const TreeData a = tree("a", {step("to-b", "b")});
  const TreeData b = tree("b", {step("to-a", "a"), step("done")});
  const std::map<TreeId, OpenedTree> known =
      standing({a, b}, {{"a", marks({"to-b"})}, {"b", marks({"to-a", "done"})}});

  const OpenedTrees fromA(a, known);
  CHECK(fromA.openings == (std::map<NodeId, Opening>{{nid("to-b"), {tid("b"), false, "Tree b", false, 1, 2, true}}}));
  CHECK(fromA.followed(marks({"to-b"})).completed == std::set<NodeId>{});

  const OpenedTrees fromB(b, known);
  CHECK(fromB.openings == (std::map<NodeId, Opening>{{nid("to-a"), {tid("a"), false, "Tree a", false, 0, 1, true}}}));
  CHECK(fromB.followed(marks({"to-a", "done"})).completed == std::set<NodeId>{nid("done")});
}

TEST(a_tree_that_opens_itself_is_never_complete) {
  const TreeData self = tree("self", {step("again", "self"), step("done")});

  const OpenedTrees opened(self, standing({self}, {{"self", marks({"again", "done"})}}));

  CHECK(opened.openings == (std::map<NodeId, Opening>{{nid("again"), {tid("self"), false, "Tree self", false, 1, 2, true}}}));
  CHECK(opened.followed(marks({"again", "done"})).completed == std::set<NodeId>{nid("done")});
}

TEST(an_empty_tree_is_not_complete) {
  const TreeData root = tree("root", {step("idea", "empty")});
  const TreeData empty = tree("empty", {});

  const OpenedTrees opened(root, standing({root, empty}));

  CHECK(opened.openings == (std::map<NodeId, Opening>{{nid("idea"), {tid("empty"), false, "Tree empty", false, 0, 0, false}}}));
  CHECK(opened.followed(marks({"idea"})).completed == std::set<NodeId>{});
}

TEST(a_chain_of_eight_pointers_completes_and_one_of_nine_does_not) {
  const std::vector<TreeData> eight = chain(8);
  const OpenedTrees withinReach(eight.front(), standing(eight, {{"t8", marks({"n"})}}));
  CHECK(withinReach.openings == (std::map<NodeId, Opening>{{nid("r"), {tid("t1"), false, "Tree t1", true, 1, 1, false}}}));

  const std::vector<TreeData> nine = chain(9);
  std::map<std::string, Progress> everyNodeMarked;
  for (int k = 1; k <= 9; ++k) everyNodeMarked["t" + std::to_string(k)] = marks({"n"});
  const OpenedTrees pastReach(nine.front(), standing(nine, everyNodeMarked));
  CHECK(pastReach.openings == (std::map<NodeId, Opening>{{nid("r"), {tid("t1"), false, "Tree t1", false, 0, 1, false}}}));
}

TEST(a_tree_reached_by_a_shorter_way_is_within_reach_whatever_longer_way_also_leads_to_it) {
  std::vector<TreeData> trees = chain(9);
  trees.front().nodes.push_back(step("shortcut", "t2"));

  const OpenedTrees opened(trees.front(), standing(trees, {{"t9", marks({"n"})}}));

  CHECK(opened.openings == (std::map<NodeId, Opening>{{nid("r"), {tid("t1"), false, "Tree t1", true, 1, 1, false}},
                                                      {nid("shortcut"), {tid("t2"), false, "Tree t2", true, 1, 1, false}}}));
}

TEST(a_tree_opened_from_two_nodes_and_along_two_ways_is_judged_once_and_is_no_loop) {
  const TreeData root = tree("root", {step("left", "a"), step("right", "b"), step("direct", "shared"), step("twice", "shared")});
  const TreeData a = tree("a", {step("down", "shared")});
  const TreeData b = tree("b", {step("down", "shared"), step("own")});
  const TreeData shared = tree("shared", {step("s")});

  const OpenedTrees opened(root, standing({root, a, b, shared}, {{"shared", marks({"s"})}, {"b", marks({"own"})}}));

  CHECK(opened.openings == (std::map<NodeId, Opening>{{nid("left"), {tid("a"), false, "Tree a", true, 1, 1, false}},
                                                      {nid("right"), {tid("b"), false, "Tree b", true, 2, 2, false}},
                                                      {nid("direct"), {tid("shared"), false, "Tree shared", true, 1, 1, false}},
                                                      {nid("twice"), {tid("shared"), false, "Tree shared", true, 1, 1, false}}}));
  CHECK(opened.followed(Progress{}).completed ==
        (std::set<NodeId>{nid("left"), nid("right"), nid("direct"), nid("twice")}));
}

TEST(a_mark_on_a_node_with_a_valid_pointer_is_ignored_and_one_on_a_node_with_an_invalid_pointer_counts) {
  const TreeData root = tree("root", {step("valid", "sub"), step("gone", "t_removed"), step("gone-unmarked", "t_removed"), step("plain")});
  const TreeData sub = tree("sub", {step("s")});

  const OpenedTrees opened(root, standing({root, sub}));

  CHECK(opened.openings == (std::map<NodeId, Opening>{{nid("valid"), {tid("sub"), false, "Tree sub", false, 0, 1, false}},
                                                      {nid("gone"), {tid("t_removed"), true}},
                                                      {nid("gone-unmarked"), {tid("t_removed"), true}}}));
  CHECK(opened.followed(marks({"valid", "gone", "plain", "ghost"})).completed ==
        (std::set<NodeId>{nid("gone"), nid("plain"), nid("ghost")}));
}

TEST(a_node_whose_tree_is_complete_is_complete_though_its_prerequisites_are_not_and_the_step_waiting_on_it_unlocks) {
  const TreeData root = tree("root", {step("first"), step("idea", "sub", {nid("first")}), step("after", "", {nid("idea")}),
                                      step("later", "", {nid("after")})});
  const TreeData sub = tree("sub", {step("s")});

  const OpenedTrees open(root, standing({root, sub}));
  CHECK(UnlockRules::derive(root.nodes, open.followed(marks({"idea"}))) ==
        (std::map<NodeId, NodeState>{{nid("first"), NodeState::available}, {nid("idea"), NodeState::locked},
                                     {nid("after"), NodeState::locked}, {nid("later"), NodeState::locked}}));

  const OpenedTrees complete(root, standing({root, sub}, {{"sub", marks({"s"})}}));
  CHECK(UnlockRules::derive(root.nodes, complete.followed(Progress{})) ==
        (std::map<NodeId, NodeState>{{nid("first"), NodeState::available}, {nid("idea"), NodeState::complete},
                                     {nid("after"), NodeState::available}, {nid("later"), NodeState::locked}}));
}

TEST(done_counts_a_nested_node_by_the_tree_it_opens) {
  const TreeData root = tree("root", {step("idea", "mid")});
  const TreeData mid = tree("mid", {step("marked"), step("unmarked"), step("to-complete", "leaf-done"),
                                    step("to-open", "leaf-open"), step("to-removed", "t_removed")});
  const TreeData leafDone = tree("leaf-done", {step("l")});
  const TreeData leafOpen = tree("leaf-open", {step("l")});

  const OpenedTrees opened(root, standing({root, mid, leafDone, leafOpen},
                                          {{"mid", marks({"marked", "to-open", "to-removed"})}, {"leaf-done", marks({"l"})}}));

  CHECK(opened.openings == (std::map<NodeId, Opening>{{nid("idea"), {tid("mid"), false, "Tree mid", false, 3, 5, false}}}));
}

TEST(a_pointer_at_a_tree_past_reach_is_still_a_valid_one_so_the_mark_on_its_node_is_ignored) {
  const std::vector<TreeData> nine = chain(9);

  const OpenedTrees opened(nine.front(), standing(nine, {{"t8", marks({"n"})}, {"t9", marks({"n"})}}));

  CHECK(opened.openings == (std::map<NodeId, Opening>{{nid("r"), {tid("t1"), false, "Tree t1", false, 0, 1, false}}}));
}

TEST(a_loop_farther_down_leaves_the_trees_on_it_open_and_is_not_a_loop_through_the_tree_being_read) {
  const TreeData root = tree("root", {step("idea", "a"), step("other", "leaf")});
  const TreeData a = tree("a", {step("to-b", "b")});
  const TreeData b = tree("b", {step("to-a", "a")});
  const TreeData leaf = tree("leaf", {step("l", "root")});

  const OpenedTrees opened(root, standing({root, a, b, leaf}));

  CHECK(opened.openings == (std::map<NodeId, Opening>{{nid("idea"), {tid("a"), false, "Tree a", false, 0, 1, false}},
                                                      {nid("other"), {tid("leaf"), false, "Tree leaf", false, 0, 1, true}}}));
}

TEST(the_same_trees_in_another_order_give_the_same_answer) {
  const auto answer = [](const std::vector<std::string>& ids, bool reversed) {
    std::vector<NodeSpec> rootNodes{step("to-first", ids[0]), step("to-loop", ids[3]), step("plain")};
    std::vector<NodeSpec> firstNodes{step("x"), step("down", ids[1]), step("gone", "t_removed")};
    std::vector<NodeSpec> secondNodes{step("down", ids[2]), step("y")};
    if (reversed)
      for (std::vector<NodeSpec>* nodes : {&rootNodes, &firstNodes, &secondNodes}) std::reverse(nodes->begin(), nodes->end());
    const TreeData root = tree("root", rootNodes);
    const std::vector<TreeData> trees{root, tree(ids[0], firstNodes), tree(ids[1], secondNodes), tree(ids[2], {step("z")}),
                                      tree(ids[3], {step("back", ids[4])}), tree(ids[4], {step("back", ids[3])})};
    const OpenedTrees opened(
        root, standing(trees, {{ids[0], marks({"x", "gone"})}, {ids[1], marks({"y"})}, {ids[2], marks({"z"})}}));
    std::vector<Opening> byNode;
    for (const char* node : {"to-first", "to-loop"}) {
      Opening opening = opened.openings.at(nid(node));
      opening.tree = TreeId{};
      opening.title.clear();
      byNode.push_back(opening);
    }
    return std::make_pair(byNode, opened.followed(marks({"plain", "to-loop"})).completed);
  };

  const auto expected = std::make_pair(
      std::vector<Opening>{{TreeId{}, false, "", true, 3, 3, false}, {TreeId{}, false, "", false, 0, 1, false}},
      std::set<NodeId>{nid("plain"), nid("to-first")});
  CHECK(answer({"a", "b", "c", "d", "e"}, false) == expected);
  CHECK(answer({"e", "d", "c", "b", "a"}, false) == expected);
  CHECK(answer({"c", "e", "a", "d", "b"}, true) == expected);
}

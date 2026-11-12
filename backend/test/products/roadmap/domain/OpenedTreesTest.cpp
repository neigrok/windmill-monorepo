#include "products/roadmap/domain/OpenedTrees.h"
#include "products/roadmap/domain/UnlockRules.h"
#include "test/testing.h"

#include <algorithm>
#include <functional>
#include <map>
#include <random>
#include <set>
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
OpenedTrees opened(const std::vector<TreeData>& trees, const std::map<std::string, Progress>& marked = {}) {
  std::map<TreeId, OpenedTree> standing;
  for (const TreeData& data : trees) {
    const auto own = marked.find(data.id.str());
    standing.emplace(data.id, OpenedTree(data, own == marked.end() ? Progress{} : own->second));
  }
  return OpenedTrees(std::move(standing));
}


// What is wrong with a tree's pointers, read off the pointers the tree holds.
PointerDiagnostics diagnosed(const OpenedTrees& judged, const TreeData& data) {
  std::map<NodeId, TreeId> pointers;
  for (const NodeSpec& node : data.nodes)
    if (!node.opens.empty()) pointers.emplace(node.id, node.opens);
  return judged.diagnose(data.id, pointers);
}

TreeOnLoop on(const std::string& id) { return {tid(id), "Tree " + id}; }

}

TEST(an_opened_tree_counts_its_nodes_the_marks_on_plain_ones_and_its_pointers_by_the_tree_they_open) {
  const TreeData data = tree("a", {step("plain-done"), step("plain"), step("first-done", "b"), step("second", "b"),
                                   step("other", "c")});

  const OpenedTree counted(data, marks({"plain-done", "first-done", "ghost"}));

  OpenedTree expected;
  expected.title = "Tree a";
  expected.total = 5;
  expected.marked = 1;
  expected.pointers = {{tid("b"), {2, 1}}, {tid("c"), {1, 0}}};
  CHECK(counted == expected);
  CHECK(treesOpenedBy(data) == (std::set<TreeId>{tid("b"), tid("c")}));
}

TEST(a_node_is_complete_when_the_tree_it_opens_is_complete_and_open_until_then) {
  const TreeData root = tree("root", {step("idea", "sub")});
  const TreeData sub = tree("sub", {step("s1"), step("s2")});

  const OpenedTrees halfway = opened({root, sub}, {{"sub", marks({"s1"})}});
  CHECK(halfway.openings(root) == (std::map<NodeId, Opening>{{nid("idea"), {tid("sub"), false, "Tree sub", false, 1, 2}}}));
  CHECK(halfway.followed(root, Progress{}).completed == std::set<NodeId>{});

  const OpenedTrees finished = opened({root, sub}, {{"sub", marks({"s1", "s2"})}});
  CHECK(finished.openings(root) == (std::map<NodeId, Opening>{{nid("idea"), {tid("sub"), false, "Tree sub", true, 2, 2}}}));
  CHECK(finished.followed(root, Progress{}).completed == std::set<NodeId>{nid("idea")});
}

TEST(the_nodes_that_follow_a_tree_are_those_whose_pointer_names_a_standing_tree) {
  const TreeData root = tree("root", {step("idea", "sub"), step("lost", "gone"), step("again", "root"), step("plain")});
  const TreeData sub = tree("sub", {step("s")});
  const std::map<NodeId, TreeId> pointers{{nid("idea"), tid("sub")}, {nid("lost"), tid("gone")}, {nid("again"), tid("root")}};

  CHECK(opened({root, sub}).following(pointers) == (std::set<NodeId>{nid("again"), nid("idea")}));
  CHECK(opened({sub}).following(pointers) == std::set<NodeId>{nid("idea")});
  CHECK(opened({}).following(pointers) == std::set<NodeId>{});
}

// A door's mark is judged off the pointers alone, and comes to what a read of the whole tree comes to.
TEST(the_completed_set_followed_from_a_trees_pointers_is_the_one_followed_from_the_tree) {
  const TreeData root = tree("root", {step("done", "sub"), step("open", "half"), step("lost", "gone"), step("plain")});
  const TreeData sub = tree("sub", {step("s")});
  const TreeData half = tree("half", {step("h")});
  const std::map<NodeId, TreeId> pointers{{nid("done"), tid("sub")}, {nid("open"), tid("half")}, {nid("lost"), tid("gone")}};
  const Progress marked = marks({"open", "lost", "plain"});

  const OpenedTrees standing = opened({root, sub, half}, {{"sub", marks({"s"})}});

  CHECK(standing.followed(pointers, marked).completed == (std::set<NodeId>{nid("done"), nid("lost"), nid("plain")}));
  CHECK(standing.followed(root, marked).completed == standing.followed(pointers, marked).completed);
}

TEST(two_trees_that_open_each_other_are_never_complete) {
  const TreeData a = tree("a", {step("to-b", "b")});
  const TreeData b = tree("b", {step("to-a", "a"), step("done")});

  const OpenedTrees both = opened({a, b}, {{"a", marks({"to-b"})}, {"b", marks({"to-a", "done"})}});

  CHECK(both.openings(a) == (std::map<NodeId, Opening>{{nid("to-b"), {tid("b"), false, "Tree b", false, 1, 2}}}));
  CHECK(both.followed(a, marks({"to-b"})).completed == std::set<NodeId>{});
  CHECK(both.openings(b) == (std::map<NodeId, Opening>{{nid("to-a"), {tid("a"), false, "Tree a", false, 0, 1}}}));
  CHECK(both.followed(b, marks({"to-a", "done"})).completed == std::set<NodeId>{nid("done")});
  CHECK(both.leadingBackTo(tid("a")) == (std::set<TreeId>{tid("a"), tid("b")}));
}

TEST(a_tree_that_opens_itself_is_never_complete) {
  const TreeData self = tree("self", {step("again", "self"), step("done")});

  const OpenedTrees alone = opened({self}, {{"self", marks({"again", "done"})}});

  CHECK(alone.openings(self) == (std::map<NodeId, Opening>{{nid("again"), {tid("self"), false, "Tree self", false, 1, 2}}}));
  CHECK(alone.followed(self, marks({"again", "done"})).completed == std::set<NodeId>{nid("done")});
  CHECK(alone.leadingBackTo(tid("self")) == std::set<TreeId>{tid("self")});
}

TEST(an_empty_tree_is_not_complete) {
  const TreeData root = tree("root", {step("idea", "empty")});
  const TreeData empty = tree("empty", {});

  const OpenedTrees both = opened({root, empty});

  CHECK(both.openings(root) == (std::map<NodeId, Opening>{{nid("idea"), {tid("empty"), false, "Tree empty", false, 0, 0}}}));
  CHECK(both.followed(root, marks({"idea"})).completed == std::set<NodeId>{});
}

TEST(a_chain_of_any_length_completes_from_the_mark_at_its_end_and_a_loop_of_any_length_never_does) {
  const auto link = [](int k) { return "t" + std::to_string(100 + k); };
  std::vector<TreeData> chain;
  for (int k = 0; k < 40; ++k) chain.push_back(tree(link(k), {step("n", k < 39 ? link(k + 1) : "")}));

  const OpenedTrees unmarked = opened(chain);
  CHECK(unmarked.openings(chain.front()) ==
        (std::map<NodeId, Opening>{{nid("n"), {tid(link(1)), false, "Tree " + link(1), false, 0, 1}}}));
  const OpenedTrees marked = opened(chain, {{link(39), marks({"n"})}});
  CHECK(marked.openings(chain.front()) ==
        (std::map<NodeId, Opening>{{nid("n"), {tid(link(1)), false, "Tree " + link(1), true, 1, 1}}}));
  CHECK(marked.leadingBackTo(tid(link(0))) == std::set<TreeId>{tid(link(0))});

  std::vector<TreeData> ring = chain;
  ring.back().nodes = {step("n", link(0)), step("plain")};
  std::map<std::string, Progress> everyNodeMarked;
  std::set<TreeId> everyTree;
  for (int k = 0; k < 40; ++k) {
    everyNodeMarked[link(k)] = marks({"n", "plain"});
    everyTree.insert(tid(link(k)));
  }
  const OpenedTrees looped = opened(ring, everyNodeMarked);
  CHECK(looped.openings(ring.front()) ==
        (std::map<NodeId, Opening>{{nid("n"), {tid(link(1)), false, "Tree " + link(1), false, 0, 1}}}));
  CHECK(looped.followed(ring.back(), marks({"n", "plain"})).completed == std::set<NodeId>{nid("plain")});
  CHECK(looped.leadingBackTo(tid(link(0))) == everyTree);
}

TEST(a_tree_opened_from_two_nodes_and_along_two_ways_is_judged_once_and_is_no_loop) {
  const TreeData root = tree("root", {step("left", "a"), step("right", "b"), step("direct", "shared"), step("twice", "shared")});
  const TreeData a = tree("a", {step("down", "shared")});
  const TreeData b = tree("b", {step("down", "shared"), step("own")});
  const TreeData shared = tree("shared", {step("s")});

  const OpenedTrees all = opened({root, a, b, shared}, {{"shared", marks({"s"})}, {"b", marks({"own"})}});

  CHECK(all.openings(root) == (std::map<NodeId, Opening>{{nid("left"), {tid("a"), false, "Tree a", true, 1, 1}},
                                                         {nid("right"), {tid("b"), false, "Tree b", true, 2, 2}},
                                                         {nid("direct"), {tid("shared"), false, "Tree shared", true, 1, 1}},
                                                         {nid("twice"), {tid("shared"), false, "Tree shared", true, 1, 1}}}));
  CHECK(all.followed(root, Progress{}).completed == (std::set<NodeId>{nid("left"), nid("right"), nid("direct"), nid("twice")}));
  CHECK(all.leadingBackTo(tid("root")) == std::set<TreeId>{tid("root")});
  CHECK_EQ(all.walked(), 5u);
}

TEST(a_mark_on_a_node_with_a_valid_pointer_is_ignored_and_one_on_a_node_with_an_invalid_pointer_counts) {
  const TreeData root = tree("root", {step("valid", "sub"), step("gone", "t_removed"), step("gone-unmarked", "t_removed"), step("plain")});
  const TreeData sub = tree("sub", {step("s")});

  const OpenedTrees both = opened({root, sub});

  CHECK(both.openings(root) == (std::map<NodeId, Opening>{{nid("valid"), {tid("sub"), false, "Tree sub", false, 0, 1}},
                                                          {nid("gone"), {tid("t_removed"), true}},
                                                          {nid("gone-unmarked"), {tid("t_removed"), true}}}));
  CHECK(both.followed(root, marks({"valid", "gone", "plain", "ghost"})).completed ==
        (std::set<NodeId>{nid("gone"), nid("plain"), nid("ghost")}));
}

TEST(a_node_whose_tree_is_complete_is_complete_though_its_prerequisites_are_not_and_the_step_waiting_on_it_unlocks) {
  const TreeData root = tree("root", {step("first"), step("idea", "sub", {nid("first")}), step("after", "", {nid("idea")}),
                                      step("later", "", {nid("after")})});
  const TreeData sub = tree("sub", {step("s")});

  CHECK(UnlockRules::derive(root.nodes, opened({root, sub}).followed(root, marks({"idea"}))) ==
        (std::map<NodeId, NodeState>{{nid("first"), NodeState::available}, {nid("idea"), NodeState::locked},
                                     {nid("after"), NodeState::locked}, {nid("later"), NodeState::locked}}));
  CHECK(UnlockRules::derive(root.nodes, opened({root, sub}, {{"sub", marks({"s"})}}).followed(root, Progress{})) ==
        (std::map<NodeId, NodeState>{{nid("first"), NodeState::available}, {nid("idea"), NodeState::complete},
                                     {nid("after"), NodeState::available}, {nid("later"), NodeState::locked}}));
}

TEST(done_counts_a_nested_node_by_the_tree_it_opens) {
  const TreeData root = tree("root", {step("idea", "mid")});
  const TreeData mid = tree("mid", {step("marked"), step("unmarked"), step("to-complete", "leaf-done"),
                                    step("to-open", "leaf-open"), step("to-removed", "t_removed"),
                                    step("to-removed-unmarked", "t_removed")});
  const TreeData leafDone = tree("leaf-done", {step("l")});
  const TreeData leafOpen = tree("leaf-open", {step("l")});

  const OpenedTrees all = opened({root, mid, leafDone, leafOpen},
                                 {{"mid", marks({"marked", "to-open", "to-removed"})}, {"leaf-done", marks({"l"})}});

  CHECK(all.openings(root) == (std::map<NodeId, Opening>{{nid("idea"), {tid("mid"), false, "Tree mid", false, 3, 6}}}));
}

TEST(the_trees_that_lead_back_to_a_tree_are_found_at_any_distance_and_a_loop_elsewhere_is_not_among_them) {
  std::vector<TreeData> trees{tree("root", {step("far", "back1"), step("near", "leaf"), step("elsewhere", "x")}),
                              tree("leaf", {step("l")}), tree("x", {step("to-y", "y")}), tree("y", {step("to-x", "x")})};
  std::set<TreeId> leading{tid("root")};
  for (int k = 1; k <= 12; ++k) {
    const std::string name = "back" + std::to_string(k);
    trees.push_back(tree(name, {step("on", k < 12 ? "back" + std::to_string(k + 1) : "root")}));
    leading.insert(tid(name));
  }

  const OpenedTrees all = opened(trees);

  CHECK(all.leadingBackTo(tid("root")) == leading);
  CHECK(all.leadingBackTo(tid("leaf")) == (std::set<TreeId>{tid("leaf"), tid("root"), tid("back1"), tid("back2"), tid("back3"),
                                                            tid("back4"), tid("back5"), tid("back6"), tid("back7"), tid("back8"),
                                                            tid("back9"), tid("back10"), tid("back11"), tid("back12")}));
  CHECK(all.leadingBackTo(tid("t_removed")) == std::set<TreeId>{});
}

TEST(the_completeness_pass_walks_each_pointer_once_on_an_account_whose_trees_each_open_every_later_one) {
  const auto name = [](int k) { return "t" + std::to_string(1000 + k); };
  std::vector<TreeData> trees;
  std::map<std::string, Progress> plainMarked;
  for (int k = 0; k < 300; ++k) {
    std::vector<NodeSpec> nodes{step("plain")};
    for (int later = k + 1; later < 300; ++later) nodes.push_back(step("to-" + name(later), name(later)));
    trees.push_back(tree(name(k), nodes));
    plainMarked[name(k)] = marks({"plain"});
  }

  const OpenedTrees complete = opened(trees, plainMarked);
  CHECK_EQ(complete.walked(), 300u * 299u / 2u);
  CHECK_EQ(complete.followed(trees.front(), marks({"plain"})).completed.size(), 300u);

  plainMarked.erase(name(299));
  const OpenedTrees stalled = opened(trees, plainMarked);
  CHECK_EQ(stalled.walked(), 0u);
  CHECK(stalled.followed(trees.front(), marks({"plain"})).completed == std::set<NodeId>{nid("plain")});
}

// The rule enumerated: the complete trees are those in every set closed under "has a node, and each is complete".
TEST(random_accounts_agree_with_the_rule_enumerated_over_every_set_of_their_trees) {
  std::mt19937 random(20261112);
  const auto below = [&](unsigned bound) { return static_cast<unsigned>(random() % bound); };
  int disagreements = 0;
  for (int account = 0; account < 600; ++account) {
    const unsigned count = 1 + below(9);
    const unsigned pointerPercent = std::vector<unsigned>{20, 45, 75}[below(3)];
    const unsigned markPercent = std::vector<unsigned>{100, 90, 60}[below(3)];
    std::vector<std::string> ids;
    std::map<TreeId, unsigned> index;
    for (unsigned t = 0; t < count; ++t) {
      ids.push_back(std::string(1, static_cast<char>('a' + below(26))) + std::to_string(t));
      index[tid(ids.back())] = t;
    }
    std::vector<TreeData> trees;
    std::map<std::string, Progress> marked;
    for (unsigned t = 0; t < count; ++t) {
      std::vector<NodeSpec> nodes;
      std::vector<std::string> done;
      const unsigned nodeCount = below(5);
      for (unsigned n = 0; n < nodeCount; ++n) {
        std::string opens;
        if (below(100) < pointerPercent) opens = below(100) < 85 ? ids[below(count)] : "t_removed";
        nodes.push_back(step("n" + std::to_string(n), opens));
        if (below(100) < markPercent) done.push_back("n" + std::to_string(n));
      }
      trees.push_back(tree(ids[t], nodes));
      marked[ids[t]] = marks(done);
    }

    const auto nodeComplete = [&](unsigned among, const TreeData& data, const NodeSpec& node) {
      const auto target = index.find(node.opens);
      if (target == index.end()) return marked.at(data.id.str()).completed.count(node.id) > 0;
      return ((among >> target->second) & 1u) != 0;
    };
    unsigned least = (1u << count) - 1;
    for (unsigned among = 0; among < (1u << count); ++among) {
      bool closed = true;
      for (unsigned t = 0; t < count && closed; ++t) {
        const bool complete = !trees[t].nodes.empty() &&
                              std::all_of(trees[t].nodes.begin(), trees[t].nodes.end(),
                                          [&](const NodeSpec& node) { return nodeComplete(among, trees[t], node); });
        closed = !complete || ((among >> t) & 1u);
      }
      if (closed) least &= among;
    }
    const auto leadsTo = [&](unsigned from, unsigned target) {
      std::set<unsigned> seen;
      std::vector<unsigned> reached{from};
      while (!reached.empty()) {
        const unsigned at = reached.back();
        reached.pop_back();
        if (at == target) return true;
        if (!seen.insert(at).second) continue;
        for (const NodeSpec& node : trees[at].nodes)
          if (index.count(node.opens)) reached.push_back(index.at(node.opens));
      }
      return false;
    };

    const OpenedTrees judged = opened(trees, marked);
    for (unsigned t = 0; t < count; ++t) {
      std::set<NodeId> completed;
      std::map<NodeId, Opening> openings;
      std::set<TreeId> leading;
      for (unsigned other = 0; other < count; ++other)
        if (leadsTo(other, t)) leading.insert(trees[other].id);
      for (const NodeSpec& node : trees[t].nodes) {
        if (nodeComplete(least, trees[t], node)) completed.insert(node.id);
        if (node.opens.empty()) continue;
        if (!index.count(node.opens)) {
          openings.emplace(node.id, Opening{node.opens, true});
          continue;
        }
        const unsigned target = index.at(node.opens);
        const int done = static_cast<int>(std::count_if(
            trees[target].nodes.begin(), trees[target].nodes.end(),
            [&](const NodeSpec& inner) { return nodeComplete(least, trees[target], inner); }));
        openings.emplace(node.id, Opening{node.opens, false, trees[target].title, ((least >> target) & 1u) != 0, done,
                                          static_cast<int>(trees[target].nodes.size())});
      }
      if (judged.followed(trees[t], marked.at(trees[t].id.str())).completed != completed) ++disagreements;
      if (judged.openings(trees[t]) != openings) ++disagreements;
      if (judged.leadingBackTo(trees[t].id) != leading) ++disagreements;
    }
  }
  CHECK_EQ(disagreements, 0);
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
    const OpenedTrees all =
        opened(trees, {{ids[0], marks({"x", "gone"})}, {ids[1], marks({"y"})}, {ids[2], marks({"z"})}});
    const std::map<NodeId, Opening> openings = all.openings(root);
    std::vector<Opening> byNode;
    for (const char* node : {"to-first", "to-loop"}) {
      Opening opening = openings.at(nid(node));
      opening.tree = TreeId{};
      opening.title.clear();
      byNode.push_back(opening);
    }
    return std::make_pair(byNode, all.followed(root, marks({"plain", "to-loop"})).completed);
  };

  const auto expected = std::make_pair(std::vector<Opening>{{TreeId{}, false, "", true, 3, 3}, {TreeId{}, false, "", false, 0, 1}},
                                       std::set<NodeId>{nid("plain"), nid("to-first")});
  CHECK(answer({"a", "b", "c", "d", "e"}, false) == expected);
  CHECK(answer({"e", "d", "c", "b", "a"}, false) == expected);
  CHECK(answer({"c", "e", "a", "d", "b"}, true) == expected);
}

TEST(two_trees_that_open_each_other_are_each_told_their_own_way_back) {
  const TreeData a = tree("a", {step("to-b", "b"), step("plain")});
  const TreeData b = tree("b", {step("to-a", "a")});

  const OpenedTrees both = opened({a, b});

  CHECK(diagnosed(both, a) == (PointerDiagnostics{{{nid("to-b"), {on("b"), on("a")}}}, 0, {}, 0}));
  CHECK(diagnosed(both, b) == (PointerDiagnostics{{{nid("to-a"), {on("a"), on("b")}}}, 0, {}, 0}));
}

TEST(a_tree_that_opens_itself_is_told_a_way_back_of_itself_alone) {
  const TreeData self = tree("self", {step("again", "self"), step("done")});

  CHECK(diagnosed(opened({self}), self) == (PointerDiagnostics{{{nid("again"), {on("self")}}}, 0, {}, 0}));
}

TEST(a_loop_of_four_is_told_its_shortest_way_back_and_between_two_as_short_the_one_by_tree_id) {
  const TreeData root = tree("root", {step("round", "a"), step("short", "d")});
  const TreeData a = tree("a", {step("to-long", "long1"), step("to-c", "c"), step("to-b", "b")});
  const TreeData b = tree("b", {step("on", "d")});
  const TreeData c = tree("c", {step("on", "d")});
  const TreeData d = tree("d", {step("back", "root")});
  const TreeData long1 = tree("long1", {step("on", "long2")});
  const TreeData long2 = tree("long2", {step("on", "long3")});
  const TreeData long3 = tree("long3", {step("back", "root")});

  const OpenedTrees all = opened({root, a, b, c, d, long1, long2, long3});

  CHECK(diagnosed(all, root) ==
        (PointerDiagnostics{{{nid("round"), {on("a"), on("b"), on("d"), on("root")}}, {nid("short"), {on("d"), on("root")}}}, 0, {}, 0}));
  CHECK(diagnosed(all, long2) ==
        (PointerDiagnostics{{{nid("on"), {on("long3"), on("root"), on("a"), on("long1"), on("long2")}}}, 0, {}, 0}));
}

// Two ways as short that part at the second tree, and two that part at the third: the smaller id at the first place
// they differ, whatever comes after it.
TEST(between_two_ways_as_short_the_smaller_tree_id_is_taken_at_the_first_place_they_differ) {
  const std::vector<TreeData> second{tree("t", {step("n", "s")}), tree("s", {step("1", "c"), step("2", "b")}),
                                     tree("b", {step("1", "z")}), tree("c", {step("1", "a")}),
                                     tree("z", {step("1", "t")}), tree("a", {step("1", "t")})};
  CHECK(diagnosed(opened(second), second.front()) ==
        (PointerDiagnostics{{{nid("n"), {on("s"), on("b"), on("z"), on("t")}}}, 0, {}, 0}));

  const std::vector<TreeData> third{tree("t", {step("n", "s")}), tree("s", {step("1", "m")}),
                                    tree("m", {step("1", "y"), step("2", "x")}), tree("x", {step("1", "q")}),
                                    tree("y", {step("1", "p")}), tree("q", {step("1", "t")}), tree("p", {step("1", "t")})};
  CHECK(diagnosed(opened(third), third.front()) ==
        (PointerDiagnostics{{{nid("n"), {on("s"), on("m"), on("x"), on("q"), on("t")}}}, 0, {}, 0}));
}

TEST(a_loop_among_other_trees_is_not_this_trees) {
  const TreeData root = tree("root", {step("down", "x"), step("leaf", "plain")});
  const TreeData x = tree("x", {step("to-y", "y")});
  const TreeData y = tree("y", {step("to-x", "x")});
  const TreeData plain = tree("plain", {step("p")});

  const OpenedTrees all = opened({root, x, y, plain});

  CHECK(diagnosed(all, root) == PointerDiagnostics{});
  CHECK(diagnosed(all, x) == (PointerDiagnostics{{{nid("to-y"), {on("y"), on("x")}}}, 0, {}, 0}));
}

TEST(two_nodes_of_one_tree_on_the_same_loop_are_two_entries_in_node_id_order) {
  const TreeData root = tree("root", {step("second", "sub"), step("plain"), step("first", "sub")});
  const TreeData sub = tree("sub", {step("back", "root")});

  CHECK(diagnosed(opened({root, sub}), root) ==
        (PointerDiagnostics{{{nid("first"), {on("sub"), on("root")}}, {nid("second"), {on("sub"), on("root")}}}, 0, {}, 0}));
}

// The owner's standing trees are all a pointer may name, so a removed tree, someone else's and free text read alike.
TEST(a_pointer_at_a_removed_tree_at_someone_elses_and_at_free_text_dangles_and_a_valid_one_does_not) {
  const TreeData root = tree("root", {step("removed", "t_removed"), step("valid", "sub"), step("theirs", "t_theirs"),
                                      step("text", "not a tree id, \"quoted\""), step("plain")});
  const TreeData sub = tree("sub", {step("gone-below", "t_removed")});

  const OpenedTrees mine = opened({root, sub});

  CHECK(diagnosed(mine, root) == (PointerDiagnostics{{},
                                                     0,
                                                     {{nid("removed"), tid("t_removed")},
                                                      {nid("text"), tid("not a tree id, \"quoted\"")},
                                                      {nid("theirs"), tid("t_theirs")}},
                                                     0}));
  CHECK(diagnosed(mine, sub) == (PointerDiagnostics{{}, 0, {{nid("gone-below"), tid("t_removed")}}, 0}));
}

// A tree that does not stand among the owner's is on no loop, whatever its nodes name.
TEST(a_tree_that_is_not_among_the_standing_ones_is_told_no_loop) {
  const TreeData stray = tree("stray", {step("to-a", "a"), step("again", "stray")});
  const TreeData a = tree("a", {step("to-stray", "stray")});

  CHECK(diagnosed(opened({a}), stray) == (PointerDiagnostics{{}, 0, {{nid("again"), tid("stray")}}, 0}));
}

TEST(the_same_account_in_another_order_is_told_the_same_loops_and_dangling_pointers) {
  const auto answer = [](bool reversed) {
    std::vector<std::vector<NodeSpec>> nodes{
        {step("round", "a"), step("gone", "t_removed"), step("short", "d"), step("again", "root"), step("plain")},
        {step("to-c", "c"), step("to-b", "b"), step("x")},
        {step("on", "d")},
        {step("on", "d"), step("y")},
        {step("back", "root"), step("side", "a")}};
    if (reversed)
      for (std::vector<NodeSpec>& held : nodes) std::reverse(held.begin(), held.end());
    std::vector<TreeData> trees{tree("root", nodes[0]), tree("a", nodes[1]), tree("b", nodes[2]), tree("c", nodes[3]),
                                tree("d", nodes[4])};
    if (reversed) std::reverse(trees.begin(), trees.end());
    return diagnosed(opened(trees), reversed ? trees.back() : trees.front());
  };

  const PointerDiagnostics expected{{{nid("again"), {on("root")}},
                                     {nid("round"), {on("a"), on("b"), on("d"), on("root")}},
                                     {nid("short"), {on("d"), on("root")}}},
                                    0,
                                    {{nid("gone"), tid("t_removed")}},
                                    0};
  CHECK(answer(false) == expected);
  CHECK(answer(true) == expected);
}

// A way of eight trees is listed whole and ends with the node's own tree. A longer one is cut to the eight nearest
// the node, the tree it opens first, and counts the trees left off, the node's own tree the last of them.
TEST(a_way_back_lists_its_first_eight_trees_and_counts_the_rest) {
  const auto ring = [](int trees) {
    std::vector<TreeData> account;
    for (int k = 0; k < trees; ++k) account.push_back(tree("r" + std::to_string(10 + k), {step("next", "r" + std::to_string(10 + (k + 1) % trees))}));
    return account;
  };

  const std::vector<TreeData> eight = ring(8);
  CHECK(diagnosed(opened(eight), eight.front()) ==
        (PointerDiagnostics{{{nid("next"), {on("r11"), on("r12"), on("r13"), on("r14"), on("r15"), on("r16"), on("r17"), on("r10")}}},
                            0, {}, 0}));

  const std::vector<TreeOnLoop> firstEight{on("r11"), on("r12"), on("r13"), on("r14"), on("r15"), on("r16"), on("r17"), on("r18")};
  const std::vector<TreeData> nine = ring(9);
  CHECK(diagnosed(opened(nine), nine.front()) == (PointerDiagnostics{{{nid("next"), firstEight, 1}}, 0, {}, 0}));
  const std::vector<TreeData> forty = ring(40);
  CHECK(diagnosed(opened(forty), forty.front()) == (PointerDiagnostics{{{nid("next"), firstEight, 32}}, 0, {}, 0}));
}

// Each list holds its first fifty by node id and counts the rest, so what is built follows the caps and not the tree:
// ten thousand nodes on one loop of a hundred trees are fifty entries of eight trees.
TEST(the_lists_hold_their_first_fifty_by_node_id_and_count_the_rest_whatever_the_tree_holds) {
  const auto name = [](const char* prefix, int k) { return prefix + std::to_string(100000 + k); };
  std::vector<NodeSpec> nodes;
  for (int k = 0; k < 10000; ++k) nodes.push_back(step(name("loop", k), "w100"));
  for (int k = 0; k < 300; ++k) nodes.push_back(step(name("gone", k), "t_removed" + std::to_string(k)));
  std::reverse(nodes.begin(), nodes.end());
  std::vector<TreeData> account{tree("root", nodes)};
  for (int k = 0; k < 100; ++k) account.push_back(tree("w" + std::to_string(100 + k), {step("next", k < 99 ? "w" + std::to_string(101 + k) : "root")}));

  const PointerDiagnostics told = diagnosed(opened(account), account.front());

  PointerDiagnostics expected;
  for (int k = 0; k < 50; ++k) {
    expected.treeLoops.push_back({nid(name("loop", k)), {on("w100"), on("w101"), on("w102"), on("w103"), on("w104"), on("w105"), on("w106"), on("w107")}, 93});
    expected.danglingPointers.push_back({nid(name("gone", k)), tid("t_removed" + std::to_string(k))});
  }
  expected.treeLoopsOmitted = 9950;
  expected.danglingPointersOmitted = 250;
  CHECK(told == expected);
}

// The walk back reads each pointer between two standing trees once, whatever the asked tree's nodes and however long
// their ways: on an account where every tree on the way also opens every tree the asked tree opens, all of them
// farther from it and sorted before the next tree on the way, it is the account's pointers and no more.
TEST(the_walk_back_reads_each_pointer_between_standing_trees_once_on_an_account_full_of_decoys) {
  const auto far = [](int k) { return "a" + std::to_string(1000 + k); };
  const auto way = [](int k) { return "c" + std::to_string(1000 + k); };
  const auto account = [&](int size) {
    std::vector<TreeData> trees;
    std::vector<NodeSpec> own;
    for (int n = 0; n < size; ++n) own.push_back(step("n" + std::to_string(1000 + n), far(n)));
    trees.push_back(tree("z", own));
    for (int n = 0; n < size; ++n) trees.push_back(tree(far(n), {step("in", way(1))}));
    for (int k = 1; k <= size; ++k) {
      std::vector<NodeSpec> held;
      for (int n = 0; n < size; ++n) held.push_back(step("d" + std::to_string(n), far(n)));
      held.push_back(step("next", k == size ? "z" : way(k + 1)));
      trees.push_back(tree(way(k), held));
    }
    return trees;
  };

  for (const int size : {20, 40, 80}) {
    const std::vector<TreeData> trees = account(size);
    const OpenedTrees judged = opened(trees);

    const WaysBack back = judged.waysBackTo(tid("z"));
    CHECK_EQ(back.walked, static_cast<std::size_t>(size * size + 3 * size));
    CHECK_EQ(back.ways.size(), static_cast<std::size_t>(2 * size + 1));
    CHECK_EQ(back.ways.at(tid(far(0))).pointers, size + 1);
    CHECK_EQ(back.ways.at(tid(far(0))).next, tid(way(1)));

    const PointerDiagnostics told = diagnosed(judged, trees.front());
    CHECK_EQ(told.treeLoops.size(), static_cast<std::size_t>(std::min(size, 50)));
    CHECK_EQ(told.treeLoopsOmitted, static_cast<std::size_t>(std::max(size - 50, 0)));
    CHECK(told.treeLoops.front() ==
          (TreeLoop{nid("n1000"), {on(far(0)), on(way(1)), on(way(2)), on(way(3)), on(way(4)), on(way(5)), on(way(6)), on(way(7))},
                    static_cast<std::size_t>(size + 2 - 8)}));
  }
}

TEST(the_pointers_an_edit_set_are_the_ones_the_tree_holds_now_and_did_not_hold_before) {
  const std::map<NodeId, TreeId> before{{nid("kept"), tid("a")}, {nid("moved"), tid("a")}, {nid("cleared"), tid("a")}};
  const std::map<NodeId, TreeId> after{{nid("kept"), tid("a")}, {nid("moved"), tid("b")}, {nid("new"), tid("a")}};

  CHECK(pointersSetSince(before, after) == (std::map<NodeId, TreeId>{{nid("moved"), tid("b")}, {nid("new"), tid("a")}}));
  CHECK(treesOpenedBy(after) == (std::set<TreeId>{tid("a"), tid("b")}));
}

// The way back enumerated: of every way from the opened tree to the node's own that passes no tree twice, the
// shortest, and of those the first by tree id; then the caps.
TEST(random_accounts_are_told_the_way_back_that_an_enumeration_of_every_way_finds) {
  std::mt19937 random(20261113);
  const auto below = [&](unsigned bound) { return static_cast<unsigned>(random() % bound); };
  int disagreements = 0;
  int loops = 0;
  int cut = 0;
  for (int account = 0; account < 600; ++account) {
    const unsigned count = 1 + below(11);
    std::vector<std::string> ids;
    for (unsigned t = 0; t < count; ++t) ids.push_back(std::string(1, static_cast<char>('a' + below(26))) + std::to_string(t));
    std::vector<TreeData> trees;
    std::map<TreeId, const TreeData*> byId;
    // One account in four is a ring with a few shortcuts, so some ways back are longer than a path lists.
    const bool ring = below(4) == 0;
    for (unsigned t = 0; t < count; ++t) {
      std::vector<NodeSpec> nodes;
      const unsigned nodeCount = ring ? 0 : below(4);
      for (unsigned n = 0; n < nodeCount; ++n) {
        std::string opens;
        if (below(100) < 60) opens = below(100) < 85 ? ids[below(count)] : "t_removed";
        nodes.push_back(step("n" + std::to_string(n), opens));
      }
      if (ring) nodes.push_back(step("next", ids[(t + 1) % count]));
      if (ring && below(100) < 10) nodes.push_back(step("shortcut", ids[below(count)]));
      trees.push_back(tree(ids[t], nodes));
    }
    for (const TreeData& data : trees) byId[data.id] = &data;

    const std::function<void(const TreeId&, const TreeId&, std::vector<TreeId>&, std::vector<std::vector<TreeId>>&)> walk =
        [&](const TreeId& at, const TreeId& home, std::vector<TreeId>& way, std::vector<std::vector<TreeId>>& ways) {
          way.push_back(at);
          if (at == home) {
            ways.push_back(way);
          } else {
            for (const TreeId& next : treesOpenedBy(*byId.at(at)))
              if (byId.count(next) && std::find(way.begin(), way.end(), next) == way.end()) walk(next, home, way, ways);
          }
          way.pop_back();
        };

    const OpenedTrees judged = opened(trees);
    for (const TreeData& data : trees) {
      PointerDiagnostics expected;
      std::map<NodeId, TreeId> pointers;
      for (const NodeSpec& node : data.nodes)
        if (!node.opens.empty()) pointers.emplace(node.id, node.opens);
      for (const auto& [node, target] : pointers) {
        if (!byId.count(target)) {
          expected.danglingPointers.push_back({node, target});
          continue;
        }
        std::vector<TreeId> way;
        std::vector<std::vector<TreeId>> ways;
        walk(target, data.id, way, ways);
        if (ways.empty()) continue;
        const std::vector<TreeId>& best = *std::min_element(
            ways.begin(), ways.end(), [](const std::vector<TreeId>& left, const std::vector<TreeId>& right) {
              return left.size() != right.size() ? left.size() < right.size() : left < right;
            });
        TreeLoop loop{node, {}};
        for (std::size_t listed = 0; listed < std::min(best.size(), kMaxLoopPath); ++listed)
          loop.path.push_back({best[listed], byId.at(best[listed])->title});
        loop.pathOmitted = best.size() - loop.path.size();
        if (loop.pathOmitted > 0) ++cut;
        expected.treeLoops.push_back(loop);
        ++loops;
      }
      if (!(judged.diagnose(data.id, pointers) == expected)) ++disagreements;
    }
  }
  CHECK_EQ(disagreements, 0);
  CHECK(loops > 300);
  CHECK(cut > 0);
}

// What the owner's own reads derive for a step that opens a tree is what a reader is shown of it, and no more: a row
// while the tree is complete, none while it is not, whatever mark the step holds.
TEST(a_reader_is_shown_a_node_that_opens_a_tree_complete_while_that_tree_is_and_with_no_row_while_it_is_not) {
  const TreeData done = tree("done", {step("d")});
  const TreeData open = tree("open", {step("o")});
  const OpenedTrees standing = opened({done, open}, {{"done", marks({"d"})}});
  const std::map<NodeId, TreeId> pointers{
      {nid("done-unmarked"), tid("done")}, {nid("done-marked"), tid("done")}, {nid("done-cleared"), tid("done")},
      {nid("open-unmarked"), tid("open")}, {nid("open-marked"), tid("open")}, {nid("open-cleared"), tid("open")}};
  Progress stored;
  stored.record(nid("done-marked"), ProgressMark{ProgressStatus::complete, Hlc{900, 2, "phone"}, 950, true});
  stored.record(nid("done-cleared"), ProgressMark{ProgressStatus::none, Hlc{901, 0, "phone"}, 951});
  stored.record(nid("open-marked"), ProgressMark{ProgressStatus::complete, Hlc{902, 0, "phone"}, 952, true});
  stored.record(nid("open-cleared"), ProgressMark{ProgressStatus::none, Hlc{903, 0, "phone"}, 953});

  Progress shown;
  shown.record(nid("done-unmarked"), ProgressMark{ProgressStatus::complete, Hlc{}, 0, false});
  shown.record(nid("done-marked"), ProgressMark{ProgressStatus::complete, Hlc{900, 2, "phone"}, 950, false});
  shown.record(nid("done-cleared"), ProgressMark{ProgressStatus::complete, Hlc{}, 0, false});
  CHECK(readerView(stored, pointers, standing) == shown);
}

TEST(a_reader_is_shown_the_stored_row_of_every_node_that_follows_no_tree) {
  const OpenedTrees standing = opened({tree("sub", {step("s")})}, {{"sub", marks({"s"})}});
  const std::map<NodeId, TreeId> pointers{{nid("gone"), tid("gone")}, {nid("cleared-gone"), tid("gone")}};
  Progress stored;
  stored.record(nid("gone"), ProgressMark{ProgressStatus::complete, Hlc{900, 0, "phone"}, 950, true});
  stored.record(nid("cleared-gone"), ProgressMark{ProgressStatus::none, Hlc{901, 0, "phone"}, 951});
  stored.record(nid("plain"), ProgressMark{ProgressStatus::complete, Hlc{902, 0, "phone"}, 952, true});
  stored.record(nid("cleared"), ProgressMark{ProgressStatus::none, Hlc{903, 0, "phone"}, 953});
  stored.record(nid("left-the-tree"), ProgressMark{ProgressStatus::complete, Hlc{904, 0, "phone"}, 954});

  CHECK(readerView(stored, pointers, standing) == stored);
  CHECK(readerView(stored, {}, OpenedTrees({})) == stored);
}

// One rule decides completeness for the owner and for the owner's readers: a chain completes, a loop never does.
TEST(a_reader_is_shown_as_complete_exactly_the_nodes_the_owners_followed_set_holds) {
  const TreeData root = tree("root", {step("chain", "mid"), step("loop", "ring"), step("half", "open"), step("lost", "gone"),
                                      step("plain"), step("unmarked")});
  const TreeData mid = tree("mid", {step("deeper", "leaf")});
  const TreeData leaf = tree("leaf", {step("l")});
  const TreeData ring = tree("ring", {step("back", "root"), step("r")});
  const TreeData open = tree("open", {step("a"), step("b")});
  const OpenedTrees standing =
      opened({root, mid, leaf, ring, open}, {{"leaf", marks({"l"})}, {"ring", marks({"back", "r"})}, {"open", marks({"a"})}});
  const std::map<NodeId, TreeId> pointers = pointersOf(root);
  Progress stored;
  for (const char* marked : {"loop", "half", "lost", "plain"})
    stored.record(nid(marked), ProgressMark{ProgressStatus::complete, Hlc{900, 0, "phone"}, 950});

  const Progress shown = readerView(stored, pointers, standing);

  CHECK(shown.completed == (std::set<NodeId>{nid("chain"), nid("lost"), nid("plain")}));
  CHECK(shown.completed == standing.followed(pointers, stored).completed);
  CHECK(shown.cleared == std::set<NodeId>{});
}

// The owner's trees could not be read, so which pointers are valid is not known: no step that holds one is shown.
TEST(a_reader_is_shown_no_row_for_a_node_that_holds_a_pointer_when_the_owners_trees_were_not_read) {
  const std::map<NodeId, TreeId> pointers{{nid("idea"), tid("sub")}, {nid("lost"), tid("gone")}, {nid("unmarked"), tid("sub")}};
  Progress stored;
  stored.record(nid("idea"), ProgressMark{ProgressStatus::complete, Hlc{900, 0, "phone"}, 950});
  stored.record(nid("lost"), ProgressMark{ProgressStatus::none, Hlc{901, 0, "phone"}, 951});
  stored.record(nid("plain"), ProgressMark{ProgressStatus::complete, Hlc{902, 0, "phone"}, 952, true});

  Progress shown;
  shown.record(nid("plain"), ProgressMark{ProgressStatus::complete, Hlc{902, 0, "phone"}, 952, true});
  CHECK(readerView(stored, pointers, std::nullopt) == shown);
}

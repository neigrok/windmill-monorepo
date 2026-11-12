#include "products/roadmap/domain/OpenedTrees.h"
#include "products/roadmap/domain/UnlockRules.h"
#include "test/testing.h"

#include <algorithm>
#include <map>
#include <random>
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

  CHECK(opened({root, sub}).following(root) == (std::set<NodeId>{nid("again"), nid("idea")}));
  CHECK(opened({sub}).following(root) == std::set<NodeId>{nid("idea")});
  CHECK(opened({}).following(root) == std::set<NodeId>{});
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

#include "products/roadmap/domain/Subtree.h"
#include "test/testing.h"

#include <map>
#include <set>
#include <string>
#include <vector>

using namespace wm;

static NodeId nid(const char* s) { return NodeId{std::string(s)}; }
static TreeId tid(const char* s) { return TreeId{std::string(s)}; }

// Of the steps a write removes, each that owns a subtree its `branches` do not name, in step order: an empty subtree's
// owning step among them, a step that owns none never, and a named subtree's never.
TEST(unconfirmed_branches_are_the_removed_owning_steps_whose_subtrees_go_unnamed) {
  const std::map<NodeId, TreeId> owned{{nid("sail"), tid("t_s")}, {nid("rig"), tid("t_r")}, {nid("swim"), tid("t_w")}};
  CHECK(unconfirmedBranches({nid("swim"), nid("plain"), nid("rig"), nid("sail")}, owned, {tid("t_s")}) ==
        (std::vector<UnconfirmedBranch>{{nid("rig"), tid("t_r")}, {nid("swim"), tid("t_w")}}));
  CHECK(unconfirmedBranches({nid("sail")}, owned, {tid("t_s"), tid("t_elsewhere")}).empty());
  CHECK(unconfirmedBranches({nid("plain")}, owned, {}).empty());
}

// Of the pointers a server-stamped write sends, in the order sent, those that would change the register of a step that
// owns a subtree: another tree than its subtree, an empty one included. An echo of the subtree, the value the register
// already holds, and a pointer on a step that owns none are not refused.
TEST(refused_pointers_are_those_that_would_change_an_owning_steps_register_in_the_order_sent) {
  const std::map<NodeId, TreeId> owned{
      {nid("sail"), tid("t_s")}, {nid("rig"), tid("t_r")}, {nid("swim"), tid("t_w")}, {nid("keel"), tid("t_k")}};
  const std::map<NodeId, TreeId> held{{nid("swim"), tid("t_old")}, {nid("keel"), tid("t_x")}};
  CHECK(refusedPointers({{nid("swim"), tid("")}, {nid("plain"), tid("t_x")}, {nid("rig"), tid("t_r")},
                         {nid("sail"), tid("t_x")}, {nid("keel"), tid("t_x")}},
                        owned, held) == (std::vector<NodeId>{nid("swim"), nid("sail")}));
  CHECK(refusedPointers({}, owned, held).empty());
}

// A write lands no pointer on a step that owns a subtree, an echo of it included, and keeps every other register; an
// entry left with nothing to write goes.
TEST(a_write_without_owned_pointers_keeps_every_other_register_and_drops_an_entry_left_empty) {
  const Hlc at{5, 0, "phone"};
  GraphState graph;
  graph.nodes.push_back(NodeStateEntry{.id = nid("sail"), .label = "Sail", .labelAt = at, .opens = tid("t_x"), .opensAt = at});
  graph.nodes.push_back(NodeStateEntry{.id = nid("rig"), .opens = tid("t_r"), .opensAt = at});
  graph.nodes.push_back(NodeStateEntry{.id = nid("plain"), .opens = tid("t_x"), .opensAt = at});

  withoutOwnedPointers(graph, {{nid("sail"), tid("t_s")}, {nid("rig"), tid("t_r")}});

  CHECK(graph.nodes == (std::vector<NodeStateEntry>{NodeStateEntry{.id = nid("sail"), .label = "Sail", .labelAt = at},
                                                    NodeStateEntry{.id = nid("plain"), .opens = tid("t_x"), .opensAt = at}}));
}

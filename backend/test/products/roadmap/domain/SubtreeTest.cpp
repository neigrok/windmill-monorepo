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

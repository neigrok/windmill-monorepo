#include "products/roadmap/application/ForkService.h"

#include "products/roadmap/adapters/auth/ForkSignup.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "test/platform/Fakes.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

#include <string>

using namespace wm;
using namespace wm::fake;

namespace {
struct Harness {
  FakeTreeRepository trees;
  FakeOpLog ops;
  FakeBus bus;
  FakeTokens tokens;
  RoomRegistry rooms{trees, ops, bus};
  ForkService service{rooms, trees, tokens};

  // A shared (unlisted) source, forkable by anyone with the id — the everyday fork scenario.
  void seedSource(const char* id, const char* title) {
    seedSource(id, title, uid("owner"), Visibility::unlisted);
  }
  void seedSource(const char* id, const char* title, const UserId& owner, Visibility visibility) {
    TreeData data;
    data.id = TreeId{std::string(id)};
    data.title = title;
    NodeSpec root;
    root.id = nid("root");
    root.label = "Root";
    NodeSpec leaf;
    leaf.id = nid("leaf");
    leaf.label = "Leaf";
    leaf.prerequisites = {nid("root")};
    root.status = "complete";  // authoring seed — a fork must start unlit
    data.nodes = {root, leaf};
    GraphState state = LooseGraph(data, Hlc{1, 0, "seed"}).exportState();
    trees.byId[id] = StoredTree{state, LegendState{}, {title, {}}, 0, owner, visibility};
  }
};
}

TEST(fork_mints_an_id_and_inherits_the_title_when_given_neither) {
  Harness h;
  h.seedSource("t_src", "Learn to sail");

  ForkService::Result result = h.service.fork(TreeId{"t_src"}, "", "", uid("me"));
  CHECK(result.outcome == ForkService::Outcome::forked);
  CHECK_EQ(result.data.id.str(), std::string("t_d1"));        // "t_" + the minted digest
  CHECK_EQ(result.data.title, std::string("Learn to sail"));  // empty title means inherit
  CHECK_EQ(result.data.nodes.size(), 2u);
  CHECK_EQ(h.trees.forkedFrom["t_d1"], std::string("t_src"));
  CHECK(h.trees.byId.count("t_d1") == 1);
  CHECK(*h.trees.byId["t_d1"].owner == uid("me"));
}

TEST(fork_clears_the_source_status_seeds) {
  Harness h;
  h.seedSource("t_src", "Learn to sail");

  ForkService::Result result = h.service.fork(TreeId{"t_src"}, "", "", uid("me"));
  CHECK(result.outcome == ForkService::Outcome::forked);
  for (const NodeSpec& node : result.data.nodes) CHECK_FALSE(node.status.has_value());
  for (const NodeStateEntry& node : h.trees.byId["t_d1"].state.nodes) {
    CHECK_FALSE(node.status.has_value());
    CHECK_FALSE(node.statusAt.isSet());
  }
  // The source keeps its seed untouched.
  bool sourceSeedSurvives = false;
  for (const NodeStateEntry& node : h.trees.byId["t_src"].state.nodes) {
    if (node.status.has_value() && *node.status == "complete") sourceSeedSurvives = true;
  }
  CHECK(sourceSeedSurvives);
}

TEST(fork_honours_a_requested_id_and_title) {
  Harness h;
  h.seedSource("t_src", "Learn to sail");

  ForkService::Result result = h.service.fork(TreeId{"t_src"}, "t_copy", "My sail plan", uid("me"));
  CHECK(result.outcome == ForkService::Outcome::forked);
  CHECK_EQ(result.data.id.str(), std::string("t_copy"));
  CHECK_EQ(result.data.title, std::string("My sail plan"));
  CHECK_EQ(h.trees.forkedFrom["t_copy"], std::string("t_src"));
}

TEST(fork_reports_a_conflict_when_the_requested_id_is_taken) {
  Harness h;
  h.seedSource("t_src", "Learn to sail");
  h.seedSource("t_taken", "Already here");

  ForkService::Result result = h.service.fork(TreeId{"t_src"}, "t_taken", "", uid("me"));
  CHECK(result.outcome == ForkService::Outcome::conflict);
  CHECK_EQ(h.trees.byId["t_taken"].title.value, std::string("Already here"));  // untouched
  CHECK(h.trees.forkedFrom.count("t_taken") == 0);
}

TEST(fork_reports_a_conflict_when_the_requested_id_is_soft_deleted) {
  Harness h;
  h.seedSource("t_src", "Learn to sail");
  h.seedSource("t_gone", "Retired");
  h.trees.softDelete(TreeId{"t_gone"});

  // load can't see the deleted row, so the insert runs — the unique index refuses it.
  ForkService::Result result = h.service.fork(TreeId{"t_src"}, "t_gone", "", uid("me"));
  CHECK(result.outcome == ForkService::Outcome::conflict);
  CHECK(h.trees.forkedFrom.count("t_gone") == 0);
}

TEST(fork_reports_a_missing_source) {
  Harness h;
  ForkService::Result result = h.service.fork(TreeId{"t_ghost"}, "", "", uid("me"));
  CHECK(result.outcome == ForkService::Outcome::noSource);
  CHECK(h.trees.byId.empty());
}

TEST(fork_of_a_private_source_you_dont_own_is_a_missing_source) {
  Harness h;
  h.seedSource("t_priv", "Someone's private plan", uid("owner"), Visibility::private_);

  // Copying the whole document is a read; a private source you can't read is 404, byte-for-byte
  // indistinguishable from a source that isn't there — no id enumeration.
  ForkService::Result result = h.service.fork(TreeId{"t_priv"}, "", "", uid("me"));
  CHECK(result.outcome == ForkService::Outcome::noSource);
  CHECK(h.trees.byId.size() == 1u);  // only the source — nothing was forked
  CHECK(h.trees.forkedFrom.empty());
}

TEST(fork_of_your_own_private_source_succeeds) {
  Harness h;
  h.seedSource("t_priv", "My private plan", uid("me"), Visibility::private_);

  ForkService::Result result = h.service.fork(TreeId{"t_priv"}, "", "", uid("me"));
  CHECK(result.outcome == ForkService::Outcome::forked);
  CHECK_EQ(h.trees.forkedFrom["t_d1"], std::string("t_priv"));
  CHECK(*h.trees.byId["t_d1"].owner == uid("me"));
}

TEST(fork_of_an_unlisted_source_by_a_stranger_succeeds) {
  Harness h;
  h.seedSource("t_shared", "A shared plan", uid("owner"), Visibility::unlisted);

  ForkService::Result result = h.service.fork(TreeId{"t_shared"}, "", "", uid("stranger"));
  CHECK(result.outcome == ForkService::Outcome::forked);
  CHECK_EQ(h.trees.forkedFrom["t_d1"], std::string("t_shared"));
  CHECK(*h.trees.byId["t_d1"].owner == uid("stranger"));
}

// The demo tree's exact shape — owner NULL, visibility public — and the one thing a visitor is
// meant to do with it. Forking is a READ of the source plus an insert of a new row owned by the
// forker, so making the demo unwritable must not make it unforkable: the copy is born owned, the
// source is left exactly as it was, and it stays nobody's.
TEST(fork_of_an_unowned_public_source_gives_the_forker_a_copy_and_leaves_the_source_alone) {
  Harness h;
  h.seedSource("t_demo", "Learn to sail", uid("placeholder"), Visibility::public_);
  h.trees.byId["t_demo"].owner = std::nullopt;
  const StoredTree before = h.trees.byId["t_demo"];

  ForkService::Result result = h.service.fork(TreeId{"t_demo"}, "", "", uid("visitor"));

  CHECK(result.outcome == ForkService::Outcome::forked);
  CHECK_EQ(result.data.nodes.size(), 2u);
  CHECK_EQ(h.trees.forkedFrom["t_d1"], std::string("t_demo"));
  CHECK(*h.trees.byId["t_d1"].owner == uid("visitor"));            // the copy is born owned
  CHECK(h.trees.byId["t_d1"].visibility == Visibility::private_);  // and born private
  CHECK(h.trees.byId["t_demo"] == before);                         // the demo is untouched
  CHECK_FALSE(h.trees.byId["t_demo"].owner.has_value());           // and still nobody's
}

TEST(describe_names_a_live_source_with_its_step_count) {
  Harness h;
  h.seedSource("t_src", "Learn to sail");

  std::optional<ForkService::Description> described = h.service.describe(TreeId{"t_src"});
  CHECK(described.has_value());
  CHECK_EQ(described->title, std::string("Learn to sail"));
  CHECK_EQ(described->steps, 2u);
}

TEST(describe_declines_a_vanished_source) {
  Harness h;
  CHECK_FALSE(h.service.describe(TreeId{"t_ghost"}).has_value());
}

TEST(describe_declines_a_private_source_so_it_never_names_a_strangers_tree) {
  Harness h;
  h.seedSource("t_priv", "Secret plan", uid("owner"), Visibility::private_);
  // The fork-invite mail is unauthenticated: a private source stays undescribed so its title
  // and step count never ride an email addressed by someone who can't read it.
  CHECK_FALSE(h.service.describe(TreeId{"t_priv"}).has_value());
}

// ForkSignup is the platform seam's roadmap side, and the words on the fork mail's meta line are
// written HERE — the platform forwards whatever string it is handed, so if a tree of one step ever
// reads "1 steps" it is this file's fault and nowhere else's.
TEST(the_signup_seam_renders_the_step_count_as_the_mail_prints_it) {
  Harness h;
  h.seedSource("t_src", "Learn to sail");
  ForkSignup signup{h.service};

  std::optional<ForkDescription> described = signup.describe("t_src");
  CHECK(described.has_value());
  CHECK_EQ(described->title, std::string("Learn to sail"));
  CHECK_EQ(described->meta, std::string("2 steps"));
}

TEST(the_signup_seam_writes_1_step_not_1_steps) {
  Harness h;
  TreeData data;
  data.id = TreeId{"t_one"};
  data.title = "Plant one seed";
  NodeSpec root;
  root.id = nid("root");
  root.label = "Root";
  data.nodes = {root};
  GraphState state = LooseGraph(data, Hlc{1, 0, "seed"}).exportState();
  h.trees.byId["t_one"] = StoredTree{state, LegendState{}, {"Plant one seed", {}}, 0, uid("owner"),
                                     Visibility::unlisted};
  ForkSignup signup{h.service};

  std::optional<ForkDescription> described = signup.describe("t_one");
  CHECK(described.has_value());
  CHECK_EQ(described->meta, std::string("1 step"));
}

TEST(the_signup_seam_leaves_an_unreadable_source_undescribed) {
  Harness h;
  ForkSignup signup{h.service};
  CHECK_FALSE(signup.describe("t_ghost").has_value());
}

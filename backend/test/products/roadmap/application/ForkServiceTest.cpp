#include "products/roadmap/application/ForkService.h"

#include "products/roadmap/adapters/auth/ForkSignup.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "platform/application/WriteObservation.h"
#include "platform/ports/FailureReporter.h"
#include "test/platform/Fakes.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using namespace wm;
using namespace wm::fake;

namespace {
struct Harness {
  FakeTreeRepository trees;
  FakeOpLog ops;
  FakeBus bus;
  FakeTokens tokens;
  FakeClock clock;
  RoomRegistry rooms{trees, ops, bus};
  ForkService service{rooms, trees, tokens, clock};

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

TEST(fork_plants_the_sources_live_title_and_guide_at_its_planting_stamp_so_a_fresh_subscriber_receives_both) {
  Harness h;
  h.seedSource("t_src", "Learn to sail");
  h.trees.byId["t_src"].guide = Lww<std::string>{"Rig first, then sail.", Hlc{5, 0, "srv"}};
  h.rooms.open(TreeId{"t_src"})->setGuide("Rig first, sail second, race last.", 10);

  ForkService::Result result = h.service.fork(TreeId{"t_src"}, "", "", uid("me"));
  CHECK(result.outcome == ForkService::Outcome::forked);
  CHECK_EQ(result.data.title, std::string("Learn to sail"));
  CHECK_EQ(result.data.guide, std::string("Rig first, sail second, race last."));
  const Hlc plantedAt{h.clock.nowMs(), 0, "srv"};
  const Lww<std::string> title{"Learn to sail", plantedAt};
  const Lww<std::string> guide{"Rig first, sail second, race last.", plantedAt};
  CHECK(h.trees.byId["t_d1"].title == title);
  CHECK(h.trees.byId["t_d1"].guide == guide);
  CHECK(h.trees.byId["t_d1"].guideInherited);  // the source author's words, not the new owner's
  CHECK(*h.trees.byId["t_d1"].owner == uid("me"));
  CHECK(h.rooms.open(TreeId{"t_d1"})->guideInherited());

  const Subgraph delta = h.rooms.open(TreeId{"t_d1"})->deltaSince(VersionVector{});
  CHECK(delta.title == std::optional<Lww<std::string>>(title));
  CHECK(delta.guide == std::optional<Lww<std::string>>(guide));
  CHECK_EQ(delta.graph.nodes.size(), 2u);
}

TEST(fork_under_a_requested_title_plants_that_title_at_the_planting_stamp) {
  Harness h;
  h.seedSource("t_src", "Learn to sail");

  ForkService::Result result = h.service.fork(TreeId{"t_src"}, "", "My own voyage", uid("me"));
  CHECK(result.outcome == ForkService::Outcome::forked);
  CHECK_EQ(result.data.title, std::string("My own voyage"));
  CHECK(h.trees.byId["t_d1"].title == (Lww<std::string>{"My own voyage", Hlc{h.clock.nowMs(), 0, "srv"}}));
  CHECK(h.trees.byId["t_d1"].guide == (Lww<std::string>{"", Hlc{h.clock.nowMs(), 0, "srv"}}));
  CHECK_FALSE(h.trees.byId["t_d1"].guideInherited);  // no words were copied
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
  bool sourceSeedSurvives = false;
  for (const NodeStateEntry& node : h.trees.byId["t_src"].state.nodes) {
    if (node.status.has_value() && *node.status == "complete") sourceSeedSurvives = true;
  }
  CHECK(sourceSeedSurvives);
}

TEST(a_fork_of_someone_elses_tree_opens_nothing_and_a_fork_of_your_own_keeps_every_pointer) {
  Harness h;
  h.seedSource("t_sams", "Learn to sail", uid("sam"), Visibility::unlisted);
  h.seedSource("t_eves", "Eve's knots", uid("eve"), Visibility::private_);
  GraphState pointers;
  for (const auto& [step, tree] : std::vector<std::pair<const char*, const char*>>{
           {"charts", "t_sams_charts"}, {"knots", "t_eves"}, {"nowhere", "t_missing"}}) {
    NodeStateEntry node;
    node.id = nid(step);
    node.label = step;
    node.createdAt = node.labelAt = Hlc{2, 0, "seed"};
    node.opens = TreeId{tree};
    node.opensAt = Hlc{3, 0, "seed"};
    pointers.nodes.push_back(node);
  }
  LooseGraph source(h.trees.byId["t_sams"].state);
  source.join(pointers);
  h.trees.byId["t_sams"].state = source.exportState();
  const auto opened = [](const GraphState& state) {
    std::map<std::string, std::pair<std::string, Hlc>> byStep;
    for (const NodeStateEntry& node : state.nodes) byStep[node.id.str()] = {node.opens.str(), node.opensAt};
    return byStep;
  };
  const std::map<std::string, std::pair<std::string, Hlc>> asInTheSource{
      {"charts", {"t_sams_charts", Hlc{3, 0, "seed"}}}, {"knots", {"t_eves", Hlc{3, 0, "seed"}}},
      {"leaf", {"", Hlc{}}}, {"nowhere", {"t_missing", Hlc{3, 0, "seed"}}}, {"root", {"", Hlc{}}}};
  const std::map<std::string, std::pair<std::string, Hlc>> nothing{
      {"charts", {"", Hlc{}}}, {"knots", {"", Hlc{}}}, {"leaf", {"", Hlc{}}}, {"nowhere", {"", Hlc{}}}, {"root", {"", Hlc{}}}};

  ForkService::Result eves = h.service.fork(TreeId{"t_sams"}, "t_eves_copy", "", uid("eve"));
  CHECK(eves.outcome == ForkService::Outcome::forked);
  CHECK(opened(h.trees.byId["t_eves_copy"].state) == nothing);  // the pointer at Eve's own tree included
  for (const NodeSpec& node : eves.data.nodes) CHECK_EQ(node.opens, TreeId{});

  ForkService::Result sams = h.service.fork(TreeId{"t_sams"}, "t_sams_copy", "", uid("sam"));
  CHECK(sams.outcome == ForkService::Outcome::forked);
  CHECK(opened(h.trees.byId["t_sams_copy"].state) == asInTheSource);  // the one at a missing tree included
  std::map<std::string, std::string> answered;
  for (const NodeSpec& node : sams.data.nodes) answered[node.id.str()] = node.opens.str();
  CHECK(answered == (std::map<std::string, std::string>{
                        {"charts", "t_sams_charts"}, {"knots", "t_eves"}, {"leaf", ""}, {"nowhere", "t_missing"}, {"root", ""}}));
  CHECK(opened(h.rooms.open(TreeId{"t_sams"})->exportState()) == asInTheSource);
}

TEST(fork_adds_its_steps_at_the_moment_of_the_fork_and_leaves_the_source_stamps_alone) {
  Harness h;
  h.seedSource("t_src", "Learn to sail");
  h.clock.now = 1'800'000'000'000;

  ForkService::Result result = h.service.fork(TreeId{"t_src"}, "", "", uid("me"));
  CHECK(result.outcome == ForkService::Outcome::forked);

  const std::vector<NodeStateEntry>& forked = h.trees.byId["t_d1"].state.nodes;
  REQUIRE_EQ(forked.size(), 2u);
  CHECK_EQ(forked[0].id, nid("leaf"));
  CHECK_EQ(forked[0].createdAt, (Hlc{1'800'000'000'000, 0, "srv"}));  // tied with root at the seed, first by id
  CHECK_EQ(forked[1].id, nid("root"));
  CHECK_EQ(forked[1].createdAt, (Hlc{1'800'000'000'000, 1, "srv"}));
  for (const NodeStateEntry& node : h.trees.byId["t_src"].state.nodes) CHECK_EQ(node.createdAt, (Hlc{1, 0, "seed"}));
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
  CHECK_EQ(h.trees.byId["t_taken"].title.value, std::string("Already here"));
  CHECK(h.trees.forkedFrom.count("t_taken") == 0);
}

TEST(fork_reports_a_conflict_when_the_requested_id_is_soft_deleted) {
  Harness h;
  h.seedSource("t_src", "Learn to sail");
  h.seedSource("t_gone", "Retired");
  h.trees.softDelete(TreeId{"t_gone"});

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

TEST(fork_lets_an_infrastructure_failure_through_instead_of_calling_the_source_missing) {
  Harness h;
  h.seedSource("t_src", "Learn to sail");
  h.trees.latticeLoadsFail = true;

  bool threw = false;
  try {
    h.service.fork(TreeId{"t_src"}, "", "", uid("me"));
  } catch (const std::runtime_error&) {
    threw = true;
  }
  CHECK(threw);
  CHECK(h.trees.forkedFrom.empty());
}

TEST(fork_of_a_private_source_you_dont_own_is_a_missing_source) {
  Harness h;
  h.seedSource("t_priv", "Someone's private plan", uid("owner"), Visibility::private_);

  // Copying the whole document is a read: a private source you can't read is 404, byte-for-byte indistinguishable from a source that isn't there.
  ForkService::Result result = h.service.fork(TreeId{"t_priv"}, "", "", uid("me"));
  CHECK(result.outcome == ForkService::Outcome::noSource);
  CHECK(h.trees.byId.size() == 1u);
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

// The demo tree's exact shape — owner NULL, visibility public. Forking is a READ plus an insert owned by the forker, so unwritable must not mean unforkable.
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
  REQUIRE(described.has_value());
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
  // The fork-invite mail is unauthenticated, so a private source stays undescribed.
  CHECK_FALSE(h.service.describe(TreeId{"t_priv"}).has_value());
}

// ForkSignup is roadmap's side of the platform seam, and the words on the fork mail's meta line are written HERE.
TEST(the_signup_seam_renders_the_step_count_as_the_mail_prints_it) {
  Harness h;
  h.seedSource("t_src", "Learn to sail");
  ForkSignup signup{h.service};

  std::optional<ForkDescription> described = signup.describe("t_src");
  REQUIRE(described.has_value());
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
  REQUIRE(described.has_value());
  CHECK_EQ(described->meta, std::string("1 step"));
}

TEST(the_signup_seam_leaves_an_unreadable_source_undescribed) {
  Harness h;
  ForkSignup signup{h.service};
  CHECK_FALSE(signup.describe("t_ghost").has_value());
}

TEST(the_signup_seam_reports_a_failed_fork_as_an_issue_and_a_missing_source_as_none) {
  struct Failures : FailureReporter {
    std::vector<std::string> operations;
    void report(const std::string&, const std::string&, const std::string&) override {}
    void reportWrite(const std::string& operation, const std::string&, const std::string&, const std::string&,
                     const std::string&, const std::string&) override {
      operations.push_back(operation);
    }
  };
  struct ReporterScope {
    std::shared_ptr<Failures> failures = std::make_shared<Failures>();
    ReporterScope() { installWriteReporter(failures); }
    ~ReporterScope() { installWriteReporter(nullptr); }
  } reporter;
  Harness h;
  h.seedSource("t_src", "Learn to sail");
  ForkSignup signup{h.service};

  CHECK_FALSE(signup.plant("t_ghost", uid("me")).has_value());
  CHECK_EQ(reporter.failures->operations, std::vector<std::string>{});

  h.trees.latticeLoadsFail = true;
  CHECK_FALSE(signup.plant("t_src", uid("me")).has_value());
  CHECK_EQ(reporter.failures->operations, std::vector<std::string>{"roadmap.signup.fork"});
}

// A fork copies the root and its standing branch in one store: every subtree reached down a present owning step, at any
// depth, gets a copy with a minted id hung from the copy of its parent under the same step, so the fork shares no child
// with its source. A subtree whose owning step is deleted is hidden and not copied. Each copy keeps its own guide, by
// the inherited rule, and starts unlit. A subtree is never forked alone.
TEST(fork_copies_the_roots_standing_branch_under_fresh_ids_and_never_a_subtree_alone) {
  Harness h;
  h.seedSource("t_src", "Learn to sail");
  const auto plant = [&h](const char* id, const char* parent, const char* step, int depth,
                          const std::vector<const char*>& steps) {
    TreeData data;
    for (const char* name : steps) {
      NodeSpec node;
      node.id = nid(name);
      node.label = name;
      node.status = "complete";
      data.nodes.push_back(node);
    }
    h.trees.byId[id] = StoredTree{LooseGraph(data, Hlc{1, 0, "seed"}).exportState(), LegendState{}, {"", {}}, 0,
                                  uid("owner"), Visibility::private_, 0, Lww<std::string>{"Knots first", Hlc{2, 0, "seed"}}};
    h.trees.subtrees[id] = Subtree{TreeId{std::string(id)}, tid("t_src"), OwningStep{tid(parent), nid(step)}, depth, 0};
  };
  plant("t_s", "t_src", "root", 1, {"knot"});
  plant("t_g", "t_s", "knot", 2, {"bowline", "hitch"});
  plant("t_h", "t_src", "gone", 1, {"hidden"});
  LooseGraph source(h.trees.byId["t_src"].state);
  source.createNode(nid("gone"), "Gone", "", NodeColor::sky, Hlc{1, 0, "seed"});
  source.deleteNode(nid("gone"), Hlc{3, 0, "seed"});
  h.trees.byId["t_src"].state = source.exportState();

  CHECK(h.service.fork(tid("t_s"), "", "", uid("me")).notARoot ==
        (std::optional<NotARoot>(NotARoot{OwningStep{tid("t_src"), nid("root")}, tid("t_src")})));
  CHECK(h.trees.forks.empty());

  const ForkService::Result result = h.service.fork(tid("t_src"), "", "", uid("me"));
  REQUIRE(result.outcome == ForkService::Outcome::forked);
  REQUIRE_EQ(h.trees.forks.size(), 1u);
  std::vector<std::string> copied;
  for (const TreeCopy& copy : h.trees.forks.front()) {
    std::string row = copy.id.str() + " of " + copy.source.str();
    if (copy.parent) row += " under " + copy.parent->tree.str() + "/" + copy.parent->step.str();
    if (copy.guideInherited) row += ", inherited";
    for (const NodeStateEntry& node : copy.state.nodes)
      if (node.status) row += ", lit";
    copied.push_back(row);
  }
  CHECK_EQ(copied, (std::vector<std::string>{"t_d1 of t_src", "t_d2 of t_s under t_d1/root, inherited",
                                             "t_d3 of t_g under t_d2/knot, inherited"}));
  CHECK(h.trees.subtrees["t_d2"].parent == (OwningStep{tid("t_d1"), nid("root")}));
  CHECK(h.trees.subtrees["t_d3"].parent == (OwningStep{tid("t_d2"), nid("knot")}));
  CHECK(h.trees.subtrees["t_s"].parent == (OwningStep{tid("t_src"), nid("root")}));  // the source keeps its own
  CHECK(h.trees.forkedFrom == (std::map<std::string, std::string>{{"t_d1", "t_src"}}));
  CHECK(h.rooms.accessOf(tid("t_d3"))->owner == std::optional<UserId>(uid("me")));
}

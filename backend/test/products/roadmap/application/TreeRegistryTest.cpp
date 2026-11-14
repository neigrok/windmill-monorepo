#include "products/roadmap/application/TreeRegistry.h"

#include "platform/application/StatementLimits.h"
#include "platform/application/WriteObservation.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "products/roadmap/domain/Subgraph.h"
#include "products/roadmap/domain/UnlockRules.h"
#include "test/platform/Fakes.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

#include <algorithm>
#include <future>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <typeinfo>
#include <variant>
#include <vector>

using namespace wm;
using namespace wm::fake;

using Removal = std::variant<Cascade, TreeRegistry::RemovalRefusal, NotARoot>;
using VisibilityAnswer = std::variant<TreeRegistry::VisibilityChange, NotARoot>;

struct Setup {
  FakeTreeRepository trees;
  FakeProgressRepository progress;
  FakeTokens tokens;
  FakeOpLog ops;
  FakeBus bus;
  FakeClock clock;
  HeldRetries retries;
  RoomRegistry rooms{trees, ops, bus, retries.timer()};
  ProgressService marks{progress, trees};
  NodeEdits edits{rooms, marks, bus, clock};
  TreeRegistry registry{trees, progress, tokens, Hlc{1, 0, "genesis"}, rooms, edits, clock};
};

static NodeSpec spec(const char* id, NodeColor color, std::vector<NodeId> prereqs = {}) {
  NodeSpec node;
  node.id = nid(id);
  node.label = id;
  node.color = color;
  node.prerequisites = std::move(prereqs);
  return node;
}

static TreeData treeData(const char* title, std::vector<NodeSpec> nodes) {
  TreeData data;
  data.title = title;
  data.nodes = std::move(nodes);
  return data;
}

static void seed(FakeTreeRepository& trees, const char* id, const UserId& owner,
                 std::uint64_t updatedAt, std::vector<NodeSpec> nodes) {
  TreeData data;
  data.id = TreeId{std::string(id)};
  data.title = id;
  data.nodes = std::move(nodes);
  GraphState state = LooseGraph(data, Hlc{1, 0, "seed"}).exportState();
  // Planted ten ticks before its last touch, so a row can never confuse the two stamps.
  trees.byId[id] = StoredTree{state, LegendState{}, {data.title, {}}, 0, owner,
                              Visibility::private_, updatedAt - 10};
  trees.updatedAt[id] = updatedAt;
}

TEST(create_plants_an_owned_empty_tree_that_shows_up_in_the_list) {
  Setup s;
  UserId me = uid("me");

  TreeId first = s.registry.create(me, treeData("Kitchen garden", {}));
  TreeId second = s.registry.create(me, treeData("", {}));
  CHECK_FALSE(first.empty());
  CHECK_FALSE(second == first);

  std::vector<TreeSummary> rows = s.registry.list(me);
  CHECK_EQ(rows.size(), 2u);
  bool found = false;
  for (const TreeSummary& row : rows) {
    if (row.id != first) continue;
    found = true;
    CHECK_EQ(row.title, std::string("Kitchen garden"));
    CHECK_EQ(row.stats.total, 0);
    CHECK_EQ(row.stats.done, 0);
  }
  CHECK(found);
}

TEST(create_accepts_an_initial_tree_document) {
  Setup s;
  UserId me = uid("me");

  TreeId id = s.registry.create(me, treeData("Frontend",
      {spec("html", NodeColor::olive), spec("css", NodeColor::olive, {nid("html")})}));

  std::vector<TreeSummary> rows = s.registry.list(me);
  REQUIRE_EQ(rows.size(), 1u);
  CHECK_EQ(rows[0].id, id);
  CHECK_EQ(rows[0].title, std::string("Frontend"));
  CHECK_EQ(rows[0].stats.total, 2);
  CHECK_EQ(rows[0].stats.dominantKind, NodeColor::olive);
}

TEST(create_with_a_requested_id_plants_an_empty_tree_with_the_default_legend_at_genesis) {
  Setup s;
  UserId me = uid("me");

  TreeRegistry::Creation outcome =
      s.registry.create(me, TreeId{"t_00c0ffee00c0ffee"}, treeData("Learn woodworking", {}));

  CHECK(outcome == TreeRegistry::Creation::created);
  const StoredTree& stored = s.trees.byId["t_00c0ffee00c0ffee"];
  CHECK(stored.owner == std::optional<UserId>(me));
  CHECK(stored.title == (Lww<std::string>{"Learn woodworking", Hlc{}}));
  CHECK_EQ(stored.head, static_cast<Seq>(0));
  CHECK(stored.state == GraphState{});  // a claim-create posts no nodes — the client's CRDT flush brings them

  // The client seeds these same three kinds at '1:0:genesis' locally, so the two legends must be byte-equal.
  const Hlc genesis{1, 0, "genesis"};
  LegendState expected;
  expected.kinds.push_back(KindStateEntry{KindId{"build"}, genesis, Hlc{}, NodeColor::terracotta,
                                          genesis, "Build", genesis, "Things you make", genesis, 0, genesis});
  expected.kinds.push_back(KindStateEntry{KindId{"learn"}, genesis, Hlc{}, NodeColor::olive,
                                          genesis, "Learn", genesis, "Things you figure out", genesis, 1, genesis});
  expected.kinds.push_back(KindStateEntry{KindId{"milestone"}, genesis, Hlc{}, NodeColor::gold,
                                          genesis, "Milestone", genesis, "Moments that matter", genesis, 2, genesis});
  CHECK(stored.legend == expected);
}

TEST(create_adds_the_initial_steps_now_while_the_legend_stays_at_genesis) {
  Setup s;
  UserId me = uid("me");
  s.clock.now = 1'800'000'000'000;

  TreeRegistry::Creation outcome = s.registry.create(me, TreeId{"t_00c0ffee00c0ffee"},
      treeData("Frontend", {spec("html", NodeColor::olive), spec("css", NodeColor::olive, {nid("html")})}));

  CHECK(outcome == TreeRegistry::Creation::created);
  const StoredTree& stored = s.trees.byId["t_00c0ffee00c0ffee"];
  const Hlc planted{1'800'000'000'000, 0, "srv"};
  REQUIRE_EQ(stored.state.nodes.size(), 2u);
  for (const NodeStateEntry& node : stored.state.nodes) {
    CHECK_EQ(node.createdAt, planted);
    CHECK_EQ(node.labelAt, planted);
  }
  REQUIRE_EQ(stored.state.edges.size(), 1u);
  CHECK_EQ(stored.state.edges[0].addedAt, planted);
  REQUIRE_EQ(stored.legend.kinds.size(), 3u);
  for (const KindStateEntry& kind : stored.legend.kinds) CHECK_EQ(kind.createdAt, (Hlc{1, 0, "genesis"}));
}

TEST(create_with_the_same_id_by_its_owner_resumes_without_touching_the_row) {
  Setup s;
  UserId me = uid("me");
  CHECK(s.registry.create(me, TreeId{"t_00c0ffee00c0ffee"}, treeData("Original title", {})) ==
        TreeRegistry::Creation::created);
  StoredTree before = s.trees.byId["t_00c0ffee00c0ffee"];

  TreeRegistry::Creation outcome =
      s.registry.create(me, TreeId{"t_00c0ffee00c0ffee"}, treeData("Different title", {}));

  CHECK(outcome == TreeRegistry::Creation::existedYours);
  CHECK(s.trees.byId["t_00c0ffee00c0ffee"] == before);
}

TEST(create_with_an_id_that_is_not_yours_is_taken_and_leaves_the_row_alone) {
  Setup s;
  CHECK(s.registry.create(uid("owner"), TreeId{"t_00c0ffee00c0ffee"}, treeData("Theirs", {})) ==
        TreeRegistry::Creation::created);
  StoredTree before = s.trees.byId["t_00c0ffee00c0ffee"];

  CHECK(s.registry.create(uid("intruder"), TreeId{"t_00c0ffee00c0ffee"}, treeData("Mine now", {})) ==
        TreeRegistry::Creation::taken);
  CHECK(s.trees.byId["t_00c0ffee00c0ffee"] == before);

  // An unowned tree is nobody's to resume: a create is not a way to claim what nobody owns.
  s.trees.byId["t_deadbeefdeadbeef"] = StoredTree{GraphState{}, LegendState{}, {"Unclaimed", {}}, 0, std::nullopt};
  CHECK(s.registry.create(uid("intruder"), TreeId{"t_deadbeefdeadbeef"}, treeData("Claim it", {})) ==
        TreeRegistry::Creation::taken);
  CHECK(s.trees.byId["t_deadbeefdeadbeef"].owner == std::nullopt);
}

TEST(create_with_your_own_soft_deleted_id_is_retired_not_taken) {
  Setup s;
  UserId me = uid("me");
  CHECK(s.registry.create(me, TreeId{"t_00c0ffee00c0ffee"}, treeData("Gone soon", {})) ==
        TreeRegistry::Creation::created);
  CHECK(s.registry.remove(TreeId{"t_00c0ffee00c0ffee"}, me) == Removal{Cascade{}});

  // load can't see the deleted row, so the insert runs and the unique index refuses it; the retired row's owner is the only fact that tells the caller's own delete from a stranger's id.
  CHECK(s.registry.create(me, TreeId{"t_00c0ffee00c0ffee"}, treeData("Again", {})) ==
        TreeRegistry::Creation::retired);
  CHECK_EQ(s.registry.list(me).size(), 0u);
}

TEST(create_with_another_accounts_soft_deleted_id_is_still_taken) {
  Setup s;
  UserId owner = uid("owner");
  UserId intruder = uid("intruder");
  CHECK(s.registry.create(owner, TreeId{"t_00c0ffee00c0ffee"}, treeData("Theirs", {})) ==
        TreeRegistry::Creation::created);
  CHECK(s.registry.remove(TreeId{"t_00c0ffee00c0ffee"}, owner) == Removal{Cascade{}});

  CHECK(s.registry.create(intruder, TreeId{"t_00c0ffee00c0ffee"}, treeData("Mine now", {})) ==
        TreeRegistry::Creation::taken);
  CHECK_EQ(s.registry.list(intruder).size(), 0u);
  CHECK_EQ(s.registry.list(owner).size(), 0u);
}

TEST(list_orders_owned_trees_newest_first_and_excludes_other_owners) {
  Setup s;
  UserId me = uid("me");
  seed(s.trees, "old", me, 100, {spec("a", NodeColor::olive), spec("b", NodeColor::olive)});
  seed(s.trees, "fresh", me, 300, {spec("x", NodeColor::sky)});
  seed(s.trees, "notmine", uid("other"), 999, {spec("z", NodeColor::gold)});
  s.progress.setStatuses(tid("old"), me, {{nid("a"), ProgressStatus::complete, false, at(150, "me")}}, StampedBy::replica, 150);

  std::vector<TreeSummary> rows = s.registry.list(me);

  REQUIRE_EQ(rows.size(), 2u);
  CHECK_EQ(rows[0].id, TreeId{std::string("fresh")});
  CHECK_EQ(rows[0].createdAt, 290u);
  CHECK_EQ(rows[0].updatedAt, 300u);
  CHECK_EQ(rows[0].stats.total, 1);
  CHECK_EQ(rows[0].stats.done, 0);
  CHECK_EQ(rows[0].stats.dominantKind, NodeColor::sky);
  CHECK_EQ(rows[1].id, TreeId{std::string("old")});
  CHECK_EQ(rows[1].createdAt, 90u);   // the planting stamp, untouched by the progress mark
  CHECK_EQ(rows[1].updatedAt, 150u);  // the progress mark (150) beat the structural stamp (100)
  CHECK_EQ(rows[1].stats.total, 2);
  CHECK_EQ(rows[1].stats.done, 1);
  CHECK_EQ(rows[1].stats.dominantKind, NodeColor::olive);
}

TEST(list_counts_a_node_that_opens_a_tree_as_done_when_that_tree_is_complete) {
  Setup s;
  UserId me = uid("me");
  NodeSpec idea = spec("idea", NodeColor::sky);
  idea.opens = TreeId{"t_00000000000000b2"};
  NodeSpec stalled = spec("stalled", NodeColor::sky);
  stalled.opens = TreeId{"t_00000000000000b3"};
  CHECK(s.registry.create(me, TreeId{"t_00000000000000b1"}, treeData("Ideas", {idea, stalled, spec("plain", NodeColor::sky)})) ==
        TreeRegistry::Creation::created);
  CHECK(s.registry.create(me, TreeId{"t_00000000000000b2"}, treeData("Worked", {spec("w", NodeColor::sky)})) ==
        TreeRegistry::Creation::created);
  CHECK(s.registry.create(me, TreeId{"t_00000000000000b3"}, treeData("Waiting", {spec("x", NodeColor::sky)})) ==
        TreeRegistry::Creation::created);
  s.progress.setStatuses(TreeId{"t_00000000000000b2"}, me, {{nid("w"), ProgressStatus::complete, false, Hlc{5, 0, "me"}}}, StampedBy::replica, 5);
  s.progress.setStatuses(TreeId{"t_00000000000000b1"}, me, {{nid("stalled"), ProgressStatus::complete, false, Hlc{6, 0, "me"}}}, StampedBy::replica, 6);

  std::map<std::string, std::string> doneOfTotal;
  for (const TreeSummary& row : s.registry.list(me))
    doneOfTotal[row.id.str()] = std::to_string(row.stats.done) + "/" + std::to_string(row.stats.total);
  CHECK(doneOfTotal == (std::map<std::string, std::string>{{"t_00000000000000b1", "1/3"}, {"t_00000000000000b2", "1/1"},
                                                           {"t_00000000000000b3", "0/1"}}));
  CHECK(s.trees.openedReads.empty());
}

TEST(remove_soft_deletes_an_owned_tree_and_it_leaves_the_list) {
  Setup s;
  UserId me = uid("me");
  seed(s.trees, "t", me, 100, {spec("a", NodeColor::sky)});

  CHECK_EQ(s.registry.list(me).size(), 1u);
  CHECK(s.registry.remove(tid("t"), me) == Removal{Cascade{}});
  CHECK_EQ(s.registry.list(me).size(), 0u);
}

TEST(remove_refuses_a_non_owner_and_an_unknown_tree) {
  Setup s;
  seed(s.trees, "t", uid("owner"), 100, {spec("a", NodeColor::sky)});  // private by default

  CHECK(s.registry.remove(tid("t"), uid("intruder")) == Removal{TreeRegistry::RemovalRefusal::notFound});
  CHECK(s.registry.remove(tid("ghost"), uid("owner")) == Removal{TreeRegistry::RemovalRefusal::notFound});
  CHECK_EQ(s.registry.list(uid("owner")).size(), 1u);

  s.trees.byId["t"].visibility = Visibility::unlisted;
  CHECK(s.registry.remove(tid("t"), uid("intruder")) == Removal{TreeRegistry::RemovalRefusal::notYours});
  CHECK_EQ(s.registry.list(uid("owner")).size(), 1u);

  s.trees.byId["t"].owner = std::nullopt;
  CHECK(s.registry.remove(tid("t"), uid("intruder")) == Removal{TreeRegistry::RemovalRefusal::nobodysTree});
  CHECK(s.trees.byId.count("t") == 1u);
}

TEST(rename_retitles_an_owned_tree_trimmed_and_the_list_shows_it) {
  Setup s;
  UserId me = uid("me");
  seed(s.trees, "t", me, 100, {spec("a", NodeColor::sky)});

  CHECK(s.registry.rename(tid("t"), me, "  Autumn plans  ") == TreeRegistry::Renaming::renamed);

  CHECK(s.trees.byId["t"].title == (Lww<std::string>{"Autumn plans", Hlc{1'700'000'000'000, 0, "srv"}}));
  std::vector<TreeSummary> rows = s.registry.list(me);
  REQUIRE_EQ(rows.size(), 1u);
  CHECK_EQ(rows[0].title, std::string("Autumn plans"));
  CHECK(s.rooms.isOpen(tid("t")));  // written through the tree's room, opened for it
}

// A tree the caller may not read is answered as an absent one, never as someone else's.
TEST(rename_refuses_a_non_owner_and_an_unknown_tree) {
  Setup s;
  seed(s.trees, "t", uid("owner"), 100, {spec("a", NodeColor::sky)});

  CHECK(s.registry.rename(tid("t"), uid("intruder"), "Mine now") == TreeRegistry::Renaming::notFound);
  CHECK(s.registry.rename(tid("ghost"), uid("owner"), "Anything") == TreeRegistry::Renaming::notFound);
  s.trees.byId["t"].visibility = Visibility::unlisted;
  CHECK(s.registry.rename(tid("t"), uid("intruder"), "Mine now") == TreeRegistry::Renaming::notYours);
  s.trees.byId["t"].owner = std::nullopt;
  CHECK(s.registry.rename(tid("t"), uid("intruder"), "Mine now") == TreeRegistry::Renaming::nobodysTree);
  CHECK_EQ(s.trees.byId["t"].title.value, std::string("t"));
}

TEST(rename_refuses_a_blank_title_because_a_tree_always_has_a_name) {
  Setup s;
  UserId me = uid("me");
  seed(s.trees, "t", me, 100, {spec("a", NodeColor::sky)});

  CHECK(s.registry.rename(tid("t"), me, "") == TreeRegistry::Renaming::blankTitle);
  CHECK(s.registry.rename(tid("t"), me, "   \t\n") == TreeRegistry::Renaming::blankTitle);
  CHECK_EQ(s.trees.byId["t"].title.value, std::string("t"));
}

TEST(rename_truncates_a_marathon_title_to_two_hundred_characters) {
  Setup s;
  UserId me = uid("me");
  seed(s.trees, "t", me, 100, {spec("a", NodeColor::sky)});

  CHECK(s.registry.rename(tid("t"), me, "  " + std::string(5000, 'x') + "  ") == TreeRegistry::Renaming::renamed);
  CHECK_EQ(s.trees.byId["t"].title.value, std::string(200, 'x'));

  std::string accented;  // 300 two-byte codepoints: the cap counts characters, not bytes
  for (int i = 0; i < 300; ++i) accented += "é";
  CHECK(s.registry.rename(tid("t"), me, accented) == TreeRegistry::Renaming::renamed);
  std::string expected;
  for (int i = 0; i < 200; ++i) expected += "é";
  CHECK_EQ(s.trees.byId["t"].title.value, expected);
}

TEST(rename_of_a_live_tree_flows_through_the_room_and_reaches_subscribers) {
  Setup s;
  UserId me = uid("me");
  seed(s.trees, "t", me, 100, {spec("a", NodeColor::sky)});
  TreeRoom& room = *s.rooms.open(tid("t"));

  CHECK(s.registry.rename(tid("t"), me, "Second wind") == TreeRegistry::Renaming::renamed);

  const Lww<std::string> renamed{"Second wind", Hlc{1'700'000'000'000, 0, "srv"}};
  CHECK(room.title() == renamed);
  CHECK(s.trees.byId["t"].title == renamed);
  REQUIRE_EQ(s.bus.subgraphBroadcasts.size(), 1u);
  const FakeBus::SubgraphBroadcast& broadcast = s.bus.subgraphBroadcasts[0];
  CHECK_EQ(broadcast.tree, std::string("t"));
  CHECK_EQ(broadcast.seq, room.head());
  REQUIRE(broadcast.subgraph.title.has_value());
  CHECK(*broadcast.subgraph.title == renamed);
  CHECK(broadcast.subgraph.graph.nodes.empty());
  CHECK(broadcast.subgraph.legend.kinds.empty());
}

TEST(a_joined_frame_carrying_a_title_register_renames_by_last_writer_wins) {
  Setup s;
  UserId me = uid("me");
  seed(s.trees, "t", me, 100, {spec("a", NodeColor::sky)});
  TreeRoom& room = *s.rooms.open(tid("t"));

  Subgraph fresh;
  fresh.treeId = tid("t");
  fresh.frameId = "f-fresh";
  fresh.actor = "r_a";
  fresh.title = Lww<std::string>{"Client name", Hlc{2000, 0, "r_a"}};
  room.joinSubgraph(fresh, me);
  CHECK(room.title() == (Lww<std::string>{"Client name", Hlc{2000, 0, "r_a"}}));

  Subgraph stale;
  stale.treeId = tid("t");
  stale.frameId = "f-stale";
  stale.actor = "r_b";
  stale.title = Lww<std::string>{"Older name", Hlc{1500, 0, "r_b"}};
  room.joinSubgraph(stale, me);
  CHECK(room.title() == (Lww<std::string>{"Client name", Hlc{2000, 0, "r_a"}}));
}

TEST(a_renames_stamp_survives_eviction_and_an_older_stamped_write_after_reload_loses) {
  Setup s;
  UserId me = uid("me");
  seed(s.trees, "t", me, 100, {spec("a", NodeColor::sky)});
  s.rooms.open(tid("t"));
  CHECK(s.registry.rename(tid("t"), me, "Renamed live") == TreeRegistry::Renaming::renamed);
  const Lww<std::string> renamed{"Renamed live", Hlc{1'700'000'000'000, 0, "srv"}};
  CHECK(s.trees.byId["t"].title == renamed);

  s.rooms.evict(tid("t"));
  CHECK_FALSE(s.rooms.isOpen(tid("t")));
  CHECK(s.trees.byId["t"].title == renamed);

  TreeRoom& reloaded = *s.rooms.open(tid("t"));
  CHECK(reloaded.title() == renamed);

  Subgraph stale;  // the F2 replay: an older-stamped rename arriving only after the restart
  stale.treeId = tid("t");
  stale.frameId = "f-stale";
  stale.actor = "r_b";
  stale.title = Lww<std::string>{"Older name", Hlc{1'699'999'999'000, 0, "r_b"}};
  reloaded.joinSubgraph(stale, me);
  CHECK(reloaded.title() == renamed);
  s.rooms.persist(tid("t")).wait();
  CHECK(s.trees.byId["t"].title == renamed);

  CHECK(s.registry.rename(tid("t"), me, "Renamed again") == TreeRegistry::Renaming::renamed);
  CHECK(reloaded.title() == (Lww<std::string>{"Renamed again", Hlc{1'700'000'000'000, 1, "srv"}}));
  CHECK(s.trees.byId["t"].title == (Lww<std::string>{"Renamed again", Hlc{1'700'000'000'000, 1, "srv"}}));
}

// A rename is stamped by the tree's room, past every stamp the tree holds, whether a room was open or not. A server
// stamp can be ahead of the wall clock — a command minted past a replica's fast clock — and a tab's vector holds it: a
// rename made after the room closed is still past it, so the tab is sent the rename on its return.
TEST(a_rename_made_while_no_room_is_open_reaches_a_tab_whose_vector_holds_a_server_stamp_ahead_of_the_clock) {
  Setup s;
  UserId me = uid("me");
  seed(s.trees, "t", me, 100, {spec("a", NodeColor::sky)});
  TreeRoom& room = *s.rooms.open(tid("t"));
  const std::uint64_t ahead = s.clock.nowMs() + 200'000;
  Subgraph fast;
  fast.treeId = tid("t");
  fast.frameId = "f-fast";
  fast.actor = "r_phone";
  fast.graph.nodes.push_back(NodeStateEntry{.id = nid("a"), .label = "From a fast clock", .labelAt = Hlc{ahead, 0, "r_phone"}});
  REQUIRE(room.joinSubgraph(fast, me).has_value());
  room.applyCommand(SetNodeColor{nid("a"), NodeColor::plum}, s.clock.nowMs(), me);
  const VersionVector tabHolds = *room.deltaSince(VersionVector{}).coverage;
  const Seq tabApplied = room.head();
  REQUIRE(tabHolds.covers(Hlc{ahead, 1, "srv"}));
  REQUIRE(s.rooms.persist(tid("t")).wait() == Saved::saved);
  REQUIRE(s.rooms.evict(tid("t")));

  CHECK(s.registry.rename(tid("t"), me, "Renamed with no room open") == TreeRegistry::Renaming::renamed);

  const Lww<std::string> renamed{"Renamed with no room open", Hlc{ahead, 2, "srv"}};
  CHECK(s.trees.byId["t"].title == renamed);
  const Subgraph returned = s.rooms.open(tid("t"))->deltaSince(tabHolds, tabApplied);
  REQUIRE(returned.title.has_value());
  CHECK(*returned.title == renamed);
}

TEST(set_visibility_reshares_an_owned_tree_and_the_column_reflects_it) {
  Setup s;
  UserId me = uid("me");
  seed(s.trees, "t", me, 100, {spec("a", NodeColor::sky)});
  CHECK(s.trees.byId["t"].visibility == Visibility::private_);

  CHECK(s.registry.setVisibility(tid("t"), me, Visibility::unlisted) ==
        VisibilityAnswer{TreeRegistry::VisibilityChange::changed});
  CHECK(s.trees.byId["t"].visibility == Visibility::unlisted);

  CHECK(s.registry.setVisibility(tid("t"), me, Visibility::private_) ==
        VisibilityAnswer{TreeRegistry::VisibilityChange::changed});
  CHECK(s.trees.byId["t"].visibility == Visibility::private_);
}

// A tree the caller may not read is answered as an absent one, never as someone else's.
TEST(set_visibility_refuses_a_non_owner_and_an_unknown_tree) {
  Setup s;
  seed(s.trees, "t", uid("owner"), 100, {spec("a", NodeColor::sky)});

  CHECK(s.registry.setVisibility(tid("t"), uid("intruder"), Visibility::public_) ==
        VisibilityAnswer{TreeRegistry::VisibilityChange::notFound});
  CHECK(s.registry.setVisibility(tid("ghost"), uid("owner"), Visibility::public_) ==
        VisibilityAnswer{TreeRegistry::VisibilityChange::notFound});
  s.trees.byId["t"].visibility = Visibility::unlisted;
  CHECK(s.registry.setVisibility(tid("t"), uid("intruder"), Visibility::public_) ==
        VisibilityAnswer{TreeRegistry::VisibilityChange::notYours});
  s.trees.byId["t"].owner = std::nullopt;
  CHECK(s.registry.setVisibility(tid("t"), uid("intruder"), Visibility::public_) ==
        VisibilityAnswer{TreeRegistry::VisibilityChange::nobodysTree});
  CHECK(s.trees.byId["t"].visibility == Visibility::unlisted);
}

TEST(set_visibility_flips_a_live_rooms_cache_at_once) {
  Setup s;
  UserId me = uid("me");
  seed(s.trees, "t", me, 100, {spec("a", NodeColor::sky)});
  TreeRoom& room = *s.rooms.open(tid("t"));
  CHECK(room.visibility() == Visibility::private_);

  CHECK(s.registry.setVisibility(tid("t"), me, Visibility::unlisted) ==
        VisibilityAnswer{TreeRegistry::VisibilityChange::changed});
  CHECK(room.visibility() == Visibility::unlisted);
  CHECK(s.trees.byId["t"].visibility == Visibility::unlisted);
}

TEST(a_stale_rooms_save_cannot_revert_a_newer_persisted_rename) {
  Setup s;
  UserId me = uid("me");
  seed(s.trees, "t", me, 100, {spec("a", NodeColor::sky)});
  s.rooms.open(tid("t"));
  CHECK(s.registry.rename(tid("t"), me, "First name") == TreeRegistry::Renaming::renamed);

  // The stored register is newer than the room's cache: the F1 guard must let the flush land everything but the title.
  const Lww<std::string> newer{"Newer name", Hlc{1'700'000'060'000, 0, "srv"}};
  s.trees.byId["t"].title = newer;

  s.rooms.persist(tid("t")).wait();

  CHECK(s.trees.byId["t"].title == newer);
  CHECK_EQ(s.trees.byId["t"].head, static_cast<Seq>(1));   // the rest of the save still landed
}

TEST(registry_remove_retires_the_live_room_and_announces_the_change) {
  Setup s;
  seed(s.trees, "t", uid("alice"), 100, {});
  std::vector<std::string> announced;
  s.rooms.whenAccessChanges([&](const TreeId& id) { announced.push_back(id.str()); });

  s.rooms.open(tid());
  REQUIRE(s.rooms.isOpen(tid()));

  CHECK(s.registry.remove(tid(), uid("alice")) == Removal{Cascade{}});
  CHECK_FALSE(s.rooms.isOpen(tid()));
  CHECK_EQ(announced.size(), 1u);
  CHECK_EQ(announced.front(), std::string("t"));
  CHECK_FALSE(s.rooms.accessOf(tid()).has_value());
}

TEST(registry_remove_refused_leaves_the_live_room_standing) {
  Setup s;
  seed(s.trees, "t", uid("alice"), 100, {});
  std::vector<std::string> announced;
  s.rooms.whenAccessChanges([&](const TreeId& id) { announced.push_back(id.str()); });

  s.rooms.open(tid());
  CHECK(s.registry.remove(tid(), uid("mallory")) == Removal{TreeRegistry::RemovalRefusal::notFound});
  CHECK(s.rooms.isOpen(tid()));
  CHECK(announced.empty());
}

TEST(rename_refuses_a_title_that_is_not_valid_utf8_and_keeps_the_old_name) {
  Setup s;
  UserId me = uid("me");
  seed(s.trees, "t", me, 100, {spec("a", NodeColor::sky)});

  CHECK(s.registry.rename(tid("t"), me, std::string(300, '\x80')) == TreeRegistry::Renaming::malformedTitle);
  CHECK(s.registry.rename(tid("t"), me, "cut \xE2\x82") == TreeRegistry::Renaming::malformedTitle);
  CHECK_EQ(s.trees.byId["t"].title.value, std::string("t"));
  CHECK(s.registry.rename(tid("t"), me, "\xE5\xAD\x97 \xF0\x9F\x98\x80") == TreeRegistry::Renaming::renamed);
  CHECK_EQ(s.trees.byId["t"].title.value, std::string("\xE5\xAD\x97 \xF0\x9F\x98\x80"));
}

TEST(rename_and_set_guide_refuse_a_nul_character_and_keep_what_the_tree_holds) {
  Setup s;
  UserId me = uid("me");
  seed(s.trees, "t", me, 100, {spec("a", NodeColor::sky)});
  s.rooms.open(tid("t"));
  const std::string nul("before\0after", 12);

  CHECK(s.registry.rename(tid("t"), me, nul) == TreeRegistry::Renaming::nulInTitle);
  CHECK(s.registry.rename(tid("t"), me, "  " + nul + "  ") == TreeRegistry::Renaming::nulInTitle);
  const auto refused = s.registry.setGuide(tid("t"), me, nul);
  REQUIRE(std::holds_alternative<Admission>(refused));
  CHECK(std::get<Admission>(refused).verdict == Admission::Verdict::malformed);
  CHECK_EQ(std::get<Admission>(refused).reason, std::string("the guide contains a NUL character"));

  CHECK_EQ(s.trees.byId["t"].title.value, std::string("t"));
  CHECK(s.trees.byId["t"].guide == Lww<std::string>{});
  CHECK(s.rooms.open(tid("t"))->title() == (Lww<std::string>{"t", {}}));
  CHECK(s.rooms.open(tid("t"))->guide() == Lww<std::string>{});
  CHECK(s.bus.subgraphBroadcasts.empty());
}

TEST(set_guide_answers_not_found_when_the_row_went_away_under_a_live_room) {
  Setup s;
  UserId me = uid("me");
  seed(s.trees, "retired", me, 100, {spec("a", NodeColor::sky)});
  seed(s.trees, "erased", me, 100, {spec("a", NodeColor::sky)});
  s.rooms.open(tid("retired"));
  s.rooms.open(tid("erased"));
  s.trees.deletedIds.insert("retired");  // soft-deleted outside this registry, its row kept
  s.trees.byId.erase("erased");          // erased outside this registry

  CHECK(std::get<TreeRegistry::GuideRefusal>(s.registry.setGuide(tid("retired"), me, "A ghost's guide")) ==
        TreeRegistry::GuideRefusal::notFound);
  CHECK(std::get<TreeRegistry::GuideRefusal>(s.registry.setGuide(tid("erased"), me, "A ghost's guide")) ==
        TreeRegistry::GuideRefusal::notFound);
  CHECK(s.trees.byId["retired"].guide == Lww<std::string>{});
  CHECK_EQ(s.trees.byId.count("erased"), std::size_t{0});
  CHECK_FALSE(s.rooms.isOpen(tid("retired")));
  CHECK_FALSE(s.rooms.isOpen(tid("erased")));
  CHECK_FALSE(s.rooms.accessOf(tid("retired")).has_value());
}

TEST(set_guide_writes_an_owned_trees_guide_leaving_no_op_row_and_an_empty_one_clears_it) {
  Setup s;
  UserId me = uid("me");
  seed(s.trees, "t", me, 100, {spec("a", NodeColor::sky)});

  const auto written = s.registry.setGuide(tid("t"), me, "Work the trunk first; leaves can wait.");
  CHECK(std::get<TreeRegistry::Described>(written).seq == Seq{1});
  CHECK(s.trees.byId["t"].guide ==
        (Lww<std::string>{"Work the trunk first; leaves can wait.", Hlc{1'700'000'000'000, 0, "srv"}}));
  CHECK_EQ(s.trees.byId["t"].title.value, std::string("t"));
  CHECK(s.ops.byTree.empty());

  const auto cleared = s.registry.setGuide(tid("t"), me, "");
  CHECK(std::get<TreeRegistry::Described>(cleared).seq == Seq{2});
  CHECK(s.trees.byId["t"].guide == (Lww<std::string>{"", Hlc{1'700'000'000'000, 1, "srv"}}));
  CHECK(s.ops.byTree.empty());
}

TEST(set_guide_refuses_a_non_owner_and_reads_a_tree_they_cannot_see_as_absent) {
  Setup s;
  seed(s.trees, "t", uid("owner"), 100, {spec("a", NodeColor::sky)});
  const Lww<std::string> before = s.trees.byId["t"].guide;

  CHECK(std::get<TreeRegistry::GuideRefusal>(s.registry.setGuide(tid("t"), uid("intruder"), "Mine now")) ==
        TreeRegistry::GuideRefusal::notFound);
  s.trees.byId["t"].visibility = Visibility::unlisted;
  CHECK(std::get<TreeRegistry::GuideRefusal>(s.registry.setGuide(tid("t"), uid("intruder"), "Mine now")) ==
        TreeRegistry::GuideRefusal::notYours);
  s.trees.byId["t"].owner = std::nullopt;
  CHECK(std::get<TreeRegistry::GuideRefusal>(s.registry.setGuide(tid("t"), uid("intruder"), "Mine now")) ==
        TreeRegistry::GuideRefusal::nobodysTree);
  CHECK(std::get<TreeRegistry::GuideRefusal>(s.registry.setGuide(tid("ghost"), uid("owner"), "Anything")) ==
        TreeRegistry::GuideRefusal::notFound);

  CHECK(s.trees.byId["t"].guide == before);
  CHECK_FALSE(s.rooms.isOpen(tid("t")));
  CHECK(s.bus.subgraphBroadcasts.empty());
}

TEST(set_guide_holds_five_thousand_characters_of_any_width_and_refuses_one_more) {
  Setup s;
  UserId me = uid("me");
  seed(s.trees, "t", me, 100, {spec("a", NodeColor::sky)});
  std::string wide;  // 5000 three-byte characters: 15000 bytes
  for (std::size_t i = 0; i < kMaxGuideChars; ++i) wide += "\xE5\xAD\x97";

  CHECK(std::holds_alternative<TreeRegistry::Described>(s.registry.setGuide(tid("t"), me, wide)));
  CHECK_EQ(s.trees.byId["t"].guide.value, wide);

  const auto refused = s.registry.setGuide(tid("t"), me, wide + "x");
  REQUIRE(std::holds_alternative<Admission>(refused));
  CHECK(std::get<Admission>(refused).verdict == Admission::Verdict::malformed);
  CHECK_EQ(std::get<Admission>(refused).reason,
           std::string("the guide would be 5001 characters, 1 over the 5000 cap"));
  CHECK_EQ(s.trees.byId["t"].guide.value, wide);
}

TEST(set_guide_of_a_live_tree_flows_through_the_room_to_subscribers_and_survives_eviction) {
  Setup s;
  UserId me = uid("me");
  seed(s.trees, "t", me, 100, {spec("a", NodeColor::sky)});
  TreeRoom& room = *s.rooms.open(tid("t"));
  const Seq before = room.head();

  const auto written = s.registry.setGuide(tid("t"), me, "One branch a week.");

  const Lww<std::string> guide{"One branch a week.", Hlc{1'700'000'000'000, 0, "srv"}};
  CHECK(room.guide() == guide);
  CHECK(room.snapshot().guide == guide.value);
  CHECK(s.trees.byId["t"].guide == guide);
  CHECK_EQ(room.head(), before + 1);
  CHECK(std::get<TreeRegistry::Described>(written).seq == room.head());
  CHECK(room.pendingOps().empty());
  CHECK(s.ops.byTree.empty());
  REQUIRE_EQ(s.bus.subgraphBroadcasts.size(), 1u);
  const Subgraph& broadcast = s.bus.subgraphBroadcasts[0].subgraph;
  REQUIRE(broadcast.guide.has_value());
  CHECK(*broadcast.guide == guide);
  CHECK_FALSE(broadcast.title.has_value());
  CHECK(broadcast.graph.nodes.empty());
  CHECK(broadcast.legend.kinds.empty());

  s.rooms.evict(tid("t"));
  TreeRoom& reloaded = *s.rooms.open(tid("t"));
  CHECK(reloaded.guide() == guide);
  CHECK(std::holds_alternative<TreeRegistry::Described>(s.registry.setGuide(tid("t"), me, "Two branches a week.")));
  CHECK(reloaded.guide() == (Lww<std::string>{"Two branches a week.", Hlc{1'700'000'000'000, 1, "srv"}}));
}

TEST(two_rooms_joining_concurrent_guide_frames_in_opposite_orders_converge_on_one_guide) {
  Setup first;
  Setup second;
  UserId me = uid("me");
  seed(first.trees, "t", me, 100, {spec("a", NodeColor::sky)});
  seed(second.trees, "t", me, 100, {spec("a", NodeColor::sky)});
  TreeRoom& one = *first.rooms.open(tid("t"));
  TreeRoom& other = *second.rooms.open(tid("t"));

  Subgraph fromA;
  fromA.treeId = tid("t");
  fromA.frameId = "f-a";
  fromA.actor = "r_a";
  fromA.guide = Lww<std::string>{"Start with the hull.", Hlc{2000, 0, "r_a"}};
  Subgraph fromB = fromA;
  fromB.frameId = "f-b";
  fromB.actor = "r_b";
  fromB.guide = Lww<std::string>{"Start with the sails.", Hlc{2000, 0, "r_b"}};

  one.joinSubgraph(fromA, me);
  one.joinSubgraph(fromB, me);
  other.joinSubgraph(fromB, me);
  other.joinSubgraph(fromA, me);

  const Lww<std::string> winner{"Start with the sails.", Hlc{2000, 0, "r_b"}};
  CHECK(one.guide() == winner);
  CHECK(other.guide() == winner);
  first.rooms.persist(tid("t")).wait();
  second.rooms.persist(tid("t")).wait();
  CHECK(first.trees.byId["t"].guide == winner);
  CHECK(second.trees.byId["t"].guide == winner);
}

static NodeSpec opening(const char* id, const char* tree, std::vector<NodeId> prereqs = {}) {
  NodeSpec node = spec(id, NodeColor::sky, std::move(prereqs));
  node.opens = TreeId{std::string(tree)};
  return node;
}

// Each failure the cascade reports, as its operation, door, outcome and exception type.
struct Failures : FailureReporter {
  std::vector<std::string> reports;
  void report(const std::string&, const std::string&, const std::string&) override {}
  void reportWrite(const std::string& operation, const std::string& product, const std::string& door,
                   const std::string& outcome, const std::string&, const std::string& exceptionType) override {
    reports.push_back(operation + " " + product + " " + door + " " + outcome + " " + exceptionType);
  }
};

// A removal run the way the REST door runs it: inside the route's own write observation, finished `ok` or `refused`, with
// the lines it writes and the Issues it files captured.
struct AtTheDoor {
  std::shared_ptr<Failures> failures = std::make_shared<Failures>();
  std::vector<std::string> lines;
  AtTheDoor() {
    installWriteReporter(failures);
    installWriteSink([this](const WriteCompletion& line) {
      lines.push_back(line.operation + " " + line.product + " " + line.door + " " + line.outcome);
    });
  }
  ~AtTheDoor() {
    installWriteSink({});
    installWriteReporter(nullptr);
  }
  Removal remove(TreeRegistry& registry, const TreeId& tree, const UserId& caller) {
    WriteObservation route{"roadmap.DELETE.v1.trees.id", "roadmap", "rest"};
    WriteContext context{route};
    const Removal removed = registry.remove(tree, caller);
    route.finish(std::holds_alternative<Cascade>(removed) ? "ok" : "refused");
    return removed;
  }
};

// Openers come from the trees the list already holds: only the owner's standing trees count, a tree's pointers at
// itself go with it, and no read is made past the list's own, however many trees there are.
TEST(list_names_for_each_tree_the_owners_other_trees_whose_steps_open_it_and_reads_nothing_more) {
  Setup s;
  UserId me = uid("me");
  seed(s.trees, "t_target", me, 100, {spec("t1", NodeColor::sky), opening("self", "t_target")});
  seed(s.trees, "t_a", me, 90, {opening("a1", "t_target"), spec("a2", NodeColor::sky)});
  seed(s.trees, "t_b", me, 80, {opening("b1", "t_target"), opening("b2", "t_target"), opening("b3", "t_eves")});
  seed(s.trees, "t_lonely", me, 70, {spec("l1", NodeColor::sky)});
  seed(s.trees, "t_gone", me, 60, {opening("g1", "t_target")});
  s.trees.deletedIds.insert("t_gone");
  seed(s.trees, "t_eves", uid("eve"), 50, {opening("e1", "t_target"), opening("e2", "t_lonely")});

  std::map<std::string, std::vector<OpeningSteps>> openers;
  for (const TreeSummary& row : s.registry.list(me)) openers[row.id.str()] = row.openers;

  CHECK(openers == (std::map<std::string, std::vector<OpeningSteps>>{
                       {"t_target", {{tid("t_a"), 1}, {tid("t_b"), 2}}}, {"t_a", {}}, {"t_b", {}}, {"t_lonely", {}}}));
  CHECK(s.trees.openedReads.empty());
  CHECK(s.trees.titleReads.empty());
  CHECK(s.trees.aboveReads.empty());
  CHECK(s.trees.openingReads.empty());
}

// The removed tree's steps go from every tree of the owner's that opened it, live room or closed, each as one op that
// takes the edges they dangled and the owner's marks on them; a step behind one is free; the reply names what went,
// and each tree edited writes its line at the removal's door.
TEST(remove_takes_the_steps_that_open_the_tree_from_each_of_the_owners_trees_with_their_edges_and_marks) {
  Setup s;
  AtTheDoor door;
  UserId me = uid("me");
  seed(s.trees, "t_target", me, 100, {spec("t1", NodeColor::sky)});
  seed(s.trees, "t_open", me, 90,
       {opening("o1", "t_target"), spec("o2", NodeColor::sky, {nid("o1")}), spec("o3", NodeColor::sky)});
  seed(s.trees, "t_closed", me, 80,
       {opening("c1", "t_target"), opening("c2", "t_target"), spec("c3", NodeColor::sky, {nid("c1"), nid("c2")})});
  seed(s.trees, "t_other", me, 70, {spec("x1", NodeColor::sky)});
  // A mark held before the pointer was set, the one way a step that opens a tree holds its owner's mark, and one beside it.
  s.progress.byKey[FakeProgressRepository::key(tid("t_open"), me, nid("o1"))] = {ProgressStatus::complete, at(5, "me")};
  s.progress.byKey[FakeProgressRepository::key(tid("t_open"), me, nid("o3"))] = {ProgressStatus::complete, at(5, "me")};
  s.rooms.open(tid("t_open"));

  Cascade went;
  went.removed[tid("t_closed")] = {nid("c1"), nid("c2")};
  went.removed[tid("t_open")] = {nid("o1")};
  CHECK(door.remove(s.registry, tid("t_target"), me) == Removal{went});

  const auto held = [&](const char* tree) {
    const LooseGraph graph(s.trees.byId[tree].state);
    std::map<std::string, std::vector<NodeId>> nodes;
    for (const NodeSpec& node : graph.toTreeData(tid(tree), "").nodes) nodes[node.id.str()] = node.prerequisites;
    return nodes;
  };
  CHECK(held("t_open") == (std::map<std::string, std::vector<NodeId>>{{"o2", {}}, {"o3", {}}}));
  CHECK(held("t_closed") == (std::map<std::string, std::vector<NodeId>>{{"c3", {}}}));
  CHECK(held("t_other") == (std::map<std::string, std::vector<NodeId>>{{"x1", {}}}));
  const LooseGraph closed(s.trees.byId["t_closed"].state);
  CHECK_FALSE(closed.edgePresent(nid("c1"), nid("c3")));
  CHECK_FALSE(closed.edgePresent(nid("c2"), nid("c3")));
  const LooseGraph open(s.trees.byId["t_open"].state);
  CHECK_FALSE(open.edgePresent(nid("o1"), nid("o2")));
  CHECK(UnlockRules::derive(open.toTreeData(tid("t_open"), "").nodes, s.progress.load(tid("t_open"), me)).at(nid("o2")) ==
        NodeState::available);

  CHECK(s.progress.byKey.at(FakeProgressRepository::key(tid("t_open"), me, nid("o1"))).status == ProgressStatus::none);
  CHECK(s.progress.byKey.at(FakeProgressRepository::key(tid("t_open"), me, nid("o3"))).status == ProgressStatus::complete);
  REQUIRE_EQ(s.bus.progressBroadcasts.size(), 1u);
  CHECK_EQ(s.bus.progressBroadcasts[0].tree, std::string("t_open"));
  CHECK_EQ(s.bus.progressBroadcasts[0].user, std::string("me"));

  // One live frame per tree edited, the closed one opened for it, each a delete of its steps alone.
  std::map<std::string, std::vector<std::string>> deletedInFrame;
  for (const FakeBus::SubgraphBroadcast& frame : s.bus.subgraphBroadcasts)
    for (const NodeStateEntry& node : frame.subgraph.graph.nodes)
      if (node.deletedAt.isSet()) deletedInFrame[frame.tree].push_back(node.id.str());
  CHECK(deletedInFrame == (std::map<std::string, std::vector<std::string>>{{"t_closed", {"c1", "c2"}}, {"t_open", {"o1"}}}));
  CHECK_EQ(s.bus.subgraphBroadcasts.size(), 2u);
  CHECK(s.rooms.isOpen(tid("t_open")));
  CHECK(s.trees.openingReads == std::vector<TreeId>{tid("t_target")});

  CHECK(door.lines == (std::vector<std::string>{"roadmap.tree.remove.cascade roadmap rest ok",
                                                "roadmap.tree.remove.cascade roadmap rest ok",
                                                "roadmap.DELETE.v1.trees.id roadmap rest ok"}));
  CHECK(door.failures->reports.empty());
}

// Two trees that open each other: removing one takes the step of the other that opened it, and nothing else.
TEST(remove_of_one_of_two_trees_that_open_each_other_takes_the_others_opening_step_alone) {
  Setup s;
  UserId me = uid("me");
  seed(s.trees, "t_a", me, 100, {opening("a1", "t_b"), spec("a2", NodeColor::sky, {nid("a1")})});
  seed(s.trees, "t_b", me, 90, {opening("b1", "t_a"), spec("b2", NodeColor::sky, {nid("b1")}), opening("b3", "t_b")});
  const GraphState removedWhole = s.trees.byId["t_a"].state;

  Cascade went;
  went.removed[tid("t_b")] = {nid("b1")};
  CHECK(s.registry.remove(tid("t_a"), me) == Removal{went});

  std::vector<std::string> standing;
  for (const NodeSpec& node : LooseGraph(s.trees.byId["t_b"].state).toTreeData(tid("t_b"), "").nodes)
    standing.push_back(node.id.str());
  CHECK(standing == (std::vector<std::string>{"b2", "b3"}));
  CHECK(s.trees.byId["t_a"].state == removedWhole);
  CHECK_EQ(s.bus.subgraphBroadcasts.size(), 1u);
}

// A tree that cannot be edited part-way through keeps its steps and is named in `incomplete`; the trees edited before
// and after it stay edited, its line is `failed`, and the removal files one Issue under the cascade's name.
// Each tree is answered as what became of it. A save that fails once the delete applied leaves the steps gone from the
// room, unsaved and held: its line and the removal's own read held-unsaved, the outage is reported by the registry
// under a request of its own, and the registry's retry keeps the steps gone with no further call. A tree whose room
// cannot be opened keeps its steps, incomplete, on a failed line, and that failure is the removal's own Issue.
TEST(remove_answers_each_tree_removed_unsaved_or_incomplete_as_it_is_and_files_one_issue) {
  Setup s;
  AtTheDoor door;
  UserId me = uid("me");
  seed(s.trees, "t_target", me, 100, {spec("t1", NodeColor::sky)});
  seed(s.trees, "t_a", me, 90, {opening("a1", "t_target")});
  seed(s.trees, "t_b", me, 80, {opening("b1", "t_target"), spec("b2", NodeColor::sky, {nid("b1")})});
  seed(s.trees, "t_c", me, 70, {opening("c1", "t_target")});
  seed(s.trees, "t_d", me, 60, {opening("d1", "t_target")});
  bool savesOfBFail = true;
  s.trees.duringSave = [&](const TreeId& tree) {
    if (savesOfBFail && tree == tid("t_b")) throw std::runtime_error("the write was refused");
  };
  s.trees.latticeLoadsFailFor.insert("t_c");
  const GraphState storedB = s.trees.byId["t_b"].state;
  const GraphState storedC = s.trees.byId["t_c"].state;

  Cascade went;
  went.removed[tid("t_a")] = {nid("a1")};
  went.removed[tid("t_d")] = {nid("d1")};
  went.unsaved = {tid("t_b")};
  went.incomplete = {tid("t_c")};
  CHECK(door.remove(s.registry, tid("t_target"), me) == Removal{went});

  CHECK(s.trees.byId["t_b"].state == storedB);
  REQUIRE(s.rooms.isOpen(tid("t_b")));
  CHECK_FALSE(s.rooms.open(tid("t_b"))->hasNode(nid("b1")));
  CHECK(s.trees.byId["t_c"].state == storedC);
  CHECK_FALSE(s.rooms.isOpen(tid("t_c")));
  CHECK(door.lines == (std::vector<std::string>{"roadmap.tree.remove.cascade roadmap rest ok",
                                                "roadmap.tree.save roadmap rest failed",
                                                "roadmap.tree.remove.cascade roadmap rest held-unsaved",
                                                "roadmap.tree.remove.cascade roadmap rest failed",
                                                "roadmap.tree.remove.cascade roadmap rest ok",
                                                "roadmap.DELETE.v1.trees.id roadmap rest held-unsaved"}));
  CHECK(door.failures->reports ==
        (std::vector<std::string>{std::string("roadmap.tree.save roadmap rest failed ") + typeid(std::runtime_error).name(),
                                  std::string("roadmap.tree.remove.cascade roadmap rest failed ") +
                                      typeid(std::runtime_error).name()}));

  savesOfBFail = false;
  REQUIRE_EQ(s.retries.set.size(), 1u);
  s.retries.set[0].run();
  std::vector<std::string> standing;
  for (const NodeSpec& node : LooseGraph(s.trees.byId["t_b"].state).toTreeData(tid("t_b"), "").nodes)
    standing.push_back(node.id.str() + "<" + std::to_string(node.prerequisites.size()));
  CHECK(standing == std::vector<std::string>{"b2<0"});
}

// An erasure racing the removal takes a tree's row between the room's open and its save: the delete applied in the
// room, which goes with the row, and the tree is answered unsaved under the one Issue.
TEST(remove_answers_a_tree_whose_row_went_away_under_its_room_as_unsaved) {
  Setup s;
  AtTheDoor door;
  UserId me = uid("me");
  seed(s.trees, "t_target", me, 100, {spec("t1", NodeColor::sky)});
  seed(s.trees, "t_a", me, 90, {opening("a1", "t_target")});
  s.progress.byKey[FakeProgressRepository::key(tid("t_a"), me, nid("a1"))] = {ProgressStatus::complete, at(5, "me")};
  s.progress.duringBatchWrite = [&] { s.trees.deletedIds.insert("t_a"); };

  Cascade went;
  went.unsaved = {tid("t_a")};
  CHECK(door.remove(s.registry, tid("t_target"), me) == Removal{went});

  CHECK_FALSE(s.rooms.isOpen(tid("t_a")));
  CHECK(door.lines == (std::vector<std::string>{"roadmap.tree.remove.cascade roadmap rest unsaved",
                                                "roadmap.DELETE.v1.trees.id roadmap rest ok"}));
  CHECK(door.failures->reports ==
        (std::vector<std::string>{std::string("roadmap.tree.remove.cascade roadmap rest unsaved ") +
                                  typeid(TreeRowGone).name()}));
}

// A tree whose steps that opened the removed one are gone from its room since the read — deleted there, not yet saved —
// has nothing taken: no op, no seq, no frame and no line, and the reply does not name it.
TEST(remove_takes_nothing_from_a_tree_whose_opening_steps_are_already_gone_and_does_not_name_it) {
  Setup s;
  AtTheDoor door;
  UserId me = uid("me");
  seed(s.trees, "t_target", me, 100, {spec("t1", NodeColor::sky)});
  seed(s.trees, "t_a", me, 90, {opening("a1", "t_target"), spec("a2", NodeColor::sky)});
  seed(s.trees, "t_b", me, 80, {opening("b1", "t_target")});
  TreeRoom* gone = s.rooms.open(tid("t_a"));
  REQUIRE(gone != nullptr);
  gone->applyCommand(DeleteNode{nid("a1")}, s.clock.now, me);
  const Seq head = gone->head();
  s.bus.subgraphBroadcasts.clear();

  Cascade went;
  went.removed[tid("t_b")] = {nid("b1")};
  CHECK(door.remove(s.registry, tid("t_target"), me) == Removal{went});

  CHECK_EQ(s.rooms.open(tid("t_a"))->head(), head);
  REQUIRE_EQ(s.bus.subgraphBroadcasts.size(), 1u);
  CHECK_EQ(s.bus.subgraphBroadcasts[0].tree, std::string("t_b"));
  CHECK(door.lines == (std::vector<std::string>{"roadmap.tree.remove.cascade roadmap rest ok",
                                                "roadmap.DELETE.v1.trees.id roadmap rest ok"}));
}

// The read and every tree's statements run under the cascade's limits, a lock waited for at most a second, and the
// cascade ends eight seconds after the read began: a tree it has not reached by then keeps its steps, incomplete, and
// writes no line of its own.
TEST(remove_stops_at_its_deadline_and_answers_the_trees_it_did_not_reach_as_incomplete) {
  Setup s;
  AtTheDoor door;
  UserId me = uid("me");
  seed(s.trees, "t_target", me, 100, {spec("t1", NodeColor::sky)});
  seed(s.trees, "t_a", me, 90, {opening("a1", "t_target")});
  seed(s.trees, "t_b", me, 80, {opening("b1", "t_target")});
  seed(s.trees, "t_c", me, 70, {opening("c1", "t_target")});
  const std::uint64_t began = s.clock.now;
  std::vector<std::string> limits;
  s.trees.duringSave = [&](const TreeId& tree) {
    const StatementLimits* open = StatementLimits::current();
    limits.push_back(tree.str() + (open ? " " + std::to_string(open->lockWait().count()) + "ms wait, " +
                                              std::to_string(open->remaining().count()) + "ms left"
                                        : " none"));
    s.clock.now += 5'000;
  };
  const GraphState storedC = s.trees.byId["t_c"].state;

  Cascade went;
  went.removed[tid("t_a")] = {nid("a1")};
  went.removed[tid("t_b")] = {nid("b1")};
  went.incomplete = {tid("t_c")};
  CHECK(door.remove(s.registry, tid("t_target"), me) == Removal{went});

  CHECK(limits == (std::vector<std::string>{"t_a 1000ms wait, 8000ms left", "t_b 1000ms wait, 3000ms left"}));
  CHECK(StatementLimits::current() == nullptr);
  CHECK_EQ(s.clock.now - began, 10'000u);
  CHECK(s.trees.byId["t_c"].state == storedC);
  CHECK_FALSE(s.rooms.isOpen(tid("t_c")));
  CHECK(door.lines == (std::vector<std::string>{"roadmap.tree.remove.cascade roadmap rest ok",
                                                "roadmap.tree.remove.cascade roadmap rest ok",
                                                "roadmap.DELETE.v1.trees.id roadmap rest ok"}));
}

// When the steps that open it cannot be read, nothing is removed: the removal is refused, the tree stands, and the read
// files the one Issue. Tried again once the read answers, it removes the tree and those steps.
TEST(remove_whose_openers_cannot_be_read_removes_nothing_and_is_refused_until_they_can_be) {
  Setup s;
  AtTheDoor door;
  UserId me = uid("me");
  seed(s.trees, "t_target", me, 100, {spec("t1", NodeColor::sky)});
  seed(s.trees, "t_a", me, 90, {opening("a1", "t_target")});
  const GraphState untouched = s.trees.byId["t_a"].state;
  s.trees.openingReadsFail = true;

  CHECK(door.remove(s.registry, tid("t_target"), me) == Removal{TreeRegistry::RemovalRefusal::cascadeUnavailable});

  CHECK_FALSE(s.trees.deletedIds.count("t_target"));
  CHECK(s.trees.byId["t_a"].state == untouched);
  CHECK(s.bus.subgraphBroadcasts.empty());
  CHECK(door.lines == (std::vector<std::string>{"roadmap.tree.remove.cascade roadmap rest failed",
                                                "roadmap.DELETE.v1.trees.id roadmap rest refused"}));
  CHECK(door.failures->reports ==
        (std::vector<std::string>{std::string("roadmap.tree.remove.cascade roadmap rest failed ") +
                                  typeid(std::runtime_error).name()}));

  s.trees.openingReadsFail = false;
  Cascade went;
  went.removed[tid("t_a")] = {nid("a1")};
  CHECK(s.registry.remove(tid("t_target"), me) == Removal{went});
  CHECK(s.trees.deletedIds.count("t_target"));
}

// A delete refused is refused as ever and edits nothing. The read made first is keyed on the caller's own trees and
// answers nothing for a tree that is not theirs, so even their own step that points at it is left alone.
TEST(remove_refused_to_a_non_owner_edits_nothing_of_the_trees_that_open_it) {
  Setup s;
  UserId owner = uid("owner");
  seed(s.trees, "t_target", owner, 100, {spec("t1", NodeColor::sky)});
  seed(s.trees, "t_a", owner, 90, {opening("a1", "t_target")});
  seed(s.trees, "t_mine", uid("intruder"), 80, {opening("m1", "t_target")});
  const GraphState opener = s.trees.byId["t_a"].state;
  const GraphState intrudersOwn = s.trees.byId["t_mine"].state;

  CHECK(s.registry.remove(tid("t_target"), uid("intruder")) == Removal{TreeRegistry::RemovalRefusal::notFound});
  s.trees.byId["t_target"].visibility = Visibility::unlisted;
  CHECK(s.registry.remove(tid("t_target"), uid("intruder")) == Removal{TreeRegistry::RemovalRefusal::notYours});

  CHECK_FALSE(s.trees.deletedIds.count("t_target"));
  CHECK(s.trees.openingReads == (std::vector<TreeId>{tid("t_target"), tid("t_target")}));
  CHECK(s.trees.byId["t_a"].state == opener);
  CHECK(s.trees.byId["t_mine"].state == intrudersOwn);
  CHECK(s.bus.subgraphBroadcasts.empty());
}

using SubtreeAnswer = std::variant<SubtreeCreation, SubtreeRefusal, Admission>;

// A tree of two steps, `rig` and `sail`, for subtrees to hang from.
static void seedParent(Setup& s, const char* id, const UserId& owner, std::vector<NodeSpec> steps = {}) {
  if (steps.empty()) steps = {spec("rig", NodeColor::sky), spec("sail", NodeColor::sky)};
  seed(s.trees, id, owner, 100, std::move(steps));
}

static TreeRegistry::SubtreeRequest proposing(const char* id) { return {TreeId{std::string(id)}, std::nullopt}; }

// The legend a tree is born with when it is sent `kinds`, at genesis, as create plants it.
static LegendState bornLegend(const std::vector<Kind>& kinds = {}) {
  return Legend(Legend::bornWith(kinds), Hlc{1, 0, "genesis"}).exportState();
}

TEST(create_subtree_stores_an_empty_child_under_the_step_and_a_retry_answers_it_with_nothing_written) {
  Setup s;
  AtTheDoor door;
  const UserId me = uid("me");
  seedParent(s, "t_p", me);
  s.trees.byId["t_p"].visibility = Visibility::unlisted;
  const Subtree child{TreeId{"t_00000000000000c1"}, tid("t_p"), OwningStep{tid("t_p"), nid("rig")}, 1, 0};

  CHECK(s.registry.createSubtree(tid("t_p"), nid("rig"), me, proposing("t_00000000000000c1")) ==
        (SubtreeAnswer{SubtreeCreation{true, child, 1}}));
  CHECK(s.trees.byId["t_00000000000000c1"] ==
        (StoredTree{GraphState{}, bornLegend(), {}, 0, me, Visibility::private_}));
  CHECK(s.trees.subtrees == (std::map<std::string, Subtree>{{"t_00000000000000c1", child}}));
  CHECK_EQ(s.trees.byId["t_p"].head, Seq{1});
  CHECK_EQ(s.rooms.open(tid("t_p"))->head(), Seq{1});
  CHECK(s.bus.subtreeBroadcasts == (std::vector<FakeBus::SubtreeBroadcast>{{"t_p", 1, nid("rig"), child}}));
  CHECK(s.bus.subgraphBroadcasts.empty());
  CHECK(s.rooms.open(tid("t_p"))->pendingOps().empty());
  // Its own visibility column holds private, and it is read by its root's.
  CHECK(s.rooms.accessOf(child.id) ==
        (std::optional<TreeAccess>(TreeAccess{me, Visibility::unlisted, tid("t_p"), {OwningStep{tid("t_p"), nid("rig")}}})));

  // The reply was lost: the same call, with the same proposed id or none, answers the same child and writes nothing.
  CHECK(s.registry.createSubtree(tid("t_p"), nid("rig"), me, proposing("t_00000000000000c1")) ==
        (SubtreeAnswer{SubtreeCreation{false, child, 1}}));
  CHECK(s.registry.createSubtree(tid("t_p"), nid("rig"), me) == (SubtreeAnswer{SubtreeCreation{false, child, 1}}));
  CHECK_EQ(s.trees.subtrees.size(), 1u);
  CHECK_EQ(s.trees.byId["t_p"].head, Seq{1});
  CHECK_EQ(s.bus.subtreeBroadcasts.size(), 1u);
  CHECK(door.lines == (std::vector<std::string>{"roadmap.subtree.create roadmap internal ok",
                                                "roadmap.subtree.create roadmap internal unchanged",
                                                "roadmap.subtree.create roadmap internal unchanged"}));
  CHECK(door.failures->reports.empty());
}

// The second call meets the first's child under the parent's strand, whichever comes first, so the step owns one.
TEST(two_creates_on_one_step_at_once_make_one_child_one_row_and_one_event) {
  for (int round = 0; round < 50; ++round) {
    Setup s;
    const UserId me = uid("me");
    seedParent(s, "t_p", me);
    std::promise<void> start;
    const std::shared_future<void> go = start.get_future().share();
    const auto create = [&s, &me, go] {
      go.wait();
      return s.registry.createSubtree(tid("t_p"), nid("rig"), me);
    };
    std::future<SubtreeAnswer> first = std::async(std::launch::async, create);
    std::future<SubtreeAnswer> second = std::async(std::launch::async, create);
    start.set_value();
    const SubtreeAnswer a = first.get();
    const SubtreeAnswer b = second.get();

    REQUIRE(std::holds_alternative<SubtreeCreation>(a) && std::holds_alternative<SubtreeCreation>(b));
    const SubtreeCreation& made = std::get<SubtreeCreation>(a).created ? std::get<SubtreeCreation>(a) : std::get<SubtreeCreation>(b);
    const SubtreeCreation& found = std::get<SubtreeCreation>(a).created ? std::get<SubtreeCreation>(b) : std::get<SubtreeCreation>(a);
    CHECK(made == (SubtreeCreation{true, Subtree{tid("t_d1"), tid("t_p"), OwningStep{tid("t_p"), nid("rig")}, 1, 0}, 1}));
    CHECK(found == (SubtreeCreation{false, made.subtree, 1}));
    CHECK_EQ(s.trees.subtrees.size(), 1u);
    CHECK_EQ(s.bus.subtreeBroadcasts.size(), 1u);
    CHECK_FALSE(s.rooms.accessOf(tid("t_00000000000000c1")).has_value());
  }
}

TEST(a_free_proposed_id_is_kept_and_one_any_row_holds_or_that_is_malformed_is_replaced_by_a_minted_one) {
  Setup s;
  const UserId me = uid("me");
  seedParent(s, "t_p", me, {spec("a", NodeColor::sky), spec("b", NodeColor::sky), spec("c", NodeColor::sky),
                            spec("d", NodeColor::sky)});
  seed(s.trees, "t_00000000000000e1", uid("eve"), 100, {});
  seed(s.trees, "t_00000000000000d1", me, 100, {});
  s.trees.deletedIds.insert("t_00000000000000d1");

  const auto idOf = [&s, &me](const char* step, const char* proposed) {
    const SubtreeAnswer answer = s.registry.createSubtree(tid("t_p"), nid(step), me, proposing(proposed));
    return std::get<SubtreeCreation>(answer).subtree.id.str();
  };
  CHECK_EQ(idOf("a", "t_00000000000000c1"), std::string("t_00000000000000c1"));
  CHECK_EQ(idOf("b", "t_00000000000000e1"), std::string("t_d1"));
  CHECK_EQ(idOf("c", "t_00000000000000d1"), std::string("t_d2"));
  CHECK_EQ(idOf("d", "not-a-tree-id"), std::string("t_d3"));
  CHECK(s.trees.byId["t_00000000000000e1"].owner == std::optional<UserId>(uid("eve")));
  CHECK(s.trees.deletedIds.count("t_00000000000000d1"));
}

// Another writer fills the step, or takes the proposed id, between the site and the store, as a second server process
// can: the step's child is answered, or a minted id taken, and neither is a failure.
// A subtree create moves its parent's stored head past whatever the parent's room has not saved, so against a parent
// held unsaved it is refused, save-pending, with nothing written: no child row, the stored head where it was, no event,
// one line with its code and no Issue. The refusal lifts by itself: once the registry's retry has saved the parent, the
// same call creates.
TEST(create_subtree_under_a_parent_held_unsaved_is_refused_save_pending_until_the_retry_saves_the_parent) {
  Setup s;
  const UserId me = uid("me");
  seedParent(s, "t_p", me);
  {
    std::unique_lock<std::mutex> strand(s.rooms.strandFor(tid("t_p")));
    s.rooms.open(tid("t_p"))->applyCommand(createNode("mast"), 10, me);
    s.trees.savesFail = true;
    PendingSave saving = s.rooms.persist(tid("t_p"));
    strand.unlock();
    REQUIRE(saving.wait() == Saved::held);
  }
  const Seq storedHead = s.trees.byId["t_p"].head;

  {
    AtTheDoor door;
    CHECK(s.registry.createSubtree(tid("t_p"), nid("rig"), me, proposing("t_00000000000000c1")) ==
          (SubtreeAnswer{SubtreeRefusal::savePending}));
    CHECK(door.lines == (std::vector<std::string>{"roadmap.subtree.create roadmap internal save-pending"}));
    CHECK(door.failures->reports.empty());
  }
  CHECK(s.trees.subtrees.empty());
  CHECK_FALSE(s.trees.byId.count("t_00000000000000c1"));
  CHECK_EQ(s.trees.byId["t_p"].head, storedHead);
  CHECK(s.bus.subtreeBroadcasts.empty());

  s.trees.savesFail = false;
  REQUIRE_EQ(s.retries.set.size(), 1u);
  s.retries.set[0].run();
  const Subtree child{TreeId{"t_00000000000000c1"}, tid("t_p"), OwningStep{tid("t_p"), nid("rig")}, 1, 0};
  CHECK(s.registry.createSubtree(tid("t_p"), nid("rig"), me, proposing("t_00000000000000c1")) ==
        (SubtreeAnswer{SubtreeCreation{true, child, storedHead + 2}}));
  CHECK(s.trees.subtrees == (std::map<std::string, Subtree>{{"t_00000000000000c1", child}}));
}

// The create writes the parent's head in its own transaction. A save of the parent still running would write an older
// head over it, and the create's would stand past writes the store does not hold: it waits for that save, with the
// strand let go, and stores its head after.
TEST(create_subtree_waits_for_a_save_of_its_parent_that_is_running_and_stores_the_parents_head_after_it) {
  Setup s;
  const UserId me = uid("me");
  seedParent(s, "t_p", me);
  HangingStore store;
  s.trees.duringSave = store.duringSave();
  PendingSave write = Saved::saved;
  Seq written = 0;
  {
    std::lock_guard<std::mutex> strand(s.rooms.strandFor(tid("t_p")));
    written = s.rooms.open(tid("t_p"))->applyCommand(createNode("mast"), 10, me);
    write = s.rooms.persist(tid("t_p"));
  }
  std::future<Saved> saving = std::async(std::launch::async, [&] { return write.wait(); });
  REQUIRE(store.reachedBy(1, std::chrono::seconds(10)));

  std::future<SubtreeAnswer> creating = std::async(std::launch::async, [&] {
    return s.registry.createSubtree(tid("t_p"), nid("rig"), me, proposing("t_00000000000000c1"));
  });
  const bool createdWhileTheSaveRan = creating.wait_for(std::chrono::milliseconds(300)) == std::future_status::ready;
  store.letGoOfIt();
  CHECK_FALSE(createdWhileTheSaveRan);
  CHECK(saving.get() == Saved::saved);
  const Subtree child{TreeId{"t_00000000000000c1"}, tid("t_p"), OwningStep{tid("t_p"), nid("rig")}, 1, 0};
  CHECK(creating.get() == (SubtreeAnswer{SubtreeCreation{true, child, written + 1}}));
  CHECK_EQ(s.trees.byId["t_p"].head, written + 1);
  CHECK_EQ(LooseGraph(s.trees.byId["t_p"].state).presentNodeIds().size(), 3u);
  CHECK(s.trees.subtrees == (std::map<std::string, Subtree>{{"t_00000000000000c1", child}}));
}

TEST(create_subtree_that_waited_for_a_save_of_its_parent_which_failed_is_refused_save_pending_with_nothing_stored) {
  Setup s;
  const UserId me = uid("me");
  seedParent(s, "t_p", me);
  const Seq storedHead = s.trees.byId["t_p"].head;
  HangingStore store;
  store.refuses = true;
  s.trees.duringSave = store.duringSave();
  PendingSave write = Saved::saved;
  {
    std::lock_guard<std::mutex> strand(s.rooms.strandFor(tid("t_p")));
    s.rooms.open(tid("t_p"))->applyCommand(createNode("mast"), 10, me);
    write = s.rooms.persist(tid("t_p"));
  }
  std::future<Saved> saving = std::async(std::launch::async, [&] { return write.wait(); });
  REQUIRE(store.reachedBy(1, std::chrono::seconds(10)));

  std::future<SubtreeAnswer> creating = std::async(std::launch::async, [&] {
    return s.registry.createSubtree(tid("t_p"), nid("rig"), me, proposing("t_00000000000000c1"));
  });
  const bool answeredWhileTheSaveRan = creating.wait_for(std::chrono::milliseconds(300)) == std::future_status::ready;
  store.letGoOfIt();
  CHECK_FALSE(answeredWhileTheSaveRan);
  CHECK(saving.get() == Saved::held);
  CHECK(creating.get() == (SubtreeAnswer{SubtreeRefusal::savePending}));
  CHECK(s.trees.subtrees.empty());
  CHECK_FALSE(s.trees.byId.count("t_00000000000000c1"));
  CHECK_EQ(s.trees.byId["t_p"].head, storedHead);
  CHECK(s.bus.subtreeBroadcasts.empty());
  CHECK_EQ(store.entered, 1);  // the create shared the failed save's answer: it sent the store nothing
}

TEST(create_subtree_that_loses_its_step_or_its_id_to_another_writer_answers_without_a_failure) {
  Setup s;
  AtTheDoor door;
  const UserId me = uid("me");
  seedParent(s, "t_p", me);
  const Subtree theirs{tid("t_0000000000000ee1"), tid("t_p"), OwningStep{tid("t_p"), nid("rig")}, 1, 0};
  s.trees.duringSubtreeCreate = [&s, &theirs] {
    s.trees.byId[theirs.id.str()] = StoredTree{};
    s.trees.subtrees[theirs.id.str()] = theirs;
    s.trees.duringSubtreeCreate = nullptr;
  };
  CHECK(s.registry.createSubtree(tid("t_p"), nid("rig"), me) == (SubtreeAnswer{SubtreeCreation{false, theirs, 0}}));

  s.trees.duringSubtreeCreate = [&s] {
    s.trees.byId["t_00000000000000c1"] = StoredTree{};
    s.trees.duringSubtreeCreate = nullptr;
  };
  CHECK(s.registry.createSubtree(tid("t_p"), nid("sail"), me, proposing("t_00000000000000c1")) ==
        (SubtreeAnswer{SubtreeCreation{true, Subtree{tid("t_d2"), tid("t_p"), OwningStep{tid("t_p"), nid("sail")}, 1, 0}, 1}}));
  CHECK(door.lines == (std::vector<std::string>{"roadmap.subtree.create roadmap internal unchanged",
                                                "roadmap.subtree.create roadmap internal ok"}));
  CHECK(door.failures->reports.empty());
}

// Each refusal writes nothing: no row, no seq, no event, and one line under its code.
static void checkRefusedWithNothingWritten(Setup& s, AtTheDoor& door, const TreeId& parent, const NodeId& step,
                                           const UserId& caller, SubtreeRefusal refusal) {
  const Seq head = s.trees.byId.count(parent.str()) ? s.trees.byId[parent.str()].head : 0;
  CHECK(s.registry.createSubtree(parent, step, caller, proposing("t_00000000000000c1")) == SubtreeAnswer{refusal});
  CHECK(std::none_of(s.trees.subtrees.begin(), s.trees.subtrees.end(),
                     [&parent](const auto& entry) { return entry.second.parent.tree == parent; }));
  CHECK_FALSE(s.trees.byId.count("t_00000000000000c1"));
  if (s.trees.byId.count(parent.str())) CHECK_EQ(s.trees.byId[parent.str()].head, head);
  CHECK(s.bus.subtreeBroadcasts.empty());
  CHECK(door.lines == (std::vector<std::string>{std::string("roadmap.subtree.create roadmap internal ") + codeOf(refusal)}));
  CHECK(door.failures->reports.empty());
}

TEST(create_subtree_under_a_deleted_step_is_refused_step_gone) {
  Setup s;
  AtTheDoor door;
  seedParent(s, "t_p", uid("me"));
  for (NodeStateEntry& node : s.trees.byId["t_p"].state.nodes)
    if (node.id == nid("rig")) node.deletedAt = Hlc{2, 0, "seed"};
  checkRefusedWithNothingWritten(s, door, tid("t_p"), nid("rig"), uid("me"), SubtreeRefusal::stepGone);
}

TEST(create_subtree_under_a_step_no_node_ever_held_is_refused_step_gone) {
  Setup s;
  AtTheDoor door;
  seedParent(s, "t_p", uid("me"));
  checkRefusedWithNothingWritten(s, door, tid("t_p"), nid("never"), uid("me"), SubtreeRefusal::stepGone);
}

TEST(create_subtree_in_a_deleted_tree_is_refused_no_such_tree) {
  Setup s;
  AtTheDoor door;
  seedParent(s, "t_p", uid("me"));
  s.trees.deletedIds.insert("t_p");
  checkRefusedWithNothingWritten(s, door, tid("t_p"), nid("rig"), uid("me"), SubtreeRefusal::noSuchTree);
}

TEST(create_subtree_in_a_tree_the_caller_reads_but_cannot_write_is_refused_not_writer) {
  Setup s;
  AtTheDoor door;
  seedParent(s, "t_p", uid("owner"));
  s.trees.byId["t_p"].visibility = Visibility::public_;
  checkRefusedWithNothingWritten(s, door, tid("t_p"), nid("rig"), uid("intruder"), SubtreeRefusal::notWriter);
}

TEST(create_subtree_in_an_absent_tree_or_a_private_one_of_someone_else_is_refused_no_such_tree) {
  Setup s;
  AtTheDoor door;
  checkRefusedWithNothingWritten(s, door, tid("t_ghost"), nid("rig"), uid("me"), SubtreeRefusal::noSuchTree);
  door.lines.clear();
  seedParent(s, "t_p", uid("owner"));
  checkRefusedWithNothingWritten(s, door, tid("t_p"), nid("rig"), uid("intruder"), SubtreeRefusal::noSuchTree);
}

TEST(create_subtree_that_would_sit_at_depth_nine_is_refused_and_one_at_depth_eight_is_created) {
  Setup s;
  AtTheDoor door;
  const UserId me = uid("me");
  seedParent(s, "t_root", me, {spec("x", NodeColor::sky)});
  seedParent(s, "t_p", me);
  s.trees.subtrees["t_p"] = Subtree{tid("t_p"), tid("t_root"), OwningStep{tid("t_root"), nid("x")}, kMaxTreeDepth, 0};
  checkRefusedWithNothingWritten(s, door, tid("t_p"), nid("rig"), me, SubtreeRefusal::depthLimit);
  s.trees.subtrees.clear();

  seedParent(s, "t_q", me);
  s.trees.subtrees["t_q"] = Subtree{tid("t_q"), tid("t_root"), OwningStep{tid("t_root"), nid("x")}, kMaxTreeDepth - 1, 0};
  const SubtreeAnswer answer = s.registry.createSubtree(tid("t_q"), nid("rig"), me);
  REQUIRE(std::holds_alternative<SubtreeCreation>(answer));
  CHECK(std::get<SubtreeCreation>(answer).subtree ==
        (Subtree{tid("t_d1"), tid("t_root"), OwningStep{tid("t_q"), nid("rig")}, kMaxTreeDepth, 0}));
}

TEST(create_subtree_under_a_step_whose_pointer_opens_a_standing_tree_of_the_owner_is_refused_step_opens_a_tree) {
  Setup s;
  AtTheDoor door;
  const UserId me = uid("me");
  seedParent(s, "t_p", me, {opening("rig", "t_other"), spec("sail", NodeColor::sky)});
  seed(s.trees, "t_other", me, 100, {});
  checkRefusedWithNothingWritten(s, door, tid("t_p"), nid("rig"), me, SubtreeRefusal::stepOpensATree);
}

// A pointer at a deleted tree, at someone else's, or at no tree at all leads nowhere, so the step may own a subtree.
TEST(create_subtree_under_a_step_whose_pointer_leads_nowhere_creates_it) {
  Setup s;
  const UserId me = uid("me");
  seedParent(s, "t_p", me, {opening("deleted", "t_gone"), opening("foreign", "t_eves"), opening("absent", "t_never")});
  seed(s.trees, "t_gone", me, 100, {});
  s.trees.deletedIds.insert("t_gone");
  seed(s.trees, "t_eves", uid("eve"), 100, {});

  for (const char* step : {"deleted", "foreign", "absent"}) {
    const SubtreeAnswer answer = s.registry.createSubtree(tid("t_p"), nid(step), me);
    REQUIRE(std::holds_alternative<SubtreeCreation>(answer));
    CHECK(std::get<SubtreeCreation>(answer).created);
  }
  CHECK_EQ(s.trees.subtrees.size(), 3u);
  CHECK_EQ(s.bus.subtreeBroadcasts.size(), 3u);
}

// Both run under the parent's strand, so one of two orders holds: the child is made and then its step deleted, which
// hides it, or the step is deleted and the create refused. Never a child made under a step already gone.
TEST(create_subtree_racing_the_deletion_of_its_step_lands_in_one_order_or_the_other) {
  for (int round = 0; round < 100; ++round) {
    Setup s;
    const UserId me = uid("me");
    seedParent(s, "t_p", me);
    std::promise<void> start;
    const std::shared_future<void> go = start.get_future().share();
    std::future<SubtreeAnswer> creating = std::async(std::launch::async, [&s, &me, go] {
      go.wait();
      return s.registry.createSubtree(tid("t_p"), nid("rig"), me, proposing("t_00000000000000c1"));
    });
    std::future<void> deleting = std::async(std::launch::async, [&s, &me, go] {
      go.wait();
      std::lock_guard<std::mutex> strand(s.rooms.strandFor(tid("t_p")));
      s.edits.deleteNodes(*s.rooms.open(tid("t_p")), tid("t_p"), {nid("rig")}, DanglingEdges::removed, me,
                          {tid("t_00000000000000c1")});
    });
    start.set_value();
    const SubtreeAnswer answer = creating.get();
    deleting.get();

    REQUIRE_EQ(s.bus.subgraphBroadcasts.size(), 1u);
    const Seq deletedAt = s.bus.subgraphBroadcasts[0].seq;
    if (answer == SubtreeAnswer{SubtreeRefusal::stepGone}) {
      CHECK_EQ(deletedAt, Seq{1});
      CHECK(s.trees.subtrees.empty());
      CHECK(s.bus.subtreeBroadcasts.empty());
      continue;
    }
    REQUIRE(std::holds_alternative<SubtreeCreation>(answer));
    CHECK_EQ(std::get<SubtreeCreation>(answer).parentSeq, Seq{1});
    CHECK_EQ(deletedAt, Seq{2});
    CHECK_EQ(s.trees.subtrees.size(), 1u);
    CHECK_EQ(s.bus.subtreeBroadcasts.size(), 1u);
  }
}

// The child and the parent's seq are stored together, and the event fails after: the line says `unannounced` and files
// one Issue, the seq stays taken, so the stream is consistent with the row, and a retry answers that child.
TEST(create_subtree_whose_event_fails_after_the_child_is_stored_is_unannounced_and_a_retry_answers_the_child) {
  Setup s;
  AtTheDoor door;
  const UserId me = uid("me");
  seedParent(s, "t_p", me);
  s.bus.subtreeBroadcastsFail = true;

  bool threw = false;
  try {
    s.registry.createSubtree(tid("t_p"), nid("rig"), me);
  } catch (const std::runtime_error&) {
    threw = true;
  }
  CHECK(threw);
  const Subtree child{tid("t_d1"), tid("t_p"), OwningStep{tid("t_p"), nid("rig")}, 1, 0};
  CHECK(s.trees.subtrees == (std::map<std::string, Subtree>{{"t_d1", child}}));
  CHECK_EQ(s.trees.byId["t_p"].head, Seq{1});
  CHECK_EQ(s.rooms.open(tid("t_p"))->head(), Seq{1});
  CHECK(door.lines == (std::vector<std::string>{"roadmap.subtree.create roadmap internal unannounced"}));
  CHECK(door.failures->reports ==
        (std::vector<std::string>{std::string("roadmap.subtree.create roadmap internal unannounced ") +
                                  typeid(std::runtime_error).name()}));

  s.bus.subtreeBroadcastsFail = false;
  CHECK(s.registry.createSubtree(tid("t_p"), nid("rig"), me) == (SubtreeAnswer{SubtreeCreation{false, child, 1}}));
  CHECK_EQ(s.trees.subtrees.size(), 1u);
  CHECK(s.bus.subtreeBroadcasts.empty());
}

TEST(create_subtree_whose_store_fails_leaves_no_row_no_seq_and_no_event) {
  Setup s;
  AtTheDoor door;
  const UserId me = uid("me");
  seedParent(s, "t_p", me);
  s.trees.duringSubtreeCreate = [] { throw std::runtime_error("connection reset mid-write"); };

  bool threw = false;
  try {
    s.registry.createSubtree(tid("t_p"), nid("rig"), me);
  } catch (const std::runtime_error&) {
    threw = true;
  }
  CHECK(threw);
  CHECK(s.trees.subtrees.empty());
  CHECK_EQ(s.trees.byId["t_p"].head, Seq{0});
  CHECK_EQ(s.rooms.open(tid("t_p"))->head(), Seq{0});
  CHECK(s.bus.subtreeBroadcasts.empty());
  CHECK(door.lines == (std::vector<std::string>{"roadmap.subtree.create roadmap internal failed"}));
  CHECK(door.failures->reports ==
        (std::vector<std::string>{std::string("roadmap.subtree.create roadmap internal failed ") +
                                  typeid(std::runtime_error).name()}));

  s.trees.duringSubtreeCreate = nullptr;
  const SubtreeAnswer retried = s.registry.createSubtree(tid("t_p"), nid("rig"), me);
  REQUIRE(std::holds_alternative<SubtreeCreation>(retried));
  CHECK(std::get<SubtreeCreation>(retried).created);
  CHECK_EQ(std::get<SubtreeCreation>(retried).parentSeq, Seq{1});
}

// A commit whose answer was lost stored the child and a head this room never took: the retry answers a seq at or past
// the child's, and the parent's next write takes the seq after it.
TEST(a_retry_after_a_lost_commit_answer_answers_a_seq_past_the_childs_and_the_next_write_takes_the_one_after) {
  Setup s;
  const UserId me = uid("me");
  seedParent(s, "t_p", me);
  s.rooms.open(tid("t_p"));
  const Subtree child{tid("t_00000000000000c1"), tid("t_p"), OwningStep{tid("t_p"), nid("rig")}, 1, 0};
  s.trees.byId[child.id.str()] = StoredTree{GraphState{}, bornLegend(), {}, 0, me, Visibility::private_};
  s.trees.subtrees[child.id.str()] = child;
  s.trees.byId["t_p"].head = 1;  // what the lost commit stored, the room still at 0

  CHECK(s.registry.createSubtree(tid("t_p"), nid("rig"), me, proposing("t_00000000000000c1")) ==
        (SubtreeAnswer{SubtreeCreation{false, child, 1}}));
  std::lock_guard<std::mutex> strand(s.rooms.strandFor(tid("t_p")));
  CHECK_EQ(s.rooms.open(tid("t_p"))->applyCommand(createNode("after"), 10, me), Seq{2});
}

// The legend is the client's to send, as create_tree's is: without one the child is born with the default legend, with
// one it is born with those kinds, kinds create_tree would refuse are refused in its words with nothing written, and a
// retry never rewrites the legend the child was born with.
TEST(create_subtree_is_born_with_the_kinds_it_is_sent_or_the_default_legend_and_a_retry_keeps_the_first) {
  Setup s;
  AtTheDoor door;
  const UserId me = uid("me");
  seedParent(s, "t_p", me);
  const std::vector<Kind> theirs{Kind{KindId{"drill"}, NodeColor::gold, "Drill", "Reps until it is reflex"},
                                 Kind{KindId{"read"}, NodeColor::sky, "Read", ""}};

  REQUIRE(std::holds_alternative<SubtreeCreation>(s.registry.createSubtree(tid("t_p"), nid("rig"), me)));
  CHECK(s.trees.byId["t_d1"].legend == bornLegend());
  REQUIRE(std::holds_alternative<SubtreeCreation>(
      s.registry.createSubtree(tid("t_p"), nid("sail"), me, {std::nullopt, theirs})));
  CHECK(s.trees.byId["t_d2"].legend == bornLegend(theirs));

  CHECK(s.registry.createSubtree(tid("t_p"), nid("sail"), me, {std::nullopt, std::vector<Kind>{theirs[0]}}) ==
        (SubtreeAnswer{SubtreeCreation{false, s.trees.subtrees.at("t_d2"), 2}}));
  CHECK(s.trees.byId["t_d2"].legend == bornLegend(theirs));

  const std::vector<std::pair<std::vector<Kind>, std::string>> refused{
      {{}, "kinds, when sent, names at least one kind — leave it out for the default legend"},
      {{Kind{KindId{"a"}, NodeColor::gold, "", ""}, Kind{KindId{"b"}, NodeColor::gold, "", ""}},
       "kinds[1].hue \"gold\" already belongs to kind \"a\" — a hue names one kind, so pick a free one"},
      {{Kind{KindId{""}, NodeColor::gold, "", ""}}, "argument \"kinds[0].id\" must be a non-empty string, got \"\""},
      {{Kind{KindId{"a"}, NodeColor::gold, std::string(30, 'x'), ""}},
       "kinds[0].label is 30 characters, 6 over the 24 cap"},
  };
  door.lines.clear();
  for (const auto& [kinds, sentence] : refused) {
    const SubtreeAnswer answer = s.registry.createSubtree(tid("t_p"), nid("rig"), me, {std::nullopt, kinds});
    REQUIRE(std::holds_alternative<Admission>(answer));
    CHECK_EQ(std::get<Admission>(answer).reason, sentence);
  }
  CHECK_EQ(s.trees.subtrees.size(), 2u);
  CHECK_EQ(s.bus.subtreeBroadcasts.size(), 2u);
  CHECK(door.lines == std::vector<std::string>(refused.size(), "roadmap.subtree.create roadmap internal kinds-refused"));
}

// A subtree is shared as its root is: a change aimed at it is refused, naming where it hangs and its root, and nothing
// is written.
TEST(set_visibility_of_a_subtree_is_refused_not_a_root_and_changes_nothing) {
  Setup s;
  const UserId me = uid("me");
  seedParent(s, "t_p", me);
  REQUIRE(std::holds_alternative<SubtreeCreation>(s.registry.createSubtree(tid("t_p"), nid("rig"), me)));

  CHECK(s.registry.setVisibility(tid("t_d1"), me, Visibility::public_) ==
        (VisibilityAnswer{NotARoot{OwningStep{tid("t_p"), nid("rig")}, tid("t_p")}}));
  CHECK(s.trees.byId["t_p"].visibility == Visibility::private_);
  CHECK(s.trees.byId["t_d1"].visibility == Visibility::private_);
  CHECK(s.rooms.accessOf(tid("t_d1"))->visibility == Visibility::private_);
  CHECK(s.registry.setVisibility(tid("t_d1"), uid("intruder"), Visibility::public_) ==
        VisibilityAnswer{TreeRegistry::VisibilityChange::notFound});
}

// A subtree is read by its root, live or closed: what the root's visibility admits, and nothing once the root is
// removed, whatever its own row holds.
TEST(a_subtree_admits_whom_its_root_admits_and_no_one_once_its_root_is_removed) {
  Setup s;
  const UserId me = uid("me");
  seedParent(s, "t_p", me);
  for (const char* step : {"rig", "sail"})
    REQUIRE(std::holds_alternative<SubtreeCreation>(s.registry.createSubtree(tid("t_p"), nid(step), me)));
  TreeRoom& live = *s.rooms.open(tid("t_d1"));
  const auto readable = [&s](const char* tree, const std::optional<UserId>& reader) {
    const std::optional<TreeAccess> access = s.rooms.accessOf(tid(tree));
    return access && canRead(reader, access->owner, access->visibility);
  };
  CHECK_FALSE(readable("t_d1", uid("stranger")));
  CHECK_FALSE(readable("t_d2", uid("stranger")));

  REQUIRE(s.registry.setVisibility(tid("t_p"), me, Visibility::unlisted) ==
          VisibilityAnswer{TreeRegistry::VisibilityChange::changed});
  CHECK(readable("t_d1", uid("stranger")));
  CHECK(readable("t_d2", uid("stranger")));
  CHECK(live.readableBy(uid("stranger")));
  CHECK(s.trees.byId["t_d2"].visibility == Visibility::private_);  // the column a subtree's access never reads

  REQUIRE(s.registry.setVisibility(tid("t_p"), me, Visibility::private_) ==
          VisibilityAnswer{TreeRegistry::VisibilityChange::changed});
  CHECK_FALSE(readable("t_d1", uid("stranger")));
  CHECK_FALSE(live.readableBy(uid("stranger")));
  CHECK(readable("t_d1", me));

  CHECK(s.registry.remove(tid("t_p"), me) == Removal{Cascade{}});
  CHECK_FALSE(readable("t_d1", me));
  CHECK_FALSE(readable("t_d2", me));
  CHECK_FALSE(live.readableBy(me));
  CHECK(s.registry.createSubtree(tid("t_d1"), nid("x"), me) == SubtreeAnswer{SubtreeRefusal::noSuchTree});
}

// A door's own observation names the door the line is written at.
TEST(create_subtree_writes_its_line_at_the_door_it_came_through) {
  Setup s;
  AtTheDoor door;
  seedParent(s, "t_p", uid("me"));
  WriteObservation route{"mcp.roadmap_create_subtree", "roadmap", "mcp"};
  WriteContext context{route};
  s.registry.createSubtree(tid("t_p"), nid("rig"), uid("me"));
  route.finish();
  CHECK(door.lines == (std::vector<std::string>{"roadmap.subtree.create roadmap mcp ok",
                                                "mcp.roadmap_create_subtree roadmap mcp ok"}));
}

static std::string labelIn(FakeTreeRepository& trees, const char* tree, const char* step) {
  for (const NodeStateEntry& node : trees.byId[tree].state.nodes)
    if (node.id == nid(step)) return node.label;
  return "";
}

// A subtree's title is its owning step's label: renaming it, through rename or describe, writes that label in the
// parent's room, on the parent's stream, as an ordinary label write of the step, and never the subtree's own title
// register; a guide sent beside it lands in the subtree's own room after it. A name the step already holds lands
// nothing, and a stranger, or a step gone from its parent, is refused with nothing written.
TEST(renaming_a_subtree_writes_its_owning_steps_label_in_the_parent_and_never_its_own_title) {
  Setup s;
  const UserId me = uid("me");
  seedParent(s, "t_p", me);
  s.trees.byId["t_p"].visibility = Visibility::unlisted;
  const TreeId child{"t_00000000000000c1"};
  REQUIRE(std::holds_alternative<SubtreeCreation>(
      s.registry.createSubtree(tid("t_p"), nid("rig"), me, proposing("t_00000000000000c1"))));

  CHECK(s.registry.rename(child, me, "  Rig the boat ") == TreeRegistry::Renaming::renamed);
  CHECK_EQ(labelIn(s.trees, "t_p", "rig"), std::string("Rig the boat"));
  CHECK_EQ(s.trees.byId[child.str()].title.value, std::string(""));
  REQUIRE_EQ(s.bus.subgraphBroadcasts.size(), 1u);
  CHECK_EQ(s.bus.subgraphBroadcasts[0].tree, std::string("t_p"));
  CHECK_EQ(s.bus.subgraphBroadcasts[0].seq, Seq{2});
  CHECK(s.rooms.open(tid("t_p"))->pendingOps().empty());  // persisted, and its op row landed with it

  using Answer = std::variant<TreeRegistry::Described, TreeRegistry::Renaming, Admission>;
  const Answer both = s.registry.describe(child, me, {std::string("Rig it"), std::string("Knots first.")});
  REQUIRE(std::holds_alternative<TreeRegistry::Described>(both));
  CHECK_EQ(std::get<TreeRegistry::Described>(both).seq, Seq{1});
  CHECK_FALSE(std::get<TreeRegistry::Described>(both).unchanged);
  CHECK_EQ(labelIn(s.trees, "t_p", "rig"), std::string("Rig it"));
  CHECK_EQ(s.trees.byId[child.str()].guide.value, std::string("Knots first."));
  CHECK_EQ(s.trees.byId[child.str()].title.value, std::string(""));

  const Answer again = s.registry.describe(child, me, {std::string("Rig it"), std::nullopt});
  REQUIRE(std::holds_alternative<TreeRegistry::Described>(again));
  CHECK_EQ(std::get<TreeRegistry::Described>(again).seq, Seq{1});
  CHECK(std::get<TreeRegistry::Described>(again).unchanged);
  CHECK_EQ(s.bus.subgraphBroadcasts.size(), 3u);

  CHECK(s.registry.rename(child, uid("stranger"), "Mine now") == TreeRegistry::Renaming::notYours);
  {
    std::unique_lock<std::mutex> strand(s.rooms.strandFor(tid("t_p")));
    s.rooms.open(tid("t_p"))->applyCommands({DeleteNode{nid("rig")}}, s.clock.nowMs(), me, {child});
    PendingSave saving = s.rooms.persist(tid("t_p"));
    strand.unlock();
    REQUIRE(saving.wait() == Saved::saved);
  }
  CHECK(s.registry.rename(child, me, "Rig again") == TreeRegistry::Renaming::notFound);
  CHECK_EQ(labelIn(s.trees, "t_p", "rig"), std::string("Rig it"));
}

// A create whose commit landed but whose answer was lost is retried, and the retry, finding the child, records it in
// the live parent room: from then on every projection the room makes reads the step as opening it, so its read carries
// the subtree and a hand mark on the step is refused, with no eviction and no seq taken.
TEST(a_retry_after_a_lost_commit_answer_records_the_subtree_in_the_live_parent_room) {
  Setup s;
  const UserId me = uid("me");
  seedParent(s, "t_p", me);
  const TreeId child{"t_00000000000000c1"};
  s.trees.duringSubtreeCreate = [&] {
    s.trees.duringSubtreeCreate = nullptr;
    REQUIRE(std::holds_alternative<Subtree>(
        s.trees.createSubtree(child, OwningStep{tid("t_p"), nid("rig")}, LegendState{}, 1)));
    throw std::runtime_error("connection lost after commit");
  };
  bool threw = false;
  try {
    s.registry.createSubtree(tid("t_p"), nid("rig"), me, proposing("t_00000000000000c1"));
  } catch (const std::runtime_error&) {
    threw = true;
  }
  REQUIRE(threw);

  const SubtreeAnswer retried = s.registry.createSubtree(tid("t_p"), nid("rig"), me, proposing("t_00000000000000c1"));
  REQUIRE(std::holds_alternative<SubtreeCreation>(retried));
  CHECK_FALSE(std::get<SubtreeCreation>(retried).created);
  std::map<NodeId, TreeId> pointers;
  {
    std::lock_guard<std::mutex> strand(s.rooms.strandFor(tid("t_p")));
    const TreeRoom* room = s.rooms.open(tid("t_p"));
    CHECK(room->subtrees() == (std::map<NodeId, TreeId>{{nid("rig"), child}}));
    CHECK_EQ(room->head(), Seq{1});
    pointers = room->pointersFor(me);
  }
  CHECK(pointers == (std::map<NodeId, TreeId>{{nid("rig"), child}}));
  const ProgressReceipt receipt = s.marks.mark(tid("t_p"), pointers, me,
                                               {ProgressWrite{nid("rig"), ProgressStatus::complete, {}, Hlc{50, 0, "r_a"}}},
                                               StampedBy::replica, 50);
  CHECK(receipt.outcomes.at(0).refused);
  CHECK(s.bus.subtreeBroadcasts.empty());
}

// A subtree's rename is a label write of its owning step in the parent, so a save of the parent that fails holds it
// there as any write of the parent's: the caller is told it is applied and held, the parent's room has the new label
// at once, and the subtree's name, read off the stored rows, stays the stored label until the registry's retry lands
// the save.
TEST(renaming_a_subtree_whose_parent_save_fails_is_held_in_the_parent_and_its_name_reads_the_store_until_it_lands) {
  Setup s;
  const UserId me = uid("me");
  seedParent(s, "t_p", me);
  const TreeId child{"t_00000000000000c1"};
  REQUIRE(std::holds_alternative<SubtreeCreation>(
      s.registry.createSubtree(tid("t_p"), nid("rig"), me, proposing("t_00000000000000c1"))));
  REQUIRE(s.registry.rename(child, me, "Rig the boat") == TreeRegistry::Renaming::renamed);

  s.trees.savesFail = true;
  CHECK(s.registry.rename(child, me, "Rig a dinghy") == TreeRegistry::Renaming::renamedUnsaved);
  using Answer = std::variant<TreeRegistry::Described, TreeRegistry::Renaming, Admission>;
  const Answer again = s.registry.describe(child, me, {std::string("Rig a dinghy"), std::nullopt});
  REQUIRE(std::holds_alternative<TreeRegistry::Described>(again));
  CHECK(std::get<TreeRegistry::Described>(again).unchanged);
  CHECK(std::get<TreeRegistry::Described>(again).saved == Saved::held);
  {
    std::lock_guard<std::mutex> strand(s.rooms.strandFor(tid("t_p")));
    CHECK(s.rooms.open(tid("t_p"))->labelOf(nid("rig")) == std::optional<std::string>("Rig a dinghy"));
  }
  CHECK_EQ(s.trees.placeOf(child)->title, std::string("Rig the boat"));
  CHECK_EQ(s.trees.byId[child.str()].title.value, std::string(""));

  s.trees.savesFail = false;
  REQUIRE_EQ(s.retries.set.size(), 1u);
  s.retries.set[0].run();
  CHECK_EQ(s.trees.placeOf(child)->title, std::string("Rig a dinghy"));
  CHECK(s.registry.rename(child, me, "Rig a skiff") == TreeRegistry::Renaming::renamed);
}

// A subtree goes and comes back with its owning step alone. Aimed at its id, a removal and a visibility change are
// refused `not-a-root` to its owner, naming where it hangs, and a create is refused as `notARoot`; while its branch is
// hidden every one of them, a rename too, answers as for an absent tree, at any depth. Reviving the step shows it again,
// and the root's removal takes every branch under it.
TEST(a_subtree_is_never_removed_shared_or_planted_by_its_own_id_and_a_hidden_one_answers_as_absent) {
  Setup s;
  const UserId me = uid("me");
  seedParent(s, "t_p", me);
  const TreeId child{"t_00000000000000c1"};
  const TreeId grandchild{"t_00000000000000c2"};
  REQUIRE(std::holds_alternative<SubtreeCreation>(s.registry.createSubtree(tid("t_p"), nid("rig"), me, proposing(child.str().c_str()))));
  {
    std::unique_lock<std::mutex> strand(s.rooms.strandFor(child));
    s.rooms.open(child)->applyCommand(CreateNode{nid("knot"), "Knot", "", NodeColor::sky}, s.clock.nowMs(), me);
    PendingSave saving = s.rooms.persist(child);
    strand.unlock();
    REQUIRE(saving.wait() == Saved::saved);
  }
  REQUIRE(std::holds_alternative<SubtreeCreation>(
      s.registry.createSubtree(child, nid("knot"), me, proposing(grandchild.str().c_str()))));

  const NotARoot hanging{OwningStep{tid("t_p"), nid("rig")}, tid("t_p")};
  using Shared = std::variant<TreeRegistry::VisibilityChange, NotARoot>;
  CHECK(s.registry.remove(child, me) == Removal{hanging});
  CHECK(s.registry.remove(grandchild, me) == (Removal{NotARoot{OwningStep{child, nid("knot")}, tid("t_p")}}));
  CHECK(s.registry.setVisibility(child, me, Visibility::public_) == Shared{hanging});
  CHECK(s.registry.create(me, child, treeData("Mine", {})) == TreeRegistry::Creation::notARoot);
  CHECK(s.registry.create(uid("eve"), child, treeData("Mine", {})) == TreeRegistry::Creation::taken);
  CHECK(s.registry.remove(child, uid("eve")) == Removal{TreeRegistry::RemovalRefusal::notFound});
  CHECK_FALSE(s.trees.deletedIds.count(child.str()));

  {
    std::lock_guard<std::mutex> strand(s.rooms.strandFor(tid("t_p")));
    REQUIRE(std::holds_alternative<DeletedNodes>(
        s.edits.deleteNodes(*s.rooms.open(tid("t_p")), tid("t_p"), {nid("rig")}, DanglingEdges::kept, me, {child})));
  }
  for (const TreeId& hidden : {child, grandchild}) {
    CHECK(s.registry.remove(hidden, me) == Removal{TreeRegistry::RemovalRefusal::notFound});
    CHECK(s.registry.setVisibility(hidden, me, Visibility::public_) == Shared{TreeRegistry::VisibilityChange::notFound});
    CHECK(s.registry.rename(hidden, me, "Renamed") == TreeRegistry::Renaming::notFound);
  }
  CHECK(s.registry.create(me, child, treeData("Mine", {})) == TreeRegistry::Creation::notARoot);

  {
    std::unique_lock<std::mutex> strand(s.rooms.strandFor(tid("t_p")));
    s.rooms.open(tid("t_p"))->applyCommand(CreateNode{nid("rig"), "Rig", "", NodeColor::sky}, s.clock.nowMs() + 1, me);
    PendingSave saving = s.rooms.persist(tid("t_p"));
    strand.unlock();
    REQUIRE(saving.wait() == Saved::saved);
  }
  CHECK(s.registry.remove(grandchild, me) == (Removal{NotARoot{OwningStep{child, nid("knot")}, tid("t_p")}}));

  CHECK(s.registry.remove(tid("t_p"), me) == Removal{Cascade{}});
  CHECK_FALSE(s.rooms.accessOf(child).has_value());
  CHECK_FALSE(s.rooms.accessOf(grandchild).has_value());
  CHECK_FALSE(s.trees.deletedIds.count(child.str()));  // nothing purges: the branch's rows stay as they were
}

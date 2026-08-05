#include "products/roadmap/application/TreeRegistry.h"

#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "products/roadmap/domain/Subgraph.h"
#include "test/platform/Fakes.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

#include <string>
#include <vector>

using namespace wm;
using namespace wm::fake;

// The registry with its collaborators: fake repos underneath, a real RoomRegistry so the
// rename tests exercise the live-room seam exactly as production does.
struct Setup {
  FakeTreeRepository trees;
  FakeProgressRepository progress;
  FakeTokens tokens;
  FakeOpLog ops;
  FakeBus bus;
  FakeClock clock;
  RoomRegistry rooms{trees, ops, bus};
  TreeRegistry registry{trees, progress, tokens, Hlc{1, 0, "genesis"}, rooms, clock};
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
  CHECK_FALSE(second == first);  // each plant mints a distinct id

  std::vector<TreeSummary> rows = s.registry.list(me);
  CHECK_EQ(rows.size(), 2u);
  bool found = false;
  for (const TreeSummary& row : rows) {
    if (row.id != first) continue;
    found = true;
    CHECK_EQ(row.title, std::string("Kitchen garden"));
    CHECK_EQ(row.stats.total, 0);  // an empty tree
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
  CHECK_EQ(rows.size(), 1u);
  CHECK_EQ(rows[0].id, id);
  CHECK_EQ(rows[0].title, std::string("Frontend"));
  CHECK_EQ(rows[0].stats.total, 2);  // the posted nodes are planted with the tree
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
  CHECK(stored.title == (Lww<std::string>{"Learn woodworking", Hlc{}}));  // the stampless create baseline
  CHECK_EQ(stored.head, static_cast<Seq>(0));
  CHECK(stored.state == GraphState{});  // a claim-create posts no nodes — the client's CRDT flush brings them

  // The genesis pin: the client seeds these same three kinds at '1:0:genesis' locally, and the
  // two legends must be byte-equal so the claim flush joins with zero duplication.
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

TEST(create_with_the_same_id_by_its_owner_resumes_without_touching_the_row) {
  Setup s;
  UserId me = uid("me");
  CHECK(s.registry.create(me, TreeId{"t_00c0ffee00c0ffee"}, treeData("Original title", {})) ==
        TreeRegistry::Creation::created);
  StoredTree before = s.trees.byId["t_00c0ffee00c0ffee"];

  TreeRegistry::Creation outcome =
      s.registry.create(me, TreeId{"t_00c0ffee00c0ffee"}, treeData("Different title", {}));

  CHECK(outcome == TreeRegistry::Creation::existedYours);
  CHECK(s.trees.byId["t_00c0ffee00c0ffee"] == before);  // title, owner, state, head — all untouched
}

TEST(create_with_an_id_that_is_not_yours_is_taken_and_leaves_the_row_alone) {
  Setup s;
  CHECK(s.registry.create(uid("owner"), TreeId{"t_00c0ffee00c0ffee"}, treeData("Theirs", {})) ==
        TreeRegistry::Creation::created);
  StoredTree before = s.trees.byId["t_00c0ffee00c0ffee"];

  CHECK(s.registry.create(uid("intruder"), TreeId{"t_00c0ffee00c0ffee"}, treeData("Mine now", {})) ==
        TreeRegistry::Creation::taken);
  CHECK(s.trees.byId["t_00c0ffee00c0ffee"] == before);

  // An unowned tree — the seeded demo, a legacy row; nothing mints one any more — is nobody's
  // to resume either. It stays ownerless: a create is not a way to claim what nobody owns.
  s.trees.byId["t_deadbeefdeadbeef"] = StoredTree{GraphState{}, LegendState{}, {"Unclaimed", {}}, 0, std::nullopt};
  CHECK(s.registry.create(uid("intruder"), TreeId{"t_deadbeefdeadbeef"}, treeData("Claim it", {})) ==
        TreeRegistry::Creation::taken);
  CHECK(s.trees.byId["t_deadbeefdeadbeef"].owner == std::nullopt);
}

TEST(create_with_a_soft_deleted_id_is_taken_even_for_its_old_owner) {
  Setup s;
  UserId me = uid("me");
  CHECK(s.registry.create(me, TreeId{"t_00c0ffee00c0ffee"}, treeData("Gone soon", {})) ==
        TreeRegistry::Creation::created);
  CHECK(s.registry.remove(TreeId{"t_00c0ffee00c0ffee"}, me) == TreeRegistry::Removal::deleted);

  // load can't see the deleted row, so the insert runs — the unique index refuses it, the
  // reload still sees nothing, and the claim reads taken (the client remaps its local id).
  CHECK(s.registry.create(me, TreeId{"t_00c0ffee00c0ffee"}, treeData("Again", {})) ==
        TreeRegistry::Creation::taken);
  CHECK_EQ(s.registry.list(me).size(), 0u);
}

TEST(list_orders_owned_trees_newest_first_and_excludes_other_owners) {
  Setup s;
  UserId me = uid("me");
  seed(s.trees, "old", me, 100, {spec("a", NodeColor::olive), spec("b", NodeColor::olive)});
  seed(s.trees, "fresh", me, 300, {spec("x", NodeColor::sky)});
  seed(s.trees, "notmine", uid("other"), 999, {spec("z", NodeColor::gold)});
  s.progress.setStatus(tid("old"), me, nid("a"), ProgressStatus::complete, at(150, "me"));

  std::vector<TreeSummary> rows = s.registry.list(me);

  CHECK_EQ(rows.size(), 2u);
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

TEST(remove_soft_deletes_an_owned_tree_and_it_leaves_the_list) {
  Setup s;
  UserId me = uid("me");
  seed(s.trees, "t", me, 100, {spec("a", NodeColor::sky)});

  CHECK_EQ(s.registry.list(me).size(), 1u);
  CHECK(s.registry.remove(tid("t"), me) == TreeRegistry::Removal::deleted);
  CHECK_EQ(s.registry.list(me).size(), 0u);
}

TEST(remove_refuses_a_non_owner_and_an_unknown_tree) {
  Setup s;
  seed(s.trees, "t", uid("owner"), 100, {spec("a", NodeColor::sky)});  // private by default

  // A stranger cannot read this tree, so the refusal must be the one an absent id gets: a
  // distinct "not yours" would confirm the id names a real private tree.
  CHECK(s.registry.remove(tid("t"), uid("intruder")) == TreeRegistry::Removal::notFound);
  CHECK(s.registry.remove(tid("ghost"), uid("owner")) == TreeRegistry::Removal::notFound);
  CHECK_EQ(s.registry.list(uid("owner")).size(), 1u);  // the refusal left it intact

  // A tree the stranger CAN read is a different matter — nothing is hidden, so it is told why.
  s.trees.byId["t"].visibility = Visibility::unlisted;
  CHECK(s.registry.remove(tid("t"), uid("intruder")) == TreeRegistry::Removal::notOwner);
  CHECK_EQ(s.registry.list(uid("owner")).size(), 1u);
}

TEST(rename_retitles_an_owned_tree_trimmed_and_the_list_shows_it) {
  Setup s;
  UserId me = uid("me");
  seed(s.trees, "t", me, 100, {spec("a", NodeColor::sky)});

  CHECK(s.registry.rename(tid("t"), me, "  Autumn plans  ") == TreeRegistry::Renaming::renamed);

  // A closed tree takes the column write, freshly stamped past the (unset) stored register.
  CHECK(s.trees.byId["t"].title == (Lww<std::string>{"Autumn plans", Hlc{1'700'000'000'000, 0, "srv"}}));
  std::vector<TreeSummary> rows = s.registry.list(me);
  CHECK_EQ(rows.size(), 1u);
  CHECK_EQ(rows[0].title, std::string("Autumn plans"));
  CHECK_EQ(s.bus.subgraphBroadcasts.size(), 0u);  // no room was live — nothing to broadcast
}

TEST(rename_refuses_a_non_owner_and_an_unknown_tree) {
  Setup s;
  seed(s.trees, "t", uid("owner"), 100, {spec("a", NodeColor::sky)});

  CHECK(s.registry.rename(tid("t"), uid("intruder"), "Mine now") == TreeRegistry::Renaming::notOwner);
  CHECK(s.registry.rename(tid("ghost"), uid("owner"), "Anything") == TreeRegistry::Renaming::notFound);
  CHECK_EQ(s.trees.byId["t"].title.value, std::string("t"));  // the refusals left the name alone
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
  CHECK(room.title() == renamed);             // the live room followed, stamped by its clock
  CHECK(s.trees.byId["t"].title == renamed);  // persisted through the room's save, stamp included
  CHECK_EQ(s.bus.subgraphBroadcasts.size(), 1u);
  const FakeBus::SubgraphBroadcast& broadcast = s.bus.subgraphBroadcasts[0];
  CHECK_EQ(broadcast.tree, std::string("t"));
  CHECK_EQ(broadcast.seq, room.head());  // a title frame takes a seq like any joined frame
  CHECK(broadcast.subgraph.title.has_value());
  CHECK(*broadcast.subgraph.title == renamed);
  CHECK(broadcast.subgraph.graph.nodes.empty());  // a title-only frame carries no graph
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
  CHECK(room.title() == (Lww<std::string>{"Client name", Hlc{2000, 0, "r_a"}}));  // the earlier stamp lost
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
  CHECK(s.trees.byId["t"].title == renamed);  // the stamp rode the flush, not just the value

  TreeRoom& reloaded = *s.rooms.open(tid("t"));
  CHECK(reloaded.title() == renamed);  // the register is seeded from the persisted stamp

  Subgraph stale;  // the F2 replay: an older-stamped rename arriving only after the restart
  stale.treeId = tid("t");
  stale.frameId = "f-stale";
  stale.actor = "r_b";
  stale.title = Lww<std::string>{"Older name", Hlc{1'699'999'999'000, 0, "r_b"}};
  reloaded.joinSubgraph(stale, me);
  CHECK(reloaded.title() == renamed);  // LWW held across the restart — not arrival order
  s.rooms.persist(tid("t"));
  CHECK(s.trees.byId["t"].title == renamed);

  // And the reloaded clock stands on the persisted stamp: with wall time frozen at the same
  // millisecond, a fresh rename still mints strictly past the old register (counter bumps).
  CHECK(s.registry.rename(tid("t"), me, "Renamed again") == TreeRegistry::Renaming::renamed);
  CHECK(reloaded.title() == (Lww<std::string>{"Renamed again", Hlc{1'700'000'000'000, 1, "srv"}}));
  CHECK(s.trees.byId["t"].title == (Lww<std::string>{"Renamed again", Hlc{1'700'000'000'000, 1, "srv"}}));
}

TEST(set_visibility_reshares_an_owned_tree_and_the_column_reflects_it) {
  Setup s;
  UserId me = uid("me");
  seed(s.trees, "t", me, 100, {spec("a", NodeColor::sky)});
  CHECK(s.trees.byId["t"].visibility == Visibility::private_);  // born private

  CHECK(s.registry.setVisibility(tid("t"), me, Visibility::unlisted) ==
        TreeRegistry::VisibilityChange::changed);
  CHECK(s.trees.byId["t"].visibility == Visibility::unlisted);

  CHECK(s.registry.setVisibility(tid("t"), me, Visibility::private_) ==
        TreeRegistry::VisibilityChange::changed);
  CHECK(s.trees.byId["t"].visibility == Visibility::private_);  // and back again
}

TEST(set_visibility_refuses_a_non_owner_and_an_unknown_tree) {
  Setup s;
  seed(s.trees, "t", uid("owner"), 100, {spec("a", NodeColor::sky)});

  CHECK(s.registry.setVisibility(tid("t"), uid("intruder"), Visibility::public_) ==
        TreeRegistry::VisibilityChange::notOwner);
  CHECK(s.registry.setVisibility(tid("ghost"), uid("owner"), Visibility::public_) ==
        TreeRegistry::VisibilityChange::notFound);
  CHECK(s.trees.byId["t"].visibility == Visibility::private_);  // the refusals left it alone
}

TEST(set_visibility_flips_a_live_rooms_cache_at_once) {
  Setup s;
  UserId me = uid("me");
  seed(s.trees, "t", me, 100, {spec("a", NodeColor::sky)});
  TreeRoom& room = *s.rooms.open(tid("t"));
  CHECK(room.visibility() == Visibility::private_);

  CHECK(s.registry.setVisibility(tid("t"), me, Visibility::unlisted) ==
        TreeRegistry::VisibilityChange::changed);
  CHECK(room.visibility() == Visibility::unlisted);          // the just-shared live room stops 404-ing at once
  CHECK(s.trees.byId["t"].visibility == Visibility::unlisted);  // and it is durable
}

TEST(a_stale_rooms_save_cannot_revert_a_newer_persisted_rename) {
  Setup s;
  UserId me = uid("me");
  seed(s.trees, "t", me, 100, {spec("a", NodeColor::sky)});
  s.rooms.open(tid("t"));
  CHECK(s.registry.rename(tid("t"), me, "First name") == TreeRegistry::Renaming::renamed);

  // A second process renames behind this room's back: the stored register is now newer than
  // the room's cache. The F1 guard — in production the SQL conditional on the trees row in
  // PgTreeRepository, mirrored by the fake — must let the flush land everything but the title.
  const Lww<std::string> newer{"Newer name", Hlc{1'700'000'060'000, 0, "srv"}};
  s.trees.byId["t"].title = newer;

  s.rooms.persist(tid("t"));  // the stale cache flushes its title alongside its slice

  CHECK(s.trees.byId["t"].title == newer);                 // the newer rename survived
  CHECK_EQ(s.trees.byId["t"].head, static_cast<Seq>(1));   // the rest of the save still landed
}

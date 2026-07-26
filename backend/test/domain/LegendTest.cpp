#include "products/roadmap/domain/Legend.h"
#include "test/testing.h"

using namespace wm;

static KindId kid(const char* s) { return KindId{std::string(s)}; }
static Hlc at(std::uint64_t ms, const char* actor = "a") { return Hlc{ms, 0, actor}; }

TEST(seeded_defaults_are_three_kinds_in_order) {
  Legend legend = Legend::seededDefaults(at(1));
  std::vector<Kind> kinds = legend.kinds();
  CHECK_EQ(kinds.size(), 3u);
  CHECK_EQ(kinds[0].id, kid("build"));
  CHECK_EQ(kinds[0].hue, NodeColor::terracotta);
  CHECK_EQ(kinds[0].label, std::string("Build"));
  CHECK_EQ(kinds[0].description, std::string("Things you make"));
  CHECK_EQ(kinds[1].id, kid("learn"));
  CHECK_EQ(kinds[1].hue, NodeColor::olive);
  CHECK_EQ(kinds[2].id, kid("milestone"));
  CHECK_EQ(kinds[2].hue, NodeColor::gold);
}

TEST(add_kind_appends_at_end_and_owns_its_hue) {
  Legend legend = Legend::seededDefaults(at(1));
  legend.addKind(kid("infra"), NodeColor::sky, at(2));
  CHECK_EQ(legend.size(), 4u);
  CHECK_EQ(legend.orderedIds()[3], kid("infra"));
  CHECK_EQ(legend.ownerOf(NodeColor::sky).value(), kid("infra"));
  CHECK_EQ(legend.hueOf(kid("infra")).value(), NodeColor::sky);
}

TEST(remove_kind_makes_it_absent) {
  Legend legend = Legend::seededDefaults(at(1));
  legend.removeKind(kid("learn"), at(2));
  CHECK_FALSE(legend.has(kid("learn")));
  CHECK_FALSE(legend.hueOf(kid("learn")).has_value());
  CHECK_FALSE(legend.ownerOf(NodeColor::olive).has_value());
  CHECK_EQ(legend.size(), 2u);
}

TEST(fields_are_last_writer_wins) {
  Legend legend = Legend::seededDefaults(at(1));
  legend.setLabel(kid("build"), "Make", at(5));
  legend.setLabel(kid("build"), "stale", at(3));   // lower HLC loses
  legend.setDescription(kid("build"), "Stuff you ship", at(5));
  legend.setHue(kid("build"), NodeColor::brick, at(5));
  auto view = legend.view(kid("build"));
  CHECK_EQ(view->label, std::string("Make"));
  CHECK_EQ(view->description, std::string("Stuff you ship"));
  CHECK_EQ(view->hue, NodeColor::brick);
}

TEST(reorder_sets_new_order) {
  Legend legend = Legend::seededDefaults(at(1));
  legend.reorder({kid("milestone"), kid("build"), kid("learn")}, at(2));
  CHECK_EQ(legend.orderedIds()[0], kid("milestone"));
  CHECK_EQ(legend.orderedIds()[1], kid("build"));
  CHECK_EQ(legend.orderedIds()[2], kid("learn"));
}

TEST(construct_from_view_preserves_given_order) {
  Legend legend({{kid("c"), NodeColor::sky, "C", ""},
                 {kid("a"), NodeColor::gold, "A", ""},
                 {kid("b"), NodeColor::plum, "B", ""}},
                at(1));
  CHECK_EQ(legend.orderedIds()[0], kid("c"));
  CHECK_EQ(legend.orderedIds()[1], kid("a"));
  CHECK_EQ(legend.orderedIds()[2], kid("b"));
}

TEST(export_import_round_trips_kinds_order_and_tombstones) {
  Legend legend = Legend::seededDefaults(at(1));
  legend.addKind(kid("infra"), NodeColor::sky, at(2));
  legend.reorder({kid("infra"), kid("build"), kid("learn"), kid("milestone")}, at(3));
  legend.removeKind(kid("milestone"), at(4));  // a tombstone must survive the round-trip

  Legend reloaded(legend.exportState());
  CHECK_EQ(reloaded.size(), 3u);
  CHECK_FALSE(reloaded.has(kid("milestone")));
  CHECK_EQ(reloaded.orderedIds()[0], kid("infra"));
  CHECK_EQ(reloaded.view(kid("build"))->label, std::string("Build"));

  // The tombstone is preserved: a stale re-add (lower HLC than the remove) stays cancelled.
  reloaded.addKind(kid("milestone"), NodeColor::gold, at(2));
  CHECK_FALSE(reloaded.has(kid("milestone")));
}

TEST(empty_legend_reports_empty) {
  Legend legend;
  CHECK(legend.empty());
  CHECK_EQ(legend.size(), 0u);
  CHECK_EQ(legend.kinds().size(), 0u);
}

TEST(join_folds_a_partial_legend_and_is_commutative) {
  Legend seeded = Legend::seededDefaults(at(1));

  Legend renamed(seeded.exportState());
  renamed.setLabel(kid("build"), "Make", at(9));

  Legend added(seeded.exportState());
  added.addKind(kid("infra"), NodeColor::sky, at(5));

  Legend renamedFirst(seeded.exportState());
  renamedFirst.join(renamed.exportState());
  renamedFirst.join(added.exportState());

  Legend addedFirst(seeded.exportState());
  addedFirst.join(added.exportState());
  addedFirst.join(renamed.exportState());

  CHECK(renamedFirst.exportState() == addedFirst.exportState());
  CHECK_EQ(renamedFirst.view(kid("build"))->label, std::string("Make"));
  CHECK(renamedFirst.has(kid("infra")));
}

TEST(join_keeps_more_a_concurrent_edit_survives_a_delete_and_a_re_add_resurrects_it) {
  Legend seeded = Legend::seededDefaults(at(1));

  Legend remover(seeded.exportState());
  remover.removeKind(kid("learn"), at(5, "a"));       // one replica removes the kind

  Legend editor(seeded.exportState());
  editor.setLabel(kid("learn"), "Study", at(5, "b")); // another, concurrently, relabels it

  Legend converged(seeded.exportState());
  converged.join(remover.exportState());
  converged.join(editor.exportState());
  CHECK_FALSE(converged.has(kid("learn")));           // the delete stands (a field edit is not a re-add)

  converged.addKind(kid("learn"), NodeColor::olive, at(6, "a"));  // a strictly-later re-add wins
  CHECK(converged.has(kid("learn")));
  CHECK_EQ(converged.view(kid("learn"))->label, std::string("Study"));  // the latent edit resurrects with it
}

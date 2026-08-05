#include "products/roadmap/domain/Gallery.h"
#include "test/testing.h"

#include <string>

using namespace wm;

static NodeSpec step(const char* id, NodeColor color = NodeColor::sky) {
  NodeSpec node;
  node.id = NodeId{std::string(id)};
  node.label = id;
  node.color = color;
  return node;
}

static WallCandidate candidate(const char* id, const char* title, int steps, int forks,
                               std::uint64_t updatedAt) {
  WallCandidate listed;
  listed.data.id = TreeId{std::string(id)};
  listed.data.title = title;
  for (int i = 0; i < steps; ++i) listed.data.nodes.push_back(step((std::string("n") + std::to_string(i)).c_str()));
  listed.forks = forks;
  listed.updatedAt = updatedAt;
  return listed;
}

static const Viewer ANONYMOUS{};

TEST(wall_ranks_by_forks_then_freshness_then_id) {
  std::vector<WallCandidate> candidates{
      candidate("t_a", "A", 5, 1, 900),
      candidate("t_b", "B", 5, 7, 100),
      candidate("t_c", "C", 5, 1, 900),  // ties t_a on both forks and freshness
      candidate("t_d", "D", 5, 3, 100),
  };

  std::vector<GalleryEntry> wall = publicWall(candidates, ANONYMOUS);

  CHECK_EQ(wall.size(), std::size_t{4});
  CHECK_EQ(wall[0].id, TreeId{"t_b"});  // 7 forks
  CHECK_EQ(wall[1].id, TreeId{"t_d"});  // 3 forks
  CHECK_EQ(wall[2].id, TreeId{"t_a"});  // 1 fork, tie broken by id
  CHECK_EQ(wall[3].id, TreeId{"t_c"});
}

TEST(a_tended_tree_outranks_a_structurally_newer_one_nobody_has_opened) {
  // The whole of the wall's answer to abandonment. A progress mark writes only the owner's
  // overlay and never moves the tree's own stamp, so a tiebreak reading that stamp alone would
  // put a tree nobody has touched above one its owner ticks a step on every day.
  WallCandidate tended = candidate("t_tended", "Tended", 5, 1, 100);
  tended.lastMarkedAt = 900;
  WallCandidate abandoned = candidate("t_abandoned", "Abandoned", 5, 1, 500);

  std::vector<GalleryEntry> wall = publicWall({abandoned, tended}, ANONYMOUS);

  CHECK_EQ(wall.size(), std::size_t{2});
  CHECK_EQ(wall[0].id, TreeId{"t_tended"});
  CHECK_EQ(wall[0].updatedAt, std::uint64_t{900});  // the row wears last-active, not the stamp
  CHECK_EQ(wall[1].id, TreeId{"t_abandoned"});
  CHECK_EQ(wall[1].updatedAt, std::uint64_t{500});
}

TEST(last_active_is_the_freshest_of_the_two_stamps_in_either_direction) {
  // The fold is a max, not a preference: a stale mark never drags down a tree edited since.
  WallCandidate edited = candidate("t_edited", "Edited", 5, 1, 900);
  edited.lastMarkedAt = 100;
  WallCandidate marked = candidate("t_marked", "Marked", 5, 1, 100);
  marked.lastMarkedAt = 500;

  std::vector<GalleryEntry> wall = publicWall({marked, edited}, ANONYMOUS);

  CHECK_EQ(wall.size(), std::size_t{2});
  CHECK_EQ(wall[0].id, TreeId{"t_edited"});
  CHECK_EQ(wall[0].updatedAt, std::uint64_t{900});
  CHECK_EQ(wall[1].id, TreeId{"t_marked"});
  CHECK_EQ(wall[1].updatedAt, std::uint64_t{500});
}

TEST(forks_still_outrank_freshness) {
  // Last-active only ever breaks a tie: the wall is fork-ranked first, so a much-forked plan
  // never falls behind a busy one.
  WallCandidate popular = candidate("t_popular", "Popular", 5, 7, 100);
  WallCandidate busy = candidate("t_busy", "Busy", 5, 1, 100);
  busy.lastMarkedAt = 9000;

  std::vector<GalleryEntry> wall = publicWall({busy, popular}, ANONYMOUS);

  CHECK_EQ(wall.size(), std::size_t{2});
  CHECK_EQ(wall[0].id, TreeId{"t_popular"});
  CHECK_EQ(wall[1].id, TreeId{"t_busy"});
}

TEST(wall_drops_a_tree_too_small_to_read_as_a_plan) {
  std::vector<WallCandidate> candidates{
      candidate("t_stub", "Stub", kWallMinimumSteps - 1, 99, 100),
      candidate("t_plan", "Plan", kWallMinimumSteps, 0, 100),
  };

  std::vector<GalleryEntry> wall = publicWall(candidates, ANONYMOUS);

  CHECK_EQ(wall.size(), std::size_t{1});
  CHECK_EQ(wall[0].id, TreeId{"t_plan"});  // the stub's 99 forks don't buy it a place
}

TEST(wall_drops_an_unnamed_tree) {
  std::vector<WallCandidate> candidates{
      candidate("t_blank", "", 5, 0, 100),
      candidate("t_space", "   \t ", 5, 0, 100),
      candidate("t_named", "Named", 5, 0, 100),
  };

  std::vector<GalleryEntry> wall = publicWall(candidates, ANONYMOUS);

  CHECK_EQ(wall.size(), std::size_t{1});
  CHECK_EQ(wall[0].id, TreeId{"t_named"});
}

TEST(wall_keeps_an_unstarted_plan) {
  // No progress floor: an unstarted plan is still a plan, and an abandoned one loses on ranking
  // rather than being gated off the wall.
  std::vector<GalleryEntry> wall = publicWall({candidate("t_new", "Untouched", 5, 0, 100)}, ANONYMOUS);

  CHECK_EQ(wall.size(), std::size_t{1});
  CHECK_EQ(wall[0].stats.done, 0);
}

TEST(an_entry_carries_the_owners_progress_and_dominant_kind) {
  WallCandidate listed;
  listed.data.id = TreeId{"t_x"};
  listed.data.title = "Learn Rust";
  listed.data.nodes = {step("a", NodeColor::olive), step("b", NodeColor::olive), step("c", NodeColor::olive),
                       step("d", NodeColor::gold)};
  listed.ownerProgress.completed = {NodeId{"a"}, NodeId{"b"}, NodeId{"c"}};
  listed.forks = 2;
  listed.updatedAt = 4242;

  std::vector<GalleryEntry> wall = publicWall({listed}, ANONYMOUS);

  CHECK_EQ(wall.size(), std::size_t{1});
  CHECK_EQ(wall[0].id, TreeId{"t_x"});
  CHECK_EQ(wall[0].title, std::string("Learn Rust"));
  CHECK_EQ(wall[0].stats.total, 4);
  CHECK_EQ(wall[0].stats.done, 3);
  CHECK_EQ(wall[0].stats.dominantKind, NodeColor::olive);
  CHECK_EQ(wall[0].forks, 2);
  CHECK_EQ(wall[0].updatedAt, std::uint64_t{4242});
  CHECK_EQ(wall[0].sourceTitle, std::string(""));
  CHECK_FALSE(wall[0].mine);
  CHECK_FALSE(wall[0].forked);
}

TEST(an_entry_names_the_tree_it_was_forked_from) {
  WallCandidate listed = candidate("t_fork", "My Rust", 5, 0, 100);
  listed.sourceTitle = "Learn Rust";

  std::vector<GalleryEntry> wall = publicWall({listed}, ANONYMOUS);

  CHECK_EQ(wall.size(), std::size_t{1});
  CHECK_EQ(wall[0].sourceTitle, std::string("Learn Rust"));
}

TEST(an_empty_candidate_set_is_an_empty_wall) {
  CHECK_EQ(publicWall({}, ANONYMOUS).size(), std::size_t{0});
}

TEST(the_anonymous_reader_owns_nothing_and_has_forked_nothing) {
  WallCandidate mine = candidate("t_mine", "Mine", 5, 1, 100);
  mine.owner = UserId{"u_sam"};
  WallCandidate taken = candidate("t_taken", "Taken", 5, 2, 100);
  taken.owner = UserId{"u_other"};

  std::vector<GalleryEntry> wall = publicWall({mine, taken}, ANONYMOUS);

  CHECK_EQ(wall.size(), std::size_t{2});
  CHECK_FALSE(wall[0].mine);
  CHECK_FALSE(wall[0].forked);
  CHECK_FALSE(wall[1].mine);
  CHECK_FALSE(wall[1].forked);
}

TEST(a_signed_in_reader_sees_which_rows_are_theirs_and_which_they_took) {
  WallCandidate mine = candidate("t_mine", "Mine", 5, 3, 100);
  mine.owner = UserId{"u_sam"};
  WallCandidate taken = candidate("t_taken", "Taken", 5, 2, 100);
  taken.owner = UserId{"u_other"};
  WallCandidate stranger = candidate("t_new", "Stranger's", 5, 1, 100);
  stranger.owner = UserId{"u_other"};

  const Viewer sam{UserId{"u_sam"}, {TreeId{"t_taken"}}};
  std::vector<GalleryEntry> wall = publicWall({mine, taken, stranger}, sam);

  CHECK_EQ(wall.size(), std::size_t{3});
  CHECK_EQ(wall[0].id, TreeId{"t_mine"});
  CHECK(wall[0].mine);
  CHECK_FALSE(wall[0].forked);
  CHECK_EQ(wall[1].id, TreeId{"t_taken"});
  CHECK_FALSE(wall[1].mine);
  CHECK(wall[1].forked);
  CHECK_EQ(wall[2].id, TreeId{"t_new"});
  CHECK_FALSE(wall[2].mine);
  CHECK_FALSE(wall[2].forked);
}

TEST(who_is_reading_never_changes_the_ranking) {
  std::vector<WallCandidate> candidates{
      candidate("t_a", "A", 5, 1, 900),
      candidate("t_b", "B", 5, 7, 100),
      candidate("t_c", "C", 5, 3, 100),
  };
  candidates[0].owner = UserId{"u_sam"};  // the reader's own tree earns no lift

  const Viewer sam{UserId{"u_sam"}, {TreeId{"t_b"}}};
  std::vector<GalleryEntry> anonymousWall = publicWall(candidates, Viewer{});
  std::vector<GalleryEntry> samsWall = publicWall(candidates, sam);

  CHECK_EQ(anonymousWall.size(), samsWall.size());
  for (std::size_t i = 0; i < samsWall.size(); ++i) CHECK_EQ(anonymousWall[i].id, samsWall[i].id);
}

TEST(a_page_is_the_first_limit_entries_and_the_token_that_resumes_it) {
  std::vector<GalleryEntry> wall = publicWall(
      {candidate("t_a", "A", 5, 3, 100), candidate("t_b", "B", 5, 2, 100), candidate("t_c", "C", 5, 1, 100)},
      ANONYMOUS);

  std::optional<WallPage> first = wallPage(wall, "", 2);

  CHECK(first.has_value());
  CHECK_EQ(first->entries.size(), std::size_t{2});
  CHECK_EQ(first->entries[0].id, TreeId{"t_a"});
  CHECK_EQ(first->entries[1].id, TreeId{"t_b"});
  CHECK_EQ(first->nextCursor, std::string("t_b"));

  std::optional<WallPage> second = wallPage(wall, first->nextCursor, 2);

  CHECK(second.has_value());
  CHECK_EQ(second->entries.size(), std::size_t{1});
  CHECK_EQ(second->entries[0].id, TreeId{"t_c"});
  CHECK_EQ(second->nextCursor, std::string(""));  // the last page never invites another
}

TEST(a_page_that_holds_the_whole_index_carries_no_cursor) {
  std::vector<GalleryEntry> wall =
      publicWall({candidate("t_a", "A", 5, 3, 100), candidate("t_b", "B", 5, 2, 100)}, ANONYMOUS);

  std::optional<WallPage> page = wallPage(wall, "", 60);

  CHECK(page.has_value());
  CHECK_EQ(page->entries.size(), std::size_t{2});
  CHECK_EQ(page->nextCursor, std::string(""));
}

TEST(a_cursor_naming_no_entry_is_refused_rather_than_restarted) {
  std::vector<GalleryEntry> wall = publicWall({candidate("t_a", "A", 5, 3, 100)}, ANONYMOUS);

  CHECK_FALSE(wallPage(wall, "t_gone", 10).has_value());
}

TEST(a_cursor_on_the_last_entry_walks_off_the_end_cleanly) {
  std::vector<GalleryEntry> wall =
      publicWall({candidate("t_a", "A", 5, 3, 100), candidate("t_b", "B", 5, 2, 100)}, ANONYMOUS);

  std::optional<WallPage> page = wallPage(wall, "t_b", 10);

  CHECK(page.has_value());
  CHECK_EQ(page->entries.size(), std::size_t{0});
  CHECK_EQ(page->nextCursor, std::string(""));
}

TEST(an_empty_wall_pages_to_nothing) {
  std::optional<WallPage> page = wallPage({}, "", 10);

  CHECK(page.has_value());
  CHECK_EQ(page->entries.size(), std::size_t{0});
  CHECK_EQ(page->nextCursor, std::string(""));
}

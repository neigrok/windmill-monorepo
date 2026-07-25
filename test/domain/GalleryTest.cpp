#include "domain/Gallery.h"
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

TEST(wall_ranks_by_forks_then_freshness_then_id) {
  std::vector<WallCandidate> candidates{
      candidate("t_a", "A", 5, 1, 900),
      candidate("t_b", "B", 5, 7, 100),
      candidate("t_c", "C", 5, 1, 900),  // ties t_a on both forks and freshness
      candidate("t_d", "D", 5, 3, 100),
  };

  std::vector<GalleryEntry> wall = publicWall(candidates, 10);

  CHECK_EQ(wall.size(), std::size_t{4});
  CHECK_EQ(wall[0].id, TreeId{"t_b"});  // 7 forks
  CHECK_EQ(wall[1].id, TreeId{"t_d"});  // 3 forks
  CHECK_EQ(wall[2].id, TreeId{"t_a"});  // 1 fork, tie broken by id
  CHECK_EQ(wall[3].id, TreeId{"t_c"});
}

TEST(wall_drops_a_tree_too_small_to_read_as_a_plan) {
  std::vector<WallCandidate> candidates{
      candidate("t_stub", "Stub", kWallMinimumSteps - 1, 99, 100),
      candidate("t_plan", "Plan", kWallMinimumSteps, 0, 100),
  };

  std::vector<GalleryEntry> wall = publicWall(candidates, 10);

  CHECK_EQ(wall.size(), std::size_t{1});
  CHECK_EQ(wall[0].id, TreeId{"t_plan"});  // the stub's 99 forks don't buy it a place
}

TEST(wall_drops_an_unnamed_tree) {
  std::vector<WallCandidate> candidates{
      candidate("t_blank", "", 5, 0, 100),
      candidate("t_space", "   \t ", 5, 0, 100),
      candidate("t_named", "Named", 5, 0, 100),
  };

  std::vector<GalleryEntry> wall = publicWall(candidates, 10);

  CHECK_EQ(wall.size(), std::size_t{1});
  CHECK_EQ(wall[0].id, TreeId{"t_named"});
}

TEST(wall_keeps_the_first_page_and_drops_the_rest) {
  std::vector<WallCandidate> candidates{
      candidate("t_a", "A", 5, 3, 100),
      candidate("t_b", "B", 5, 2, 100),
      candidate("t_c", "C", 5, 1, 100),
  };

  std::vector<GalleryEntry> wall = publicWall(candidates, 2);

  CHECK_EQ(wall.size(), std::size_t{2});
  CHECK_EQ(wall[0].id, TreeId{"t_a"});
  CHECK_EQ(wall[1].id, TreeId{"t_b"});
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

  std::vector<GalleryEntry> wall = publicWall({listed}, 10);

  CHECK_EQ(wall.size(), std::size_t{1});
  CHECK_EQ(wall[0].id, TreeId{"t_x"});
  CHECK_EQ(wall[0].title, std::string("Learn Rust"));
  CHECK_EQ(wall[0].stats.total, 4);
  CHECK_EQ(wall[0].stats.done, 3);
  CHECK_EQ(wall[0].stats.dominantKind, NodeColor::olive);
  CHECK_EQ(wall[0].forks, 2);
  CHECK_EQ(wall[0].updatedAt, std::uint64_t{4242});
}

TEST(an_empty_candidate_set_is_an_empty_wall) {
  CHECK_EQ(publicWall({}, 10).size(), std::size_t{0});
}

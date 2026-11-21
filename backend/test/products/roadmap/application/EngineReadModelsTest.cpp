#include "products/roadmap/application/EngineReadModels.h"

#include "test/platform/Fakes.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

#include <chrono>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

// The gallery on the engine's records keeps the bounds the rooms' gallery keeps (OwnerFollows): a public root is listed
// read alone, and its owner's other roadmaps, which its steps open, are followed within the request's cap, with the
// owner cooled off after a follow that ran past its budget.

using namespace wm;
using namespace wm::fake;

namespace {

namespace read = wm::roadmap::read;

// Ann's public root "My year": Sail owns the subtree Rigging, whose one step she completed, and Coast follows Sail.
struct Records final : RoadmapRecords {
  const UserId ann{"00000000-0000-4000-8000-0000000000a1"};
  bool slow = false;
  int wholeReads = 0;

  std::vector<read::TreeRecords> roadmaps() const {
    read::TreeRecords root;
    root.id = "t_a";
    root.meta = read::Meta{.title = "My year", .visibility = "public", .reach = "public"};
    root.nodes = {read::Step{.id = "sail", .label = "Learn to sail", .ord = "a0", .branch = "t_s"},
                  read::Step{.id = "coast", .label = "Sail the coast", .ord = "a1"},
                  read::Step{.id = "knot", .label = "Tie a knot", .ord = "a2"}};
    root.edges = {read::Edge{"sail", "coast"}};
    read::TreeRecords subtree;
    subtree.id = "t_s";
    subtree.parent = read::Parent{"t_a", "sail"};
    subtree.meta = read::Meta{.title = "", .root = "t_a", .depth = 1, .reach = "public"};
    subtree.nodes = {read::Step{.id = "rig", .label = "Rig the boat", .ord = "a0"}};
    subtree.marks = {read::Mark{.node = "rig", .status = "complete", .recordedAt = 5'000, .stamp = Hlc{5'000, 0, "r_a"}}};
    return {root, subtree};
  }

  std::optional<UserId> ownerOf(const TreeId&) override { return ann; }
  AccountRoadmaps roadmapsOf(const UserId&, const std::optional<std::set<TreeId>>& only,
                             std::optional<std::chrono::milliseconds> budget) override {
    if (!only) {
      ++wholeReads;
      if (slow && budget) throw FollowTimedOut{};
    }
    AccountRoadmaps held;
    for (read::TreeRecords& tree : roadmaps())
      if (!only || only->contains(TreeId{tree.id})) {
        held.editedAt[tree.id] = 4'000;
        held.trees.push_back(std::move(tree));
      }
    return held;
  }
  std::vector<ListedRoot> publicRoots() override { return {ListedRoot{TreeId{"t_a"}, ann, ForkLineage{}}}; }
  ForkLineage lineageOf(const TreeId&) override { return {}; }
  std::set<TreeId> forkedSources(const UserId&) override { return {}; }
};

// The wall's one card: its completed steps, and what the follows came to.
std::string told(const EngineWall& wall) {
  std::string line;
  for (const WallCandidate& candidate : wall.candidates)
    for (const NodeId& step : candidate.ownerProgress.completed) line += step.str() + " ";
  return line + "followed=" + std::to_string(wall.tally.followed) + " timed_out=" + std::to_string(wall.tally.timedOut) +
         " cooling_off=" + std::to_string(wall.tally.coolingOff) + " past_cap=" + std::to_string(wall.tally.pastCap);
}

}

TEST(engine_wall_follows_an_owner_whose_root_opens_a_roadmap_and_shows_the_step_complete_when_that_roadmap_is) {
  Records records;
  FakeOpLog activity;
  FakeClock clock;
  EngineReadModels reads(records, activity, clock);

  CHECK_EQ(told(reads.wall(std::chrono::milliseconds{1500})), std::string("sail followed=1 timed_out=0 cooling_off=0 past_cap=0"));
  CHECK_EQ(records.wholeReads, 1);
}

TEST(engine_wall_shows_an_owner_whose_follow_runs_past_its_budget_unread_and_cools_them_off) {
  Records records;
  records.slow = true;
  FakeOpLog activity;
  FakeClock clock;
  EngineReadModels reads(records, activity, clock);

  CHECK_EQ(told(reads.wall(std::chrono::milliseconds{1500})), std::string("followed=0 timed_out=1 cooling_off=0 past_cap=0"));
  CHECK_EQ(told(reads.wall(std::chrono::milliseconds{1500})), std::string("followed=0 timed_out=0 cooling_off=1 past_cap=0"));
  CHECK_EQ(records.wholeReads, 1);

  records.slow = false;
  clock.now += std::chrono::milliseconds{kFollowCoolOff}.count();
  CHECK_EQ(told(reads.wall(std::chrono::milliseconds{1500})), std::string("sail followed=1 timed_out=0 cooling_off=0 past_cap=0"));
}

TEST(engine_wall_with_no_time_left_for_follows_reads_no_owners_other_roadmaps) {
  Records records;
  FakeOpLog activity;
  FakeClock clock;
  EngineReadModels reads(records, activity, clock);

  CHECK_EQ(told(reads.wall(std::chrono::milliseconds{0})), std::string("followed=0 timed_out=0 cooling_off=0 past_cap=1"));
  CHECK_EQ(records.wholeReads, 0);
}

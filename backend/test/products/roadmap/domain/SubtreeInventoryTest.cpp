#include "products/roadmap/domain/SubtreeInventory.h"
#include "test/testing.h"

#include <algorithm>
#include <map>
#include <random>
#include <set>
#include <string>
#include <vector>

using namespace wm;

namespace {

TreeId tid(const std::string& id) { return TreeId{id}; }

// An account whose standing trees each name the trees their steps open, one entry per step.
AccountTrees account(const std::map<std::string, std::vector<std::string>>& standing,
                     const std::set<std::string>& deleted = {}, const std::set<std::string>& foreign = {}) {
  AccountTrees trees;
  for (const auto& [tree, opens] : standing) {
    std::map<TreeId, int>& pointers = trees.standing[tid(tree)];
    for (const std::string& opened : opens) ++pointers[tid(opened)];
  }
  for (const std::string& tree : deleted) trees.deleted.insert(tid(tree));
  for (const std::string& tree : foreign) trees.foreign.insert(tid(tree));
  return trees;
}

}

TEST(two_trees_no_pointer_opens_are_two_roots_and_their_account_holds_no_pointer) {
  SubtreeInventory expected;
  expected.trees = 2;
  expected.roots = 2;
  CHECK(inventory(account({{"a", {}}, {"b", {}}})) == expected);
}

TEST(a_clean_chain_three_deep_is_owned_down_from_its_root_one_tree_at_each_depth) {
  SubtreeInventory expected;
  expected.trees = 4;
  expected.roots = 1;
  expected.owned = 3;
  expected.depth = {.deepest = 3, .one = 1, .two = 1, .three = 1};
  expected.accounts = {.withPointers = 1};
  CHECK(inventory(account({{"root", {"a"}}, {"a", {"b"}}, {"b", {"c"}}, {"c", {}}})) == expected);
}

TEST(a_chain_past_three_counts_its_deeper_trees_together_and_its_deepest_exactly) {
  SubtreeInventory expected;
  expected.trees = 6;
  expected.roots = 1;
  expected.owned = 5;
  expected.depth = {.deepest = 5, .one = 1, .two = 1, .three = 1, .moreThanThree = 2};
  expected.accounts = {.withPointers = 1};
  CHECK(inventory(account({{"root", {"a"}}, {"a", {"b"}}, {"b", {"c"}}, {"c", {"d"}}, {"d", {"e"}}, {"e", {}}})) ==
        expected);
}

TEST(a_tree_two_steps_of_one_tree_open_is_opened_twice_and_needs_a_choice) {
  SubtreeInventory expected;
  expected.trees = 2;
  expected.roots = 1;
  expected.multiOpened = {.trees = 1, .sameTree = 1, .acrossTrees = 0, .maxOpeners = 2};
  expected.accounts = {.withPointers = 1, .needingChoice = 1};
  CHECK(inventory(account({{"root", {"x", "x"}}, {"x", {}}})) == expected);
}

TEST(a_tree_steps_of_two_trees_open_is_opened_twice_and_needs_a_choice) {
  SubtreeInventory expected;
  expected.trees = 3;
  expected.roots = 2;
  expected.multiOpened = {.trees = 1, .sameTree = 0, .acrossTrees = 1, .maxOpeners = 2};
  expected.accounts = {.withPointers = 1, .needingChoice = 1};
  CHECK(inventory(account({{"one", {"x"}}, {"two", {"x"}}, {"x", {}}})) == expected);
}

TEST(the_most_openers_of_one_tree_is_counted_up_to_its_bound) {
  AccountTrees flooded = account({{"root", {"y", "y", "y"}}, {"x", {}}, {"y", {}}});
  flooded.standing.at(tid("root"))[tid("x")] = 150;
  SubtreeInventory expected;
  expected.trees = 3;
  expected.roots = 1;
  expected.multiOpened = {.trees = 2, .sameTree = 2, .acrossTrees = 0, .maxOpeners = kMaxOpenersCounted};
  expected.accounts = {.withPointers = 1, .needingChoice = 1};
  CHECK(inventory(flooded) == expected);
}

TEST(a_step_opening_its_own_tree_puts_it_on_a_loop_of_one) {
  SubtreeInventory expected;
  expected.trees = 1;
  expected.cycles = {.trees = 1, .selfPointers = 1, .loops = {.one = 1}};
  expected.accounts = {.withPointers = 1, .needingChoice = 1};
  CHECK(inventory(account({{"a", {"a"}}})) == expected);
}

TEST(a_two_tree_loop_and_a_four_tree_loop_are_two_loops_counted_by_how_many_trees_each_holds) {
  SubtreeInventory expected;
  expected.trees = 6;
  expected.cycles = {.trees = 6, .selfPointers = 0, .loops = {.two = 1, .threeToEight = 1}};
  expected.accounts = {.withPointers = 1, .needingChoice = 1};
  CHECK(inventory(account({{"a", {"b"}}, {"b", {"a"}}, {"c", {"d"}}, {"d", {"e"}}, {"e", {"f"}}, {"f", {"c"}}})) ==
        expected);
}

TEST(a_loop_of_nine_trees_is_one_loop_past_eight) {
  std::map<std::string, std::vector<std::string>> ring;
  for (int at = 0; at < 9; ++at) ring["r" + std::to_string(at)] = {"r" + std::to_string((at + 1) % 9)};
  SubtreeInventory expected;
  expected.trees = 9;
  expected.cycles = {.trees = 9, .selfPointers = 0, .loops = {.moreThanEight = 1}};
  expected.accounts = {.withPointers = 1, .needingChoice = 1};
  CHECK(inventory(account(ring)) == expected);
}

TEST(steps_whose_pointer_is_not_valid_dangle_by_what_they_name_and_a_named_deleted_tree_is_counted_once) {
  const std::string missing = "t_00000000000000ee";
  const std::string deleted = "t_00000000000000d0";
  const std::string unnamed = "t_00000000000000d1";
  const std::string theirs = "t_00000000000000f0";
  const AccountTrees home =
      account({{"home", {missing, deleted, deleted, theirs, "learn the piano"}}}, {deleted, unnamed}, {theirs});
  SubtreeInventory expected;
  expected.trees = 2;
  expected.roots = 1;
  expected.dangling = {.missing = 1, .deleted = 2, .foreign = 1, .notATreeId = 1};
  expected.accounts = {.withPointers = 1, .needingChoice = 1};
  CHECK(inventory(home) == expected);
}

TEST(two_accounts_are_counted_apart_and_a_pointer_at_the_others_tree_opens_nothing_there) {
  const AccountTrees mine = account({{"a", {"b"}}, {"b", {}}});
  const AccountTrees theirs = account({{"c", {"a"}}}, {}, {"a"});
  SubtreeInventory first;
  first.trees = 2;
  first.roots = 1;
  first.owned = 1;
  first.depth = {.deepest = 1, .one = 1};
  first.accounts = {.withPointers = 1};
  SubtreeInventory second;
  second.trees = 1;
  second.roots = 1;
  second.dangling = {.foreign = 1};
  second.accounts = {.withPointers = 1, .needingChoice = 1};
  CHECK(inventory(mine) == first);
  CHECK(inventory(theirs) == second);

  SubtreeInventory both = inventory(mine);
  both += inventory(theirs);
  SubtreeInventory expected;
  expected.trees = 3;
  expected.roots = 2;
  expected.owned = 1;
  expected.depth = {.deepest = 1, .one = 1};
  expected.dangling = {.foreign = 1};
  expected.accounts = {.withPointers = 2, .needingChoice = 1};
  CHECK(both == expected);
}

TEST(two_accounts_fold_their_greatest_counts_as_the_greater_and_add_the_rest) {
  SubtreeInventory both = inventory(account({{"root", {"x", "x", "x"}}, {"x", {"y"}}, {"y", {"z"}}, {"z", {}}}));
  both += inventory(account({{"root", {"x", "x"}}, {"x", {"y"}}, {"y", {"z"}}, {"z", {"w"}}, {"w", {}}}));
  SubtreeInventory expected;
  expected.trees = 9;
  expected.roots = 2;
  expected.owned = 5;
  expected.multiOpened = {.trees = 2, .sameTree = 2, .acrossTrees = 0, .maxOpeners = 3};
  expected.accounts = {.withPointers = 2, .needingChoice = 2};
  CHECK(both == expected);
}

// The precedence: a tree on a loop is counted under cycles, however many steps open it and wherever they stand.
TEST(a_tree_on_a_loop_is_counted_under_cycles_however_often_it_is_opened) {
  SubtreeInventory expected;
  expected.trees = 4;
  expected.roots = 1;
  expected.cycles = {.trees = 3, .selfPointers = 1, .loops = {.one = 1, .two = 1}};
  expected.accounts = {.withPointers = 1, .needingChoice = 1};
  CHECK(inventory(account({{"root", {"x", "z"}}, {"x", {"y"}}, {"y", {"x"}}, {"z", {"z"}}})) == expected);
}

TEST(a_tree_one_step_opens_under_a_tree_that_needs_a_choice_is_owned_and_no_root_reaches_it) {
  SubtreeInventory expected;
  expected.trees = 7;
  expected.roots = 2;
  expected.owned = 2;
  expected.multiOpened = {.trees = 1, .sameTree = 0, .acrossTrees = 1, .maxOpeners = 2};
  expected.cycles = {.trees = 2, .selfPointers = 0, .loops = {.two = 1}};
  expected.accounts = {.withPointers = 1, .needingChoice = 1};
  CHECK(inventory(account({{"one", {"shared"}},
                           {"two", {"shared"}},
                           {"shared", {"under shared"}},
                           {"under shared", {}},
                           {"a", {"b"}},
                           {"b", {"a", "under loop"}},
                           {"under loop", {}}})) == expected);
}

// The rule enumerated: each tree's class from every way its trees lead to one another, against the inventory, which
// must also count each standing tree in exactly one class.
TEST(random_accounts_partition_their_standing_trees_as_an_enumeration_of_every_way_between_them_does) {
  std::mt19937 random(20261113);
  const auto below = [&](unsigned bound) { return static_cast<unsigned>(random() % bound); };
  const std::string deleted = "t_00000000000000d0";
  const std::string unnamedDeleted = "t_00000000000000d1";
  const std::string theirs = "t_00000000000000f0";
  const std::string missing = "t_00000000000000ee";
  const std::string freeText = "free text";
  const std::vector<std::string> invalid{deleted, theirs, missing, freeText};
  int disagreements = 0;
  int partitionsBroken = 0;
  for (int round = 0; round < 1500; ++round) {
    const unsigned count = 1 + below(9);
    const unsigned pointerPercent = std::vector<unsigned>{25, 50, 80}[below(3)];
    std::vector<std::vector<int>> steps(count, std::vector<int>(count, 0));
    std::map<std::string, std::vector<std::string>> standing;
    std::map<std::string, std::size_t> invalidSteps;
    for (unsigned from = 0; from < count; ++from) {
      std::vector<std::string>& opens = standing["s" + std::to_string(from)];
      for (unsigned step = below(5); step > 0; --step) {
        if (below(100) >= pointerPercent) continue;
        if (below(100) < 80) {
          const unsigned to = below(count);
          ++steps[from][to];
          opens.push_back("s" + std::to_string(to));
          continue;
        }
        opens.push_back(invalid[below(invalid.size())]);
        ++invalidSteps[opens.back()];
      }
    }

    // leads[a][b]: a reaches b along one pointer or more.
    std::vector<std::vector<bool>> leads(count, std::vector<bool>(count, false));
    for (unsigned a = 0; a < count; ++a)
      for (unsigned b = 0; b < count; ++b) leads[a][b] = steps[a][b] > 0;
    for (unsigned via = 0; via < count; ++via)
      for (unsigned a = 0; a < count; ++a)
        for (unsigned b = 0; b < count; ++b) leads[a][b] = leads[a][b] || (leads[a][via] && leads[via][b]);

    SubtreeInventory expected;
    enum class Class { root, owned, multiOpened, cycle };
    std::vector<Class> classOf(count);
    for (unsigned tree = 0; tree < count; ++tree) {
      expected.cycles.selfPointers += steps[tree][tree];
      int openingSteps = 0;
      int openers = 0;
      bool twiceFromOne = false;
      for (unsigned from = 0; from < count; ++from) {
        openingSteps += steps[from][tree];
        if (steps[from][tree] > 0) ++openers;
        if (steps[from][tree] > 1) twiceFromOne = true;
      }
      if (leads[tree][tree]) {
        classOf[tree] = Class::cycle;
        ++expected.cycles.trees;
      } else if (openingSteps == 0) {
        classOf[tree] = Class::root;
        ++expected.roots;
      } else if (openingSteps == 1) {
        classOf[tree] = Class::owned;
        ++expected.owned;
      } else {
        classOf[tree] = Class::multiOpened;
        ++expected.multiOpened.trees;
        if (twiceFromOne) ++expected.multiOpened.sameTree;
        if (openers > 1) ++expected.multiOpened.acrossTrees;
        expected.multiOpened.maxOpeners = std::max(
            expected.multiOpened.maxOpeners, std::min(static_cast<std::size_t>(openingSteps), kMaxOpenersCounted));
      }
    }
    std::set<unsigned> grouped;
    for (unsigned tree = 0; tree < count; ++tree) {
      if (classOf[tree] != Class::cycle || grouped.count(tree)) continue;
      std::size_t members = 0;
      for (unsigned other = 0; other < count; ++other)
        if (leads[tree][other] && leads[other][tree] && grouped.insert(other).second) ++members;
      std::size_t& ofItsLength = members == 1   ? expected.cycles.loops.one
                                 : members == 2 ? expected.cycles.loops.two
                                 : members <= 8 ? expected.cycles.loops.threeToEight
                                                : expected.cycles.loops.moreThanEight;
      ++ofItsLength;
    }
    // An owned tree's one opener, followed up while it is owned: a root at the top puts the tree that many down.
    const auto openerOf = [&](unsigned tree) {
      for (unsigned from = 0; from < count; ++from)
        if (steps[from][tree] > 0) return from;
      return count;
    };
    for (unsigned tree = 0; tree < count; ++tree) {
      std::size_t depth = 0;
      unsigned top = tree;
      for (; classOf[top] == Class::owned && depth <= count; ++depth) top = openerOf(top);
      if (depth == 0 || classOf[top] != Class::root) continue;
      expected.depth.deepest = std::max(expected.depth.deepest, depth);
      std::size_t& atThisDepth = depth == 1   ? expected.depth.one
                                 : depth == 2 ? expected.depth.two
                                 : depth == 3 ? expected.depth.three
                                              : expected.depth.moreThanThree;
      ++atThisDepth;
    }
    expected.dangling = {.missing = invalidSteps[missing],
                         .deleted = invalidSteps[deleted],
                         .foreign = invalidSteps[theirs],
                         .notATreeId = invalidSteps[freeText]};
    expected.trees = count + (invalidSteps[deleted] > 0 ? 1 : 0);
    const bool validPointer = std::any_of(steps.begin(), steps.end(), [](const std::vector<int>& from) {
      return std::any_of(from.begin(), from.end(), [](int opened) { return opened > 0; });
    });
    const std::size_t danglingSteps = invalidSteps[missing] + invalidSteps[deleted] + invalidSteps[theirs] +
                                      invalidSteps[freeText];
    expected.accounts.withPointers = validPointer || danglingSteps > 0 ? 1 : 0;
    expected.accounts.needingChoice = expected.multiOpened.trees + expected.cycles.trees + danglingSteps > 0 ? 1 : 0;

    const SubtreeInventory counted = inventory(account(standing, {deleted, unnamedDeleted}, {theirs}));
    if (counted.roots + counted.owned + counted.multiOpened.trees + counted.cycles.trees != count) ++partitionsBroken;
    if (!(counted == expected)) ++disagreements;
  }
  CHECK_EQ(partitionsBroken, 0);
  CHECK_EQ(disagreements, 0);
}

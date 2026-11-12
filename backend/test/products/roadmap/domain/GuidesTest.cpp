#include "products/roadmap/domain/Guides.h"
#include "test/testing.h"

#include <map>
#include <string>
#include <vector>

using namespace wm;

TEST(a_chain_of_trees_answers_the_root_then_the_middle_then_the_trees_own_guide) {
  const std::map<TreeId, TreeAbove> above{{TreeId{"middle"}, {1, "Middle", "Ship weekly."}},
                                          {TreeId{"root"}, {2, "Root", "Write the outcome first."}}};

  const std::vector<Guide> guides = guidesFor(above, Guide{TreeId{"leaf"}, "Leaf", "Tests before code.", true});

  CHECK(guides == (std::vector<Guide>{{TreeId{"root"}, "Root", "Write the outcome first.", true},
                                      {TreeId{"middle"}, "Middle", "Ship weekly.", true},
                                      {TreeId{"leaf"}, "Leaf", "Tests before code.", true}}));
}

TEST(trees_at_one_distance_answer_in_id_order_after_every_farther_tree) {
  const std::map<TreeId, TreeAbove> above{{TreeId{"b"}, {1, "B", "b"}},
                                          {TreeId{"a"}, {1, "A", "a"}},
                                          {TreeId{"z"}, {2, "Z", "z"}},
                                          {TreeId{"c"}, {3, "C", "c"}},
                                          {TreeId{"y"}, {2, "Y", "y"}}};

  const std::vector<Guide> guides = guidesFor(above, Guide{TreeId{"leaf"}, "Leaf", "leaf", true});

  CHECK(guides == (std::vector<Guide>{{TreeId{"c"}, "C", "c", true},
                                      {TreeId{"y"}, "Y", "y", true},
                                      {TreeId{"z"}, "Z", "z", true},
                                      {TreeId{"a"}, "A", "a", true},
                                      {TreeId{"b"}, "B", "b", true},
                                      {TreeId{"leaf"}, "Leaf", "leaf", true}}));
}

TEST(a_tree_without_a_guide_is_left_out_and_does_not_use_up_the_cap) {
  std::map<TreeId, TreeAbove> above;
  for (int k = 0; k < 20; ++k) above.emplace(TreeId{"silent" + std::to_string(k)}, TreeAbove{1, "Silent", ""});
  above.emplace(TreeId{"far"}, TreeAbove{8, "Far", "The method."});

  const std::vector<Guide> guides = guidesFor(above, Guide{TreeId{"leaf"}, "Leaf", "leaf", true});

  CHECK(guides == (std::vector<Guide>{{TreeId{"far"}, "Far", "The method.", true}, {TreeId{"leaf"}, "Leaf", "leaf", true}}));
}

TEST(more_than_seven_guided_trees_above_keeps_the_nearest_seven_and_the_trees_own_guide) {
  std::map<TreeId, TreeAbove> above;
  for (int k = 1; k <= 8; ++k) above.emplace(TreeId{"up" + std::to_string(k)}, TreeAbove{k, "Up", "guide"});
  above.emplace(TreeId{"beside1"}, TreeAbove{1, "Beside", "guide"});
  above.emplace(TreeId{"beside7"}, TreeAbove{7, "Beside", "guide"});

  const std::vector<Guide> guides = guidesFor(above, Guide{TreeId{"leaf"}, "Leaf", "leaf", true});

  CHECK(guides == (std::vector<Guide>{{TreeId{"up6"}, "Up", "guide", true},
                                      {TreeId{"up5"}, "Up", "guide", true},
                                      {TreeId{"up4"}, "Up", "guide", true},
                                      {TreeId{"up3"}, "Up", "guide", true},
                                      {TreeId{"up2"}, "Up", "guide", true},
                                      {TreeId{"beside1"}, "Beside", "guide", true},
                                      {TreeId{"up1"}, "Up", "guide", true},
                                      {TreeId{"leaf"}, "Leaf", "leaf", true}}));
}

TEST(among_trees_at_the_distance_the_cap_cuts_the_later_ids_are_kept) {
  std::map<TreeId, TreeAbove> above;
  for (int k = 0; k < 9; ++k) above.emplace(TreeId{"up" + std::to_string(k)}, TreeAbove{2, "Up", "guide"});

  const std::vector<Guide> guides = guidesFor(above, Guide{TreeId{"leaf"}, "Leaf", "leaf", true});

  std::vector<Guide> expected;
  for (int k = 2; k < 9; ++k) expected.push_back(Guide{TreeId{"up" + std::to_string(k)}, "Up", "guide", true});
  expected.push_back(Guide{TreeId{"leaf"}, "Leaf", "leaf", true});
  CHECK(guides == expected);
}

TEST(an_empty_own_guide_leaves_the_guides_above_and_the_cap_then_keeps_eight_of_them) {
  const std::map<TreeId, TreeAbove> two{{TreeId{"middle"}, {1, "Middle", "Ship weekly."}},
                                        {TreeId{"root"}, {2, "Root", "Write the outcome first."}}};
  CHECK(guidesFor(two, Guide{TreeId{"leaf"}, "Leaf", "", true}) ==
        (std::vector<Guide>{{TreeId{"root"}, "Root", "Write the outcome first.", true},
                            {TreeId{"middle"}, "Middle", "Ship weekly.", true}}));

  std::map<TreeId, TreeAbove> nine;
  for (int k = 1; k <= 9; ++k) nine.emplace(TreeId{"up" + std::to_string(k)}, TreeAbove{k, "Up", "guide"});
  std::vector<Guide> nearestEight;
  for (int k = 8; k >= 1; --k) nearestEight.push_back(Guide{TreeId{"up" + std::to_string(k)}, "Up", "guide", true});
  CHECK(guidesFor(nine, Guide{TreeId{"leaf"}, "Leaf", "", true}) == nearestEight);
}

TEST(a_tree_with_nothing_above_answers_its_own_guide_alone_and_nothing_when_it_has_none) {
  CHECK(guidesFor({}, Guide{TreeId{"leaf"}, "Leaf", "Tests before code.", false}) ==
        (std::vector<Guide>{{TreeId{"leaf"}, "Leaf", "Tests before code.", false}}));
  CHECK(guidesFor({}, Guide{TreeId{"leaf"}, "Leaf", "", true}) == std::vector<Guide>{});
}

TEST(a_guide_a_fork_copied_into_a_tree_above_is_not_the_readers_and_one_they_wrote_is) {
  const std::map<TreeId, TreeAbove> above{{TreeId{"forked"}, {1, "Forked", "Its author's method.", true}},
                                          {TreeId{"written"}, {1, "Written", "My method.", false}}};

  const std::vector<Guide> guides = guidesFor(above, Guide{TreeId{"leaf"}, "Leaf", "Inherited too.", false});

  CHECK(guides == (std::vector<Guide>{{TreeId{"forked"}, "Forked", "Its author's method.", false},
                                      {TreeId{"written"}, "Written", "My method.", true},
                                      {TreeId{"leaf"}, "Leaf", "Inherited too.", false}}));
}

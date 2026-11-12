#pragma once

#include "products/roadmap/domain/Ids.h"

#include <cstddef>
#include <map>
#include <string>
#include <vector>

namespace wm {

// A tree is above another when pointers lead from it down to that tree within this many of them.
constexpr int kMaxLevelsAbove = 8;
// The most guides one reading of a tree answers.
constexpr std::size_t kMaxGuides = 8;

// One of the reader's own standing trees above the tree being read; `distance` is the fewest pointers down to it.
struct TreeAbove {
  int distance = 0;
  std::string title;
  std::string guide;
  bool guideInherited = false;
  bool operator==(const TreeAbove&) const = default;
};

// One tree's guide as a reader is answered it; `yours` says the reader owns the tree and wrote the guide it holds.
struct Guide {
  TreeId tree;
  std::string title;
  std::string text;
  bool yours = false;
  bool operator==(const Guide&) const = default;
};

// The guides a reading of `own`'s tree answers, by the rule in SPEC.md (Model, `guides`): they add, farthest first.
std::vector<Guide> guidesFor(const std::map<TreeId, TreeAbove>& above, const Guide& own);

}

#pragma once

#include "platform/ports/Clock.h"
#include "products/roadmap/application/OwnerFollows.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/OpenedTrees.h"
#include "products/roadmap/domain/Tree.h"
#include "products/roadmap/ports/ProgressRepository.h"
#include "products/roadmap/ports/TreeRepository.h"

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace wm {

// One owner whose trees a reader is shown, each tree with the pointers its steps hold.
struct OwnersTrees {
  UserId owner;
  std::map<TreeId, std::map<NodeId, StampedPointer>> trees;
};

// Each tree's marks as a reader is shown them, and what the follows came to.
struct ShownToReaders {
  std::map<TreeId, Progress> progress;
  FollowTally tally;
};

// An owner's marks on their trees as each caller is shown them: the stored marks to a caller who can write the tree,
// and to everyone else readerView of them (domain/OpenedTrees.h), off follows of the trees the owner's steps open.
// Shared by every request of the process, which is what holds the cool-off.
class OwnerProgress {
public:
  OwnerProgress(ProgressRepository& marks, TreeRepository& trees, Clock& clock);

  // The owner's marks on `tree` as stored: what a caller who can write it reads.
  Progress stored(const TreeId& tree, const UserId& owner);

  // `owners` in the order their follows are tried. An owner whose trees hold a pointer is followed in one read within
  // kReaderFollowBudget (followed), and the follows of the request take `cap` in all: an owner the cap leaves unreached
  // is shown unread for this request alone.
  ShownToReaders shownToReaders(const std::vector<OwnersTrees>& owners, std::chrono::milliseconds cap,
                                const std::string& door);

  // `owner`'s standing trees that `opened` lead to, under their marks, as a caller who cannot write them is shown them:
  // one read (TreeRepository::openedFrom) under the bounds of OwnerFollows::followed.
  std::optional<OpenedTrees> followed(const UserId& owner, const std::set<TreeId>& opened,
                                      std::chrono::milliseconds budget, const std::string& door, FollowTally& tally);

private:
  ProgressRepository& marks_;
  TreeRepository& trees_;
  Clock& clock_;
  OwnerFollows follows_;
};

}

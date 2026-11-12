#pragma once

#include "platform/ports/Clock.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/OpenedTrees.h"
#include "products/roadmap/domain/Tree.h"
#include "products/roadmap/ports/ProgressRepository.h"
#include "products/roadmap/ports/TreeRepository.h"

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <map>
#include <mutex>
#include <string>
#include <vector>

namespace wm {

// How long one owner's follow for a reader's answer may take, and how long an owner whose follow failed or ran past it
// is left unread before it is tried again. Past the budget the answer goes out without the steps that open a tree
// rather than hold a page that shows someone else's roadmap.
inline constexpr std::chrono::milliseconds kReaderFollowBudget{750};
inline constexpr std::chrono::minutes kFollowCoolOff{5};
// The most owners this process holds in a cool-off; past it the one that entered first is let go.
inline constexpr std::size_t kMaxCoolingOff = 1024;

// One owner whose trees a reader is shown, each tree with the pointers its steps hold.
struct OwnersTrees {
  UserId owner;
  std::map<TreeId, std::map<NodeId, StampedPointer>> trees;
};

// What one request's follows came to, counted by owner for its line.
struct FollowTally {
  int followed = 0;    // followed in time
  int timedOut = 0;    // ran past their budget
  int failed = 0;      // the read failed
  int coolingOff = 0;  // left unread: a follow of theirs failed or timed out within kFollowCoolOff
  int pastCap = 0;     // left unread: the request's time for follows ran out before or during theirs
  bool degraded() const { return timedOut + failed + coolingOff + pastCap > 0; }
  bool operator==(const FollowTally&) const = default;
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
  // kReaderFollowBudget, and the follows of the request take `cap` in all: an owner the cap leaves unreached is shown
  // unread for this request alone. An owner whose follow fails or runs past its whole budget enters a cool-off of
  // kFollowCoolOff, written as one `roadmap.progress.follow` line at `door`, during which every door shows them unread
  // at once; the next follow that answers ends it, with one line counting the replies it degraded.
  ShownToReaders shownToReaders(const std::vector<OwnersTrees>& owners, std::chrono::milliseconds cap,
                                const std::string& door);

private:
  struct CoolOff {
    std::uint64_t sinceMs = 0;
    std::uint64_t untilMs = 0;
    std::uint64_t degraded = 0;  // replies shown this owner unread since it began
  };
  // Whether `owner` is in a cool-off that has not run out, counting this reply among the ones it degraded.
  bool coolingOff(const UserId& owner);
  // Puts `owner` in a cool-off from now, counting this reply; false when a request racing this one already did, so
  // the follow that failed meanwhile writes no second line.
  bool enterCoolOff(const UserId& owner);
  // Ends `owner`'s cool-off, if one stands, with the line that counts the replies it degraded.
  void endCoolOff(const UserId& owner, const std::string& door);

  ProgressRepository& marks_;
  TreeRepository& trees_;
  Clock& clock_;
  std::mutex mutex_;
  std::map<UserId, CoolOff> coolOffs_;
};

}

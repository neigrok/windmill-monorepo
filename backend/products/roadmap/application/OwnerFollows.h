#pragma once

#include "platform/application/WriteObservation.h"
#include "platform/domain/Ids.h"
#include "platform/ports/Clock.h"
#include "products/roadmap/ports/TreeRepository.h"

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <map>
#include <mutex>
#include <new>
#include <optional>
#include <string>
#include <type_traits>

namespace wm {

// How long one owner's follow for a reader's answer may take, and how long an owner whose follow failed or ran past it
// is left unread before it is tried again. Past the budget the answer goes out without the steps that open a tree
// rather than hold a page that shows someone else's roadmap.
inline constexpr std::chrono::milliseconds kReaderFollowBudget{750};
inline constexpr std::chrono::minutes kFollowCoolOff{5};
// The most owners this process holds in a cool-off; past it the one that entered first is let go.
inline constexpr std::size_t kMaxCoolingOff = 1024;

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

// The bounds a reader's follow of one owner's roadmaps keeps, whatever store it reads: the rooms' trees
// (OwnerProgress) or the engine's records (EngineReadModels). Shared by every request of the process, which is what
// holds the cool-off.
class OwnerFollows {
public:
  explicit OwnerFollows(Clock& clock) : clock_(clock) {}

  // `read` of `owner`'s roadmaps within `budget`, at most kReaderFollowBudget, counted in `tally`; `read` is handed the
  // budget and throws FollowTimedOut past it. Nothing — the owner shown unread — while the owner cools off, with no
  // budget left, or when the read fails or runs past kReaderFollowBudget: that enters a cool-off of kFollowCoolOff,
  // written as one `roadmap.progress.follow` line at `door`, during which every door shows them unread at once; the next
  // follow that answers ends it, with one line counting the replies it degraded. A read cut short by a budget below
  // kReaderFollowBudget is the request's to blame, not the owner's: counted past the cap, no cool-off.
  template <typename Read>
  auto followed(const UserId& owner, std::chrono::milliseconds budget, const std::string& door, FollowTally& tally, Read&& read)
      -> std::optional<std::invoke_result_t<Read&, std::chrono::milliseconds>> {
    if (coolingOff(owner)) {
      ++tally.coolingOff;
      return std::nullopt;
    }
    // The request's time for follows ran out before this one.
    if (budget.count() <= 0) {
      ++tally.pastCap;
      return std::nullopt;
    }
    budget = std::min<std::chrono::milliseconds>(kReaderFollowBudget, budget);
    // Begun before the read borrows its connection, so its duration counts the wait for one.
    WriteObservation observation{"roadmap.progress.follow", "roadmap", door};
    try {
      auto standing = read(budget);
      ++tally.followed;
      observation.skip();  // a follow that answers writes nothing, as the tree read's own does
      endCoolOff(owner, door);
      return standing;
    } catch (const std::bad_alloc&) {
      throw;
    } catch (const FollowTimedOut&) {
      // Cut short by the request's cap rather than its own budget, the owner is not to blame.
      if (budget < kReaderFollowBudget) {
        ++tally.pastCap;
        observation.skip();
        return std::nullopt;
      }
      ++tally.timedOut;
      if (enterCoolOff(owner)) observation.finish("timeout");
      else observation.skip();
    } catch (const std::exception& failure) {
      ++tally.failed;
      if (enterCoolOff(owner)) observation.fail(failure);
      else observation.skip();
    }
    return std::nullopt;
  }

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

  Clock& clock_;
  std::mutex mutex_;
  std::map<UserId, CoolOff> coolOffs_;
};

}

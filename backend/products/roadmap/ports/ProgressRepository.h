#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tree.h"

#include <cstdint>
#include <map>
#include <optional>
#include <vector>

namespace wm {

// The completed set drives `done`; lastMarkedAt bumps the tree's recency.
struct ProgressDigest {
  Progress overlay;
  std::uint64_t lastMarkedAt = 0;  // epoch ms of the caller's latest mark on this tree, 0 if none
};

// A user's private, per-tree progress overlay, last-writer-wins by HLC. Never part of the shared op
// log or the tree document. `none` is a stamped VALUE, not a row delete. `at` is the stamp the marking
// replica minted and the only input to the merge; `receivedAtMs` is when this server took delivery,
// on its own clock, passed in rather than taken as now() inside the statement.
struct ProgressUpdate {
  NodeId node;
  ProgressStatus status;
  bool outOfOrder;
  Hlc at;
};

// Who stamped a write. A replica's stamp is the one it minted, and its mark loses to a later stamp the row holds: last
// writer wins. A server door's mark is the latest write there is, so where the row holds a stamp that is not earlier —
// a replica stamped it ahead of the server — the mark takes the stamp just after that one (Hlc::successor) and lands.
enum class StampedBy { replica, server };

// What one write met and did, answered by the statement that made it, so no other write stands between the two.
// `held` is the mark the row held when the write reached it, a node never marked holding `none` unstamped; it is absent
// in the one case the statement cannot see it: a first mark that met a row another write had just put under it.
// `landed` is the mark the row took, absent when a replica's write lost to a later stamp.
struct ProgressWritten {
  std::optional<ProgressMark> held;
  std::optional<ProgressMark> landed;
  bool operator==(const ProgressWritten&) const = default;
};

struct ProgressRepository {
  virtual ~ProgressRepository() = default;
  virtual Progress load(const TreeId& tree, const UserId& user) = 0;
  // One replica's mark. Answers whether the write LANDED — false when a strictly-later stamp was already stored and
  // this one lost.
  virtual bool setStatus(const TreeId& tree, const UserId& user, const NodeId& node,
                         ProgressStatus status, bool outOfOrder, const Hlc& at, std::uint64_t receivedAtMs) = 0;
  // The updates in one transaction, each answered in its place. A node named twice meets its own earlier row.
  virtual std::vector<ProgressWritten> setStatuses(const TreeId& tree, const UserId& user,
                                                   const std::vector<ProgressUpdate>& updates, StampedBy stampedBy,
                                                   std::uint64_t receivedAtMs) = 0;
  // Every tree this user has touched, keyed by tree id — one read behind the registry list.
  virtual std::map<TreeId, ProgressDigest> overlaysFor(const UserId& user) = 0;
};

}

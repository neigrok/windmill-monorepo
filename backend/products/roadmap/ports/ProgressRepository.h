#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tree.h"

#include <cstdint>
#include <map>

namespace wm {

// One tree's overlay for a user, plus when they last marked it — the registry reads both:
// the completed set drives `done`, lastMarkedAt bumps the tree's recency.
struct ProgressDigest {
  Progress overlay;
  std::uint64_t lastMarkedAt = 0;  // epoch ms of the caller's latest mark on this tree, 0 if none
};

// A user's private, per-tree progress overlay (last-writer-wins by HLC). Never part of
// the shared op log or the tree document. `none` is a stamped VALUE, not a row delete.
//
// Two instants ride every write and they answer different questions. `at` is the stamp the
// marking replica minted and the ONLY input to the merge. `receivedAtMs` is when this server
// took delivery, on its own clock, stored so a reader can be told when a mark happened without
// being told a marking device's clock (GRAPH_SYNC_DESIGN.md §12). It is passed in rather than
// taken as `now()` inside the statement so that one write's receipt is one instant — the row
// and the echo that announces it cannot disagree.
struct ProgressRepository {
  virtual ~ProgressRepository() = default;
  virtual Progress load(const TreeId& tree, const UserId& user) = 0;
  virtual void setStatus(const TreeId& tree, const UserId& user, const NodeId& node,
                         ProgressStatus status, const Hlc& at, std::uint64_t receivedAtMs) = 0;
  // Every tree this user has touched, keyed by tree id — one read behind the registry list.
  virtual std::map<TreeId, ProgressDigest> overlaysFor(const UserId& user) = 0;
};

}

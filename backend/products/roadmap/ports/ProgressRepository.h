#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tree.h"

#include <cstdint>
#include <map>

namespace wm {

// The completed set drives `done`; lastMarkedAt bumps the tree's recency.
struct ProgressDigest {
  Progress overlay;
  std::uint64_t lastMarkedAt = 0;  // epoch ms of the caller's latest mark on this tree, 0 if none
};

// A user's private, per-tree progress overlay (last-writer-wins by HLC). Never part of the shared
// op log or the tree document. `none` is a stamped VALUE, not a row delete.
//
// `at` is the stamp the marking replica minted and the ONLY input to the merge. `receivedAtMs` is
// when this server took delivery, on its own clock; it is passed in rather than taken as `now()`
// inside the statement, so a write's row and the echo that announces it cannot disagree.
struct ProgressRepository {
  virtual ~ProgressRepository() = default;
  virtual Progress load(const TreeId& tree, const UserId& user) = 0;
  // Answers whether the write LANDED — false when a strictly-later stamp was already stored and
  // this one lost. Callers need it to avoid announcing a mark the overlay does not hold.
  virtual bool setStatus(const TreeId& tree, const UserId& user, const NodeId& node,
                         ProgressStatus status, const Hlc& at, std::uint64_t receivedAtMs) = 0;
  // Every tree this user has touched, keyed by tree id — one read behind the registry list.
  virtual std::map<TreeId, ProgressDigest> overlaysFor(const UserId& user) = 0;
};

}

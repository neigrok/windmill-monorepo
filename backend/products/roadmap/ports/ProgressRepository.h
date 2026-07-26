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
// the shared op log or the tree document. `none` clears a node's entry.
struct ProgressRepository {
  virtual ~ProgressRepository() = default;
  virtual Progress load(const TreeId& tree, const UserId& user) = 0;
  virtual void setStatus(const TreeId& tree, const UserId& user, const NodeId& node,
                         ProgressStatus status, const Hlc& at) = 0;
  // Every tree this user has touched, keyed by tree id — one read behind the registry list.
  virtual std::map<TreeId, ProgressDigest> overlaysFor(const UserId& user) = 0;
};

}

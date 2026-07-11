#pragma once

#include "domain/Ids.h"
#include "domain/Tree.h"

namespace wm {

// A user's private, per-tree progress overlay (last-writer-wins by HLC). Never part of
// the shared op log or the tree document. `none` clears a node's entry.
struct ProgressRepository {
  virtual ~ProgressRepository() = default;
  virtual Progress load(const TreeId& tree, const UserId& user) = 0;
  virtual void setStatus(const TreeId& tree, const UserId& user, const NodeId& node,
                         ProgressStatus status, const Hlc& at) = 0;
};

}

#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tree.h"

#include <optional>
#include <string>
#include <vector>

namespace wm {

// The full CRDT state of one node: element-set life stamps plus each field's LWW stamp.
// This is what gets persisted, so reload is lossless (tombstones and inert edges too).
struct NodeStateEntry {
  NodeId id;
  Hlc createdAt;
  Hlc deletedAt;
  std::string label;
  Hlc labelAt;
  std::string icon;
  Hlc iconAt;
  NodeColor color = NodeColor::terracotta;
  Hlc colorAt;
  std::string order;  // fractional-index key scoped to the parent; opaque here — the server never interprets it
  Hlc orderAt;
  std::optional<std::string> status;
  Hlc statusAt;
  std::string description;
  Hlc descriptionAt;
  std::vector<Link> links;
  Hlc linksAt;
  TreeId opens;  // the tree this node opens; an empty id opens none
  Hlc opensAt;
  bool operator==(const NodeStateEntry&) const = default;
};

struct EdgeStateEntry {
  Edge edge;
  Hlc addedAt;
  Hlc removedAt;
  bool operator==(const EdgeStateEntry&) const = default;
};

struct GraphState {
  std::vector<NodeStateEntry> nodes;
  std::vector<EdgeStateEntry> edges;
  bool operator==(const GraphState&) const = default;
  bool empty() const { return nodes.empty() && edges.empty(); }
};

// Whether a register a write carries lands over the entry the tree holds: it changes what the tree holds, an empty
// value included, or the tree holds nothing there yet. A carried register equal to the held one is an echo, not the
// write's word. A graft lands every register by this, a re-hue leaves a node the batch sends a colour for to the batch
// only when that colour lands by it, and a colour sent beside a kind that does not land by it yields to the kind.
template <typename Entry, typename Value>
bool landsOver(const std::optional<Entry>& held, Value Entry::*field, const Value& sent) {
  return !held || (*held).*field != sent;
}

}

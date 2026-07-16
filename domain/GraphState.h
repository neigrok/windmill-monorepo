#pragma once

#include "domain/Ids.h"
#include "domain/Tree.h"

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
  std::optional<Vec2> position;
  Hlc positionAt;
  std::optional<std::string> status;
  Hlc statusAt;
  std::string description;
  Hlc descriptionAt;
  std::vector<Link> links;
  Hlc linksAt;
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
};

}

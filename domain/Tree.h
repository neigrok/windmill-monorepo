#pragma once

#include "domain/Ids.h"

#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

namespace wm {

enum class NodeColor { terracotta, olive, gold, brick, sky, plum };

enum class NodeState { locked, available, active, complete };

// The status a SetNodeProgress command carries; `none` clears the overlay entry.
enum class ProgressStatus { none, active, complete };

enum class EdgeKind { trunk, in_branch, cross_branch };

inline std::string_view toString(NodeState state) {
  switch (state) {
    case NodeState::locked:    return "locked";
    case NodeState::available: return "available";
    case NodeState::active:    return "active";
    case NodeState::complete:  return "complete";
  }
  return "locked";
}

inline std::string_view toString(EdgeKind kind) {
  switch (kind) {
    case EdgeKind::trunk:        return "trunk";
    case EdgeKind::in_branch:    return "in-branch";
    case EdgeKind::cross_branch: return "cross-branch";
  }
  return "cross-branch";
}

inline std::string_view toString(NodeColor color) {
  switch (color) {
    case NodeColor::terracotta: return "terracotta";
    case NodeColor::olive:      return "olive";
    case NodeColor::gold:       return "gold";
    case NodeColor::brick:      return "brick";
    case NodeColor::sky:        return "sky";
    case NodeColor::plum:       return "plum";
  }
  return "terracotta";
}

inline std::optional<NodeColor> parseColor(std::string_view name) {
  if (name == "terracotta") return NodeColor::terracotta;
  if (name == "olive")      return NodeColor::olive;
  if (name == "gold")       return NodeColor::gold;
  if (name == "brick")      return NodeColor::brick;
  if (name == "sky")        return NodeColor::sky;
  if (name == "plum")       return NodeColor::plum;
  return std::nullopt;
}

inline std::optional<ProgressStatus> parseProgressStatus(std::string_view name) {
  if (name == "active")   return ProgressStatus::active;
  if (name == "complete") return ProgressStatus::complete;
  if (name == "none")     return ProgressStatus::none;
  return std::nullopt;
}

struct Vec2 {
  double x = 0;
  double y = 0;
  bool operator==(const Vec2&) const = default;
};

struct Edge {
  NodeId from;
  NodeId to;
  bool operator==(const Edge&) const = default;
  auto operator<=>(const Edge&) const = default;
};

// The wire/persist shape of a node: `from -> id` edges live as `prerequisites`.
// `status` is an opaque authoring-time seed (§2) the server round-trips but never acts
// on — runtime status is the per-user Progress overlay.
struct NodeSpec {
  NodeId id;
  std::string label;
  std::string icon;
  NodeColor color = NodeColor::terracotta;
  std::vector<NodeId> prerequisites;
  std::optional<Vec2> position;
  std::optional<std::string> status;
};

// A legend entry: a named, described hue. A node's `color` field *is* its kind — it
// holds the hue — so there is no node→kind foreign key. The legend names and orders the
// hues; order is generation priority (§F6). `label`/`description` may be empty.
struct Kind {
  KindId id;
  NodeColor hue = NodeColor::terracotta;
  std::string label;
  std::string description;
};

struct TreeData {
  TreeId id;
  std::string title;
  std::vector<NodeSpec> nodes;
  std::vector<Kind> kinds;
};

// A user's progress over one tree: the two id sets the client already tracks.
struct Progress {
  std::set<NodeId> completed;
  std::set<NodeId> inProgress;
};

}

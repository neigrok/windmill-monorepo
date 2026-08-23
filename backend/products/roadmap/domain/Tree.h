#pragma once

#include "products/roadmap/domain/Ids.h"

#include <cstdint>
#include <map>
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

inline std::optional<NodeState> parseNodeState(std::string_view name) {
  if (name == "locked")    return NodeState::locked;
  if (name == "available") return NodeState::available;
  if (name == "active")    return NodeState::active;
  if (name == "complete")  return NodeState::complete;
  return std::nullopt;
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

// The six hues as hex, straight from the design tokens (src/skilltree/theme.js → tokens/colors.css).
// Every server-rendered surface reads the palette from here. Also the safe form for a mail: a
// colour is one of these six literals and never a string that came from a person, which matters
// where it lands in a style attribute.
inline const char* nodeColorHex(NodeColor color) {
  switch (color) {
    case NodeColor::terracotta: return "#BC6C42";
    case NodeColor::olive:      return "#7D8C43";
    case NodeColor::gold:       return "#C4972F";
    case NodeColor::brick:      return "#A84E35";
    case NodeColor::sky:        return "#5F8494";
    case NodeColor::plum:       return "#8D4F83";
  }
  return "#BC6C42";
}

inline std::optional<ProgressStatus> parseProgressStatus(std::string_view name) {
  if (name == "active")   return ProgressStatus::active;
  if (name == "complete") return ProgressStatus::complete;
  if (name == "none")     return ProgressStatus::none;
  return std::nullopt;
}

inline const char* progressStatusName(ProgressStatus status) {
  switch (status) {
    case ProgressStatus::active:   return "active";
    case ProgressStatus::complete: return "complete";
    case ProgressStatus::none:     return "none";
  }
  return "none";
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

// An external reference hung off a node. `label` is the display text (empty = show the url).
struct Link {
  std::string label;
  std::string url;
  bool operator==(const Link&) const = default;
};

// The wire/persist shape of a node: `from -> id` edges live as `prerequisites`. `status` is an
// opaque authoring-time seed the server round-trips but never acts on — runtime status is the
// per-user Progress overlay. `description` and `links` are the node's free annotation.
struct NodeSpec {
  NodeId id;
  std::string label;
  std::string icon;
  NodeColor color = NodeColor::terracotta;
  std::string order;  // fractional-index sibling key ('' ⇒ layout falls back to creation time)
  std::vector<NodeId> prerequisites;
  std::optional<Vec2> position;
  std::optional<std::string> status;
  std::string description;
  std::vector<Link> links;
};

// A legend entry: a named, described hue. A node's `color` field *is* its kind, so there is no
// node→kind foreign key. The legend names and orders the hues; order is generation priority.
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

// One node's mark as the overlay holds it. `at` is the stamp that won this register, and the only
// thing that decides what wins. `markedAt` is when the SERVER recorded it, on the server's own
// clock, and is the only one of the two that may be shown to a person.
struct ProgressMark {
  ProgressStatus status = ProgressStatus::none;
  Hlc at;
  std::uint64_t markedAt = 0;  // epoch ms, server clock; 0 where the overlay keeps no times
};

// A user's private progress over one tree: a last-writer-wins register per node, plus the three id
// sets every reader asks for. `record` is the only way in, so the sets can never drift from the
// registers they project. `none` is a VALUE here, not a deletion.
struct Progress {
  std::map<NodeId, ProgressMark> marks;
  std::set<NodeId> completed;
  std::set<NodeId> inProgress;
  std::set<NodeId> cleared;

  void record(const NodeId& node, const ProgressMark& mark) {
    marks[node] = mark;
    completed.erase(node);
    inProgress.erase(node);
    cleared.erase(node);
    if (mark.status == ProgressStatus::complete) completed.insert(node);
    else if (mark.status == ProgressStatus::active) inProgress.insert(node);
    else cleared.insert(node);
  }
};

}

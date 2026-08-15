#pragma once

#include "products/roadmap/domain/Ids.h"

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
// Every server-rendered surface reads the palette from here — the gallery card's bar, the reminder
// mail's step glyphs — so the legend is one identity everywhere it appears rather than a literal
// copied per adapter. Also the safe form for a mail: a colour is one of these six literals and
// never a string that came from a person, which matters where it lands in a style attribute.
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

// An external reference hung off a node — a doc, a PR, a design. `label` is the display
// text (empty = show the url); `url` is the href.
struct Link {
  std::string label;
  std::string url;
  bool operator==(const Link&) const = default;
};

// The wire/persist shape of a node: `from -> id` edges live as `prerequisites`.
// `status` is an opaque authoring-time seed (§2) the server round-trips but never acts
// on — runtime status is the per-user Progress overlay. `description` and `links` are the
// node's free annotation: a body of notes and a set of external references.
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

// A user's progress over one tree: the two id sets the client already tracks, plus the
// cleared tombstones — visible so a client's reconcile can tell "cleared" from "never
// marked" and never resurrects a clear with a stale local mark.
struct Progress {
  std::set<NodeId> completed;
  std::set<NodeId> inProgress;
  std::set<NodeId> cleared;
};

}

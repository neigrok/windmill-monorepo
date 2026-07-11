#include "application/ActivityFeed.h"

#include "domain/SkillTree.h"
#include "domain/TrunkTree.h"

#include <algorithm>
#include <map>
#include <optional>
#include <variant>

namespace wm {

namespace {
std::string displayActor(const std::string& actor) {
  if (actor == "dev") return "You";
  if (actor.size() > 1 && actor.front() == 'u') {
    bool numeric = std::all_of(actor.begin() + 1, actor.end(), [](char c) { return c >= '0' && c <= '9'; });
    if (numeric) return "Guest " + actor.substr(1);
  }
  return {};  // genesis / seed / unknown → the tree itself
}
}

std::vector<ActivityEvent> activityFeed(const TreeData& current, const std::vector<AppliedOp>& ops, std::size_t limit) {
  std::map<NodeId, const NodeSpec*> byId;
  for (const NodeSpec& node : current.nodes) byId.emplace(node.id, &node);

  // Branch context (SPEC §9) is available only when the current graph is a clean tree.
  std::optional<SkillTree> tree;
  try {
    tree.emplace(current);
  } catch (const std::exception&) {
    tree.reset();
  }

  auto named = [](const std::string& label) { return label.empty() ? std::string("a step") : label; };
  auto labelOf = [&](const NodeId& id) {
    auto it = byId.find(id);
    return it != byId.end() ? it->second->label : id.str();
  };
  auto kindOf = [&](const NodeId& id) {
    auto it = byId.find(id);
    return it != byId.end() ? std::string(toString(it->second->color)) : std::string{};
  };
  auto crossBranch = [&](const NodeId& from, const NodeId& to) {
    if (!tree || !byId.count(from) || !byId.count(to)) return std::string{};
    return tree->trunk().edgeKind(from, to) == EdgeKind::cross_branch ? std::string(" · cross-branch") : std::string{};
  };
  auto link = [&](const NodeId& from, const NodeId& to) { return named(labelOf(from)) + " → " + named(labelOf(to)); };

  std::vector<ActivityEvent> events;
  for (const AppliedOp& op : ops) {
    ActivityEvent event;
    event.seq = op.seq;
    event.at = op.createdAtMs;
    event.actor = displayActor(op.actor.str());
    const Command& command = op.command;

    if (auto* c = std::get_if<CreateNode>(&command)) {
      event.verb = "added"; event.node = c->id;
      event.label = byId.count(c->id) ? labelOf(c->id) : c->label;
      event.kind = kindOf(c->id);
      event.summary = "added " + named(event.label);
    } else if (auto* c = std::get_if<RenameNode>(&command)) {
      event.verb = "renamed"; event.node = c->id; event.label = c->label; event.kind = kindOf(c->id);
      event.summary = "renamed to " + named(c->label);
    } else if (auto* c = std::get_if<SetNodeColor>(&command)) {
      event.verb = "recolored"; event.node = c->id; event.label = labelOf(c->id);
      event.kind = std::string(toString(c->color));
      event.summary = "recolored " + named(event.label) + " " + event.kind;
    } else if (auto* c = std::get_if<DeleteNode>(&command)) {
      event.verb = "removed"; event.node = c->id; event.label = labelOf(c->id); event.kind = kindOf(c->id);
      event.summary = "removed " + named(event.label);
    } else if (auto* c = std::get_if<AddEdge>(&command)) {
      event.verb = "linked"; event.node = c->to; event.label = labelOf(c->to); event.kind = kindOf(c->to);
      event.summary = "linked " + link(c->from, c->to) + crossBranch(c->from, c->to);
    } else if (auto* c = std::get_if<RemoveEdge>(&command)) {
      event.verb = "unlinked"; event.node = c->to; event.label = labelOf(c->to); event.kind = kindOf(c->to);
      event.summary = "unlinked " + link(c->from, c->to);
    } else if (auto* c = std::get_if<ReconnectEdge>(&command)) {
      event.verb = "rerouted"; event.node = c->newTo; event.label = labelOf(c->newTo); event.kind = kindOf(c->newTo);
      event.summary = "rerouted " + link(c->newFrom, c->newTo) + crossBranch(c->newFrom, c->newTo);
    } else if (std::get_if<TransitiveReduction>(&command)) {
      event.verb = "tidied"; event.summary = "tidied redundant links";
    } else {
      continue;  // RepositionNode: a nudge is not a feed-worthy deed
    }
    events.push_back(std::move(event));
  }

  if (events.size() > limit) events.erase(events.begin(), events.end() - static_cast<std::ptrdiff_t>(limit));
  return events;
}

}

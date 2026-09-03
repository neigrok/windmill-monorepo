#include "products/roadmap/application/ActivityFeed.h"

#include "products/roadmap/domain/SkillTree.h"
#include "products/roadmap/domain/TrunkTree.h"

#include <algorithm>
#include <map>
#include <optional>
#include <utility>
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

// One command to one event, with the tree's current labels for context; nullopt for a nudge.
class Projector {
public:
  explicit Projector(const TreeData& current) {
    for (const NodeSpec& node : current.nodes) byId_.emplace(node.id, &node);
    // Branch context is available only when the current graph is a clean tree.
    try {
      tree_.emplace(current);
    } catch (const std::exception&) {
      tree_.reset();
    }
  }

  std::optional<ActivityEvent> operator()(const Command& command) const {
    ActivityEvent event;
    if (auto* c = std::get_if<CreateNode>(&command)) {
      event.verb = "added"; event.node = c->id;
      event.label = byId_.count(c->id) ? labelOf(c->id) : c->label;
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
    } else if (auto* c = std::get_if<AddKind>(&command)) {
      event.verb = "added-kind"; event.kind = std::string(toString(c->hue));
      event.summary = "added a " + event.kind + " kind";
    } else if (auto* c = std::get_if<RenameKind>(&command)) {
      event.verb = "renamed-kind"; event.label = c->label;
      event.summary = "renamed a kind to " + named(c->label);
    } else if (auto* c = std::get_if<DescribeKind>(&command)) {
      event.verb = "described-kind";
      if (c->description) event.summary = "described a kind";
      else if (c->crossBranchExempt.value_or(false)) event.summary = "marked a kind cross-branch exempt";
      else event.summary = "cleared a kind's cross-branch exemption";
    } else if (std::get_if<RemoveKind>(&command)) {
      event.verb = "removed-kind"; event.summary = "removed a kind";
    } else if (std::get_if<ReorderKinds>(&command)) {
      event.verb = "reordered-kinds"; event.summary = "reordered the legend";
    } else if (auto* c = std::get_if<RecolorKind>(&command)) {
      event.verb = "recolored-kind"; event.kind = std::string(toString(c->hue));
      event.summary = "recolored a kind " + event.kind;
    } else if (auto* c = std::get_if<Batch>(&command)) {
      return batch(*c);
    } else {
      return std::nullopt;  // RepositionNode: a nudge is not a feed-worthy deed
    }
    return event;
  }

private:
  // Summed by verb in first-appearance order, under the first member's verb and subject:
  // "removed 2 nodes and unlinked 3 links". Nudges inside it count for nothing.
  std::optional<ActivityEvent> batch(const Batch& batch) const {
    std::vector<std::pair<std::string, int>> countByVerb;
    std::optional<ActivityEvent> first;
    for (const Command& member : batch.commands) {
      std::optional<ActivityEvent> event = (*this)(member);
      if (!event) continue;
      if (!first) first = event;
      auto counted = std::find_if(countByVerb.begin(), countByVerb.end(),
                                  [&](const auto& entry) { return entry.first == event->verb; });
      if (counted == countByVerb.end()) countByVerb.emplace_back(event->verb, 1);
      else ++counted->second;
    }
    if (!first) return std::nullopt;
    std::string summary;
    for (const auto& [verb, count] : countByVerb) {
      if (!summary.empty()) summary += " and ";
      summary += verb + " " + std::to_string(count) + " " + noun(verb) + (count == 1 ? "" : "s");
    }
    first->summary = summary;
    return first;
  }

  static std::string noun(const std::string& verb) {
    if (verb == "linked" || verb == "unlinked" || verb == "rerouted") return "link";
    if (verb == "added" || verb == "removed" || verb == "renamed" || verb == "recolored") return "node";
    if (verb.size() > 5 && verb.compare(verb.size() - 5, 5, "-kind") == 0) return "kind";
    return "edit";
  }

  static std::string named(const std::string& label) { return label.empty() ? std::string("a step") : label; }
  std::string labelOf(const NodeId& id) const {
    auto it = byId_.find(id);
    return it != byId_.end() ? it->second->label : id.str();
  }
  std::string kindOf(const NodeId& id) const {
    auto it = byId_.find(id);
    return it != byId_.end() ? std::string(toString(it->second->color)) : std::string{};
  }
  std::string crossBranch(const NodeId& from, const NodeId& to) const {
    if (!tree_ || !byId_.count(from) || !byId_.count(to)) return {};
    return tree_->trunk().edgeKind(from, to) == EdgeKind::cross_branch ? std::string(" · cross-branch") : std::string{};
  }
  std::string link(const NodeId& from, const NodeId& to) const {
    return named(labelOf(from)) + " → " + named(labelOf(to));
  }

  std::map<NodeId, const NodeSpec*> byId_;
  std::optional<SkillTree> tree_;
};
}

std::vector<ActivityEvent> activityFeed(const TreeData& current, const std::vector<AppliedOp>& ops, std::size_t limit) {
  const Projector project{current};
  std::vector<ActivityEvent> events;
  for (const AppliedOp& op : ops) {
    std::optional<ActivityEvent> event = project(op.command);
    if (!event) continue;
    event->seq = op.seq;
    event->at = op.createdAtMs;
    event->actor = displayActor(op.actor.str());
    events.push_back(std::move(*event));
  }

  if (events.size() > limit) events.erase(events.begin(), events.end() - static_cast<std::ptrdiff_t>(limit));
  return events;
}

}

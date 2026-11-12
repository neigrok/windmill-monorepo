#include "products/roadmap/domain/Command.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <map>
#include <set>

namespace wm {

namespace {
template <class... Ts>
struct overloaded : Ts... { using Ts::operator()...; };
template <class... Ts>
overloaded(Ts...) -> overloaded<Ts...>;

std::string quoted(const std::string& value) { return "\"" + value + "\""; }

std::string appendedTo(const std::string& body, const std::string& tail) {
  if (body.empty()) return tail;
  return body + "\n\n" + tail;
}

// Every field a command or an arriving document overflows, named in ONE sentence — each clause
// says the size the field would have, how far over it is, and the cap — so a caller who overran
// several caps fixes them all in one round trip.
struct Overages {
  std::vector<std::string> clauses;

  void note(const std::string& field, const std::string& value, std::size_t cap) {
    if (!isValidUtf8(value)) {
      clauses.push_back(field + " is not valid UTF-8");
      return;
    }
    if (value.find('\0') != std::string::npos) {
      clauses.push_back(field + " contains a NUL character");
      return;
    }
    const std::size_t size = codePointCount(value);
    if (size <= cap) return;
    clauses.push_back(field + " would be " + std::to_string(size) + " characters, " +
                      std::to_string(size - cap) + " over the " + std::to_string(cap) + " cap");
  }
  void noteLinks(const std::vector<Link>& links) {
    if (links.size() > kMaxNodeLinks)
      clauses.push_back("links has " + std::to_string(links.size()) + " items, max " +
                        std::to_string(kMaxNodeLinks));
    for (std::size_t i = 0; i < links.size(); ++i) {
      const std::string item = "links[" + std::to_string(i) + "]";
      note(item + ".url", links[i].url, kMaxLinkUrlLength);
      note(item + ".label", links[i].label, kMaxLinkLabelLength);
    }
  }
  std::optional<std::string> sentence() const {
    if (clauses.empty()) return std::nullopt;
    std::string out = clauses[0];
    for (std::size_t i = 1; i < clauses.size(); ++i) out += "; " + clauses[i];
    return out;
  }
};

// Every per-node bound admit() enforces, wherever the node arrived from. An over-long id is never
// quoted back: echoing it would make the refusal as expensive as the request.
std::optional<std::string> nodeFieldBounds(const NodeId& id, const std::string& label, const std::string& icon,
                                           const std::string& description, const std::vector<Link>& links,
                                           const TreeId& opens, const std::optional<Vec2>& position) {
  if (id.empty()) return "a node has an empty id";
  Overages idOver;
  idOver.note("a node id", id.str(), kMaxIdLength);
  if (std::optional<std::string> bad = idOver.sentence()) return bad;
  const std::string named = "node " + quoted(id.str()) + ": ";
  Overages over;
  over.note("label", label, kMaxNodeLabelLength);
  over.note("icon", icon, kMaxIconLength);
  over.note("description", description, kMaxNodeDescriptionLength);
  over.noteLinks(links);
  over.note("opens", opens.str(), kMaxIdLength);
  if (std::optional<std::string> bad = over.sentence()) return named + *bad;
  if (position && !(std::isfinite(position->x) && std::isfinite(position->y)))
    return named + "position is not finite";
  return std::nullopt;
}

// An edge names two ids that may belong to no node the frame carries, so they are bounded on
// their own — a dangling edge lands, but never one Postgres would refuse to store.
std::optional<std::string> edgeEndpointBounds(const Edge& edge) {
  for (const NodeId* endpoint : {&edge.from, &edge.to}) {
    if (endpoint->empty()) return "an edge has an empty endpoint";
    Overages over;
    over.note("an edge endpoint", endpoint->str(), kMaxIdLength);
    if (std::optional<std::string> bad = over.sentence()) return bad;
  }
  return std::nullopt;
}

// Every per-kind bound admit() enforces, wherever the kind arrived from.
std::optional<std::string> kindFieldBounds(const KindId& id, const std::string& label,
                                           const std::string& description) {
  if (id.empty()) return "a kind has an empty id";
  Overages idOver;
  idOver.note("a kind id", id.str(), kMaxIdLength);
  if (std::optional<std::string> bad = idOver.sentence()) return bad;
  const std::string named = "kind " + quoted(id.str()) + ": ";
  Overages over;
  over.note("label", label, kMaxKindLabelLength);
  over.note("description", description, kMaxKindDescriptionLength);
  if (std::optional<std::string> bad = over.sentence()) return named + *bad;
  return std::nullopt;
}

// The two whole-tree ceilings, read off the totals the arrival would leave behind, and stated after
// the field bounds. A ceiling refuses GROWTH, not size.
std::optional<Admission> growthWithin(std::size_t nodesBefore, std::size_t nodesAfter,
                                      std::size_t edgesBefore, std::size_t edgesAfter) {
  if (nodesAfter > kMaxNodes && nodesAfter > nodesBefore)
    return Admission{Admission::Verdict::tooLarge,
                     "this tree would hold " + std::to_string(nodesAfter) + " nodes, max " +
                         std::to_string(kMaxNodes) + " — split it across roadmaps, or delete what it has outgrown"};
  if (edgesAfter > kMaxEdges && edgesAfter > edgesBefore)
    return Admission{Admission::Verdict::tooLarge,
                     "this tree would hold " + std::to_string(edgesAfter) + " edges, max " +
                         std::to_string(kMaxEdges) + " — call tidy to drop the edges a longer path already implies"};
  return std::nullopt;
}
}

bool isValidUtf8(const std::string& bytes) {
  const std::size_t size = bytes.size();
  std::size_t i = 0;
  while (i < size) {
    const unsigned char lead = static_cast<unsigned char>(bytes[i]);
    if (lead < 0x80) {
      ++i;
      continue;
    }
    std::size_t length = 0;
    std::uint32_t value = 0;
    std::uint32_t floor = 0;  // the smallest code point this length may encode; below it is overlong
    if (lead >= 0xC2 && lead <= 0xDF) { length = 2; value = lead & 0x1F; floor = 0x80; }
    else if (lead >= 0xE0 && lead <= 0xEF) { length = 3; value = lead & 0x0F; floor = 0x800; }
    else if (lead >= 0xF0 && lead <= 0xF4) { length = 4; value = lead & 0x07; floor = 0x10000; }
    else return false;  // a lone continuation byte, an overlong lead (C0, C1) or a lead past F4
    if (i + length > size) return false;  // truncated sequence
    for (std::size_t k = 1; k < length; ++k) {
      const unsigned char next = static_cast<unsigned char>(bytes[i + k]);
      if ((next & 0xC0) != 0x80) return false;
      value = (value << 6) | (next & 0x3F);
    }
    if (value < floor) return false;
    if (value >= 0xD800 && value <= 0xDFFF) return false;  // a UTF-16 surrogate is not a scalar value
    if (value > 0x10FFFF) return false;
    i += length;
  }
  return true;
}

std::size_t codePointCount(const std::string& utf8) {
  std::size_t count = 0;
  for (char byte : utf8)
    if ((static_cast<unsigned char>(byte) & 0xC0) != 0x80) ++count;
  return count;
}

std::size_t byteOffsetOfCodePoint(const std::string& utf8, std::size_t index) {
  std::size_t seen = 0;
  for (std::size_t i = 0; i < utf8.size(); ++i) {
    if ((static_cast<unsigned char>(utf8[i]) & 0xC0) == 0x80) continue;
    if (seen == index) return i;
    ++seen;
  }
  return std::string::npos;
}

void merge(LooseGraph& graph, Legend& legend, const Command& command, const Hlc& at) {
  std::visit(overloaded{
    [&](const RenameNode& c) { graph.setLabel(c.id, c.label, at); },
    [&](const SetNodeColor& c) { graph.setColor(c.id, c.color, at); },
    [&](const RepositionNode& c) { graph.setPosition(c.id, c.position, at); },
    [&](const CreateNode& c) {
      graph.createNode(c.id, c.label, c.icon, c.color, c.position, at);
      if (!c.description.empty()) graph.setDescription(c.id, c.description, at);
      if (!c.links.empty()) graph.setLinks(c.id, c.links, at);
      if (c.opens) graph.setOpens(c.id, *c.opens, at);
      for (const NodeId& prereq : c.prerequisites) graph.addEdge(prereq, c.id, at);
    },
    [&](const AnnotateNode& c) {
      if (c.icon) graph.setIcon(c.id, *c.icon, at);
      if (c.description) graph.setDescription(c.id, *c.description, at);
      if (c.appendDescription)
        graph.setDescription(c.id, appendedTo(graph.descriptionOf(c.id), *c.appendDescription), at);
      if (c.links) graph.setLinks(c.id, *c.links, at);
      if (c.opens) graph.setOpens(c.id, *c.opens, at);
    },
    [&](const AddEdge& c) { graph.addEdge(c.from, c.to, at); },
    [&](const RemoveEdge& c) { graph.removeEdge(c.from, c.to, at); },
    [&](const ReconnectEdge& c) {
      graph.removeEdge(c.oldFrom, c.oldTo, at);
      graph.addEdge(c.newFrom, c.newTo, at);
    },
    [&](const DeleteNode& c) { graph.deleteNode(c.id, at); },
    [&](const TransitiveReduction&) {
      for (const auto& edge : graph.redundantEdges()) graph.removeEdge(edge.from, edge.to, at);
    },
    [&](const PruneDangling&) {
      for (const auto& edge : graph.danglingEdges()) graph.removeEdge(edge.from, edge.to, at);
    },
    [&](const RenameKind& c) { legend.setLabel(c.id, c.label, at); },
    [&](const DescribeKind& c) {
      if (c.description) legend.setDescription(c.id, *c.description, at);
      if (c.crossBranchExempt) legend.setCrossBranchExempt(c.id, *c.crossBranchExempt, at);
    },
    [&](const AddKind& c) {
      legend.addKind(c.id, c.hue, at);
      if (!c.label.empty()) legend.setLabel(c.id, c.label, at);
      if (!c.description.empty()) legend.setDescription(c.id, c.description, at);
      if (c.crossBranchExempt) legend.setCrossBranchExempt(c.id, true, at);
    },
    [&](const RemoveKind& c) { legend.removeKind(c.id, at); },
    [&](const ReorderKinds& c) { legend.reorder(c.order, at); },
    [&](const RecolorKind& c) {
      if (!legend.hueOf(c.id)) return;
      const std::vector<NodeId> wearers = wearersOf(graph, legend, c.id);
      legend.setHue(c.id, c.hue, at);
      for (const NodeId& node : wearers) graph.setColor(node, c.hue, at);
    },
    [&](const Batch& c) {
      for (const Command& member : c.commands) merge(graph, legend, member, at);
    },
  }, command);
}

// A refusal names the id, the value that clashed, who holds it, and the limit that was reached: the
// caller cannot see this state and must be able to act on the sentence alone.
std::optional<std::string> validate(const LooseGraph& graph, const Legend& legend, const Command& command) {
  auto idBounds = [](const NodeId& id) -> std::optional<std::string> {
    if (id.empty()) return "node id is empty";
    Overages over;
    over.note("node id", id.str(), kMaxIdLength);
    return over.sentence();
  };
  // An edit of one node's registers must land on a present node: a tombstoned or never-created id
  // would otherwise be written as a phantom no reader ever sees.
  auto present = [&](const NodeId& id) -> std::optional<std::string> {
    if (graph.hasNode(id)) return std::nullopt;
    return "no node in this tree is named " + quoted(id.str());
  };
  return std::visit(overloaded{
    [&](const CreateNode& c) -> std::optional<std::string> {
      if (auto bad = idBounds(c.id)) return bad;
      Overages over;
      over.note("label", c.label, kMaxNodeLabelLength);
      over.note("icon", c.icon, kMaxIconLength);
      over.note("description", c.description, kMaxNodeDescriptionLength);
      over.noteLinks(c.links);
      if (c.opens) over.note("opens", c.opens->str(), kMaxIdLength);
      if (auto bad = over.sentence()) return bad;
      if (c.position && !(std::isfinite(c.position->x) && std::isfinite(c.position->y)))
        return "position is not finite";
      if (!graph.hasNode(c.id) && graph.presentNodeCount() >= kMaxNodes)
        return "tree is at node capacity (" + std::to_string(kMaxNodes) +
               " nodes) — delete a node before adding another";
      return std::nullopt;
    },
    [&](const AnnotateNode& c) -> std::optional<std::string> {
      if (auto bad = idBounds(c.id)) return bad;
      if (c.description && c.appendDescription)
        return "description and appendDescription are both set — pass one: description replaces "
               "the body, appendDescription joins onto it";
      Overages over;
      if (c.icon) over.note("icon", *c.icon, kMaxIconLength);
      if (c.description) over.note("description", *c.description, kMaxNodeDescriptionLength);
      if (c.appendDescription)
        over.note("description", appendedTo(graph.descriptionOf(c.id), *c.appendDescription),
                  kMaxNodeDescriptionLength);
      if (c.links) over.noteLinks(*c.links);
      if (c.opens) over.note("opens", c.opens->str(), kMaxIdLength);
      if (auto bad = over.sentence()) return bad;
      return present(c.id);
    },
    [&](const RenameNode& c) -> std::optional<std::string> {
      if (auto bad = idBounds(c.id)) return bad;
      Overages over;
      over.note("label", c.label, kMaxNodeLabelLength);
      if (auto bad = over.sentence()) return bad;
      return present(c.id);
    },
    [&](const RepositionNode& c) -> std::optional<std::string> {
      if (auto bad = idBounds(c.id)) return bad;
      if (!(std::isfinite(c.position.x) && std::isfinite(c.position.y))) return "position is not finite";
      return present(c.id);
    },
    [&](const SetNodeColor& c) -> std::optional<std::string> {
      if (auto bad = idBounds(c.id)) return bad;
      return present(c.id);
    },
    [&](const DeleteNode& c) -> std::optional<std::string> { return idBounds(c.id); },
    [&](const AddEdge& c) -> std::optional<std::string> {
      if (auto bad = idBounds(c.from)) return bad;
      if (auto bad = idBounds(c.to)) return bad;
      if (!graph.edgePresent(c.from, c.to) && graph.presentEdgeCount() >= kMaxEdges)
        return "tree is at edge capacity (" + std::to_string(kMaxEdges) +
               " edges) — call tidy to drop the edges a longer path already implies";
      return std::nullopt;
    },
    [&](const RemoveEdge& c) -> std::optional<std::string> {
      if (auto bad = idBounds(c.from)) return bad;
      return idBounds(c.to);
    },
    [&](const ReconnectEdge& c) -> std::optional<std::string> {
      if (auto bad = idBounds(c.oldFrom)) return bad;
      if (auto bad = idBounds(c.oldTo)) return bad;
      if (auto bad = idBounds(c.newFrom)) return bad;
      return idBounds(c.newTo);
    },
    [&](const RenameKind& c) -> std::optional<std::string> {
      if (!legend.has(c.id)) return "no kind " + quoted(c.id.str()) + " in this legend";
      Overages over;
      over.note("label", c.label, kMaxKindLabelLength);
      return over.sentence();
    },
    [&](const DescribeKind& c) -> std::optional<std::string> {
      if (!legend.has(c.id)) return "no kind " + quoted(c.id.str()) + " in this legend";
      Overages over;
      if (c.description) over.note("description", *c.description, kMaxKindDescriptionLength);
      return over.sentence();
    },
    [&](const AddKind& c) -> std::optional<std::string> {
      if (legend.has(c.id)) return "kind " + quoted(c.id.str()) + " already exists in this legend";
      if (legend.size() >= kMaxKinds)
        return "the legend is full (" + std::to_string(legend.size()) + " of " +
               std::to_string(kMaxKinds) + " kinds) — remove a kind before adding another";
      if (std::optional<KindId> owner = legend.ownerOf(c.hue))
        return "hue " + quoted(std::string(toString(c.hue))) + " already belongs to kind " +
               quoted(owner->str()) + " — a hue names one kind, so pick a free one";
      Overages over;
      over.note("label", c.label, kMaxKindLabelLength);
      over.note("description", c.description, kMaxKindDescriptionLength);
      return over.sentence();
    },
    [&](const RemoveKind& c) -> std::optional<std::string> {
      std::optional<NodeColor> hue = legend.hueOf(c.id);
      if (!hue) return "no kind " + quoted(c.id.str()) + " in this legend";
      if (!graph.hueInUse(*hue)) return std::nullopt;
      // Only the refusal pays for the count — how much repainting the removal is asking of the caller.
      return "kind " + quoted(c.id.str()) + " is in use — " +
             std::to_string(graph.nodesWithColor(*hue).size()) + " node(s) still wear hue " +
             quoted(std::string(toString(*hue))) + "; recolor them first";
    },
    [&](const RecolorKind& c) -> std::optional<std::string> {
      if (!legend.has(c.id)) return "no kind " + quoted(c.id.str()) + " in this legend";
      std::optional<KindId> owner = legend.ownerOf(c.hue);
      if (owner && *owner != c.id)
        return "hue " + quoted(std::string(toString(c.hue))) + " already belongs to kind " +
               quoted(owner->str()) + " — a hue names one kind, so pick a free one";
      return std::nullopt;
    },
    [&](const Batch& c) -> std::optional<std::string> {
      for (const Command& member : c.commands)
        if (std::optional<std::string> reason = validate(graph, legend, member)) return reason;
      return std::nullopt;
    },
    [&](const auto&) -> std::optional<std::string> { return std::nullopt; },
  }, command);
}

std::vector<NodeId> wearersOf(const LooseGraph& graph, const Legend& legend, const KindId& kind) {
  const std::optional<NodeColor> hue = legend.hueOf(kind);
  if (!hue) return {};
  return graph.nodesWithColor(*hue);
}

std::optional<Command> changedPart(const NodeSpec& node, const Command& command) {
  // A field the edit names lands when it holds another value on the node.
  const auto differs = [](const auto& sent, const auto& held) { return sent && *sent != held; };
  return std::visit(overloaded{
    [&](const RenameNode& c) -> std::optional<Command> {
      if (node.label == c.label) return std::nullopt;
      return c;
    },
    [&](const SetNodeColor& c) -> std::optional<Command> {
      if (node.color == c.color) return std::nullopt;
      return c;
    },
    [&](const RepositionNode& c) -> std::optional<Command> {
      if (node.position == std::optional<Vec2>(c.position)) return std::nullopt;
      return c;
    },
    [&](const AnnotateNode& c) -> std::optional<Command> {
      AnnotateNode landed{c.id};
      if (differs(c.description, node.description)) landed.description = c.description;
      if (c.appendDescription && appendedTo(node.description, *c.appendDescription) != node.description)
        landed.appendDescription = c.appendDescription;
      if (differs(c.icon, node.icon)) landed.icon = c.icon;
      if (differs(c.links, node.links)) landed.links = c.links;
      if (differs(c.opens, node.opens)) landed.opens = c.opens;
      if (!landed.description && !landed.appendDescription && !landed.icon && !landed.links && !landed.opens)
        return std::nullopt;
      return landed;
    },
    [&](const auto&) -> std::optional<Command> { return command; },
  }, command);
}

std::variant<NodePatchPlan, std::string, KindRefusal> planNodePatches(
    const LooseGraph& graph, const Legend& legend, const std::vector<NodePatch>& updates) {
  if (updates.empty() || updates.size() > kMaxPatchNodes)
    return "updates must contain 1 to " + std::to_string(kMaxPatchNodes) + " node patches";

  const std::vector<Kind> kinds = legend.kinds();
  NodePatchPlan plan;
  std::set<NodeId> seen;
  for (std::size_t row = 0; row < updates.size(); ++row) {
    const NodePatch& patch = updates[row];
    if (!seen.insert(patch.nodeId).second)
      return "updates repeats nodeId " + quoted(patch.nodeId.str());
    if (!patch.label && !patch.icon && !patch.description && !patch.hue.color && !patch.hue.kind && !patch.position &&
        !patch.links && !patch.opens)
      return "node " + quoted(patch.nodeId.str()) + ": pass at least one field to patch";
    for (const auto& [field, value] : {std::pair{"label", &patch.label}, {"icon", &patch.icon}, {"description", &patch.description}})
      if (*value && (*value)->find('\0') != std::string::npos)
        return "node " + quoted(patch.nodeId.str()) + ": " + field + " cannot contain a NUL character";
    if (patch.links)
      for (const Link& link : *patch.links)
        if (link.label.find('\0') != std::string::npos || link.url.find('\0') != std::string::npos)
          return "node " + quoted(patch.nodeId.str()) + ": links cannot contain a NUL character";
    if (patch.opens && patch.opens->str().find('\0') != std::string::npos)
      return "node " + quoted(patch.nodeId.str()) + ": opens cannot contain a NUL character";
    const std::optional<NodeSpec> node = graph.nodeView(patch.nodeId);
    if (!node) return "no node in this tree is named " + quoted(patch.nodeId.str());
    const auto hue =
        resolveHue(kinds, patch.hue, graph.exportNode(patch.nodeId), "updates[" + std::to_string(row) + "].");
    if (const auto* refusal = std::get_if<KindRefusal>(&hue)) return *refusal;
    const std::optional<NodeColor> color = std::get<std::optional<NodeColor>>(hue);
    std::optional<std::vector<Link>> links;
    if (patch.links) {
      auto shown = shownLinks(node->links, *patch.links, "updates[" + std::to_string(row) + "].links");
      if (const auto* refusal = std::get_if<std::string>(&shown)) return *refusal;
      links = std::get<std::vector<Link>>(std::move(shown));
    }

    std::vector<Command> candidates;
    if (patch.label) candidates.push_back(RenameNode{patch.nodeId, *patch.label});
    if (color) candidates.push_back(SetNodeColor{patch.nodeId, *color});
    if (patch.position) candidates.push_back(RepositionNode{patch.nodeId, *patch.position});
    if (patch.description || patch.icon || links || patch.opens)
      candidates.push_back(AnnotateNode{patch.nodeId, patch.description, links, patch.icon, std::nullopt, patch.opens});

    const std::size_t before = plan.batch.commands.size();
    for (const Command& command : candidates) {
      if (std::optional<std::string> reason = validate(graph, legend, command)) return *reason;
      if (std::optional<Command> landed = changedPart(*node, command)) plan.batch.commands.push_back(*landed);
    }
    if (plan.batch.commands.size() != before) plan.changedNodeIds.push_back(patch.nodeId);
  }
  return plan;
}

std::optional<std::string> shownLinkUrl(std::string_view url) {
  constexpr std::string_view kAsciiWhitespace = " \t\n\f\r";
  const std::size_t first = url.find_first_not_of(kAsciiWhitespace);
  if (first == std::string_view::npos) return std::nullopt;
  const std::string_view trimmed = url.substr(first, url.find_last_not_of(kAsciiWhitespace) - first + 1);
  const auto startsWith = [&](std::string_view scheme) {
    return trimmed.size() >= scheme.size() &&
           std::equal(scheme.begin(), scheme.end(), trimmed.begin(),
                      [](char lower, char sent) { return lower == std::tolower(static_cast<unsigned char>(sent)); });
  };
  if (!startsWith("http:") && !startsWith("https:") && !startsWith("mailto:")) return std::nullopt;
  return std::string(trimmed);
}

std::variant<std::vector<Link>, std::string> shownLinks(const std::vector<Link>& held, std::vector<Link> sent,
                                                        const std::string& path) {
  for (std::size_t i = 0; i < sent.size(); ++i) {
    const auto heldAsSent = [&](const Link& kept) { return kept.url == sent[i].url; };
    if (std::any_of(held.begin(), held.end(), heldAsSent)) continue;
    std::optional<std::string> url = shownLinkUrl(sent[i].url);
    if (!url)
      return path + "[" + std::to_string(i) + "].url must start with http:, https: or mailto:, the links a person "
                    "can open";
    sent[i].url = std::move(*url);
  }
  return sent;
}

std::variant<std::vector<Link>, std::string> withLinksAdded(const std::vector<Link>& held,
                                                            const std::vector<Link>& added, const std::string& path) {
  const auto shown = shownLinks(held, added, path);
  if (const auto* refusal = std::get_if<std::string>(&shown)) return *refusal;
  // A url the rule takes is named by its trimmed form; one it refuses, only as it stands.
  const auto identity = [](const std::string& url) { return shownLinkUrl(url).value_or(url); };
  const std::vector<Link>& links = std::get<std::vector<Link>>(shown);
  std::vector<Link> joined = held;
  std::map<std::string, std::size_t> sentAt;
  for (std::size_t i = 0; i < links.size(); ++i) {
    const Link& link = links[i];
    const auto [first, fresh] = sentAt.emplace(identity(link.url), i);
    if (!fresh)
      return path + "[" + std::to_string(i) + "].url repeats " + path + "[" + std::to_string(first->second) +
             "].url — send each link once";
    // A url sent as held names that link; any other names the held link that trims to it.
    auto same = std::find_if(joined.begin(), joined.end(), [&](const Link& kept) { return kept.url == link.url; });
    if (same == joined.end())
      same = std::find_if(joined.begin(), joined.end(),
                          [&](const Link& kept) { return identity(kept.url) == identity(link.url); });
    if (same == joined.end()) {
      joined.push_back(link);
      continue;
    }
    same->url = link.url;
    if (!link.label.empty()) same->label = link.label;
  }
  if (joined.size() > kMaxNodeLinks)
    return "links would hold " + std::to_string(joined.size()) + " links, " +
           std::to_string(joined.size() - kMaxNodeLinks) + " over the " + std::to_string(kMaxNodeLinks) + " cap";
  return joined;
}

std::variant<KindUpdatePlan, std::string> planKindUpdate(const LooseGraph& graph, const Legend& legend,
                                                         const KindUpdate& update) {
  std::vector<Command> sent;
  if (update.label) sent.push_back(RenameKind{update.id, *update.label});
  if (update.description) sent.push_back(DescribeKind{update.id, update.description, std::nullopt});
  if (update.hue) sent.push_back(RecolorKind{update.id, *update.hue});
  if (sent.empty()) return "nothing to set — pass at least one of \"label\", \"description\", \"hue\".";
  for (const Command& command : sent)
    if (std::optional<std::string> reason = validate(graph, legend, command)) return *reason;

  const Kind held = *legend.view(update.id);
  KindUpdatePlan plan;
  if (update.label && *update.label != held.label) plan.commands.push_back(RenameKind{update.id, *update.label});
  if (update.description && *update.description != held.description)
    plan.commands.push_back(DescribeKind{update.id, update.description, std::nullopt});
  if (update.hue && *update.hue != held.hue) {
    plan.commands.push_back(RecolorKind{update.id, *update.hue});
    plan.repaintedNodes = wearersOf(graph, legend, update.id).size();
  }
  return plan;
}

std::variant<EdgeChangePlan, std::string> planEdgeChanges(
    const LooseGraph& graph, const EdgeChanges& changes) {
  const std::size_t count = changes.add.size() + changes.remove.size();
  if (count == 0 || count > kMaxChangeEdges)
    return "add and remove must contain 1 to " + std::to_string(kMaxChangeEdges) + " edges in total";

  EdgeChangePlan plan;
  std::set<Edge> seen;
  for (const Edge& edge : changes.remove) {
    if (std::optional<std::string> reason = edgeEndpointBounds(edge)) return *reason;
    if (!seen.insert(edge).second)
      return "remove repeats edge " + quoted(edge.from.str()) + " -> " + quoted(edge.to.str());
    if (!graph.edgePresent(edge.from, edge.to)) continue;
    plan.removed.push_back(edge);
    plan.batch.commands.push_back(RemoveEdge{edge.from, edge.to});
  }
  for (const Edge& edge : changes.add) {
    if (std::optional<std::string> reason = edgeEndpointBounds(edge)) return *reason;
    if (!seen.insert(edge).second)
      return "add repeats edge or overlaps remove: " + quoted(edge.from.str()) + " -> " + quoted(edge.to.str());
    for (const NodeId& endpoint : {edge.from, edge.to})
      if (!graph.hasNode(endpoint)) return "no node in this tree is named " + quoted(endpoint.str());
    if (graph.edgePresent(edge.from, edge.to)) continue;
    plan.added.push_back(edge);
    plan.batch.commands.push_back(AddEdge{edge.from, edge.to});
  }

  const std::size_t before = graph.presentEdgeCount();
  const std::size_t after = before - plan.removed.size() + plan.added.size();
  if (std::optional<Admission> refusal = growthWithin(0, 0, before, after)) return refusal->reason;
  return plan;
}

namespace {
std::optional<Admission> admitRegister(const std::string& field, const std::string& text, std::size_t cap) {
  Overages over;
  over.note(field, text, cap);
  if (std::optional<std::string> bad = over.sentence()) return Admission{Admission::Verdict::malformed, *bad};
  return std::nullopt;
}
}

std::optional<Admission> admitTitle(const std::string& title) {
  return admitRegister("the title", title, kMaxTitleChars);
}

std::optional<Admission> admitGuide(const std::string& guide) {
  return admitRegister("the guide", guide, kMaxGuideChars);
}

bool isBlankGuide(const std::string& guide) {
  return guide.find_first_not_of(" \t\r\n") == std::string::npos;
}

std::optional<Admission> admitStampedGuide(const std::string& guide) {
  if (std::optional<Admission> refusal = admitGuide(guide)) return refusal;
  if (guide.empty() || !isBlankGuide(guide)) return std::nullopt;
  return Admission{Admission::Verdict::malformed, "the guide is only whitespace — send \"\" for no guide"};
}

std::optional<Admission> admit(const TreeData& document) {
  if (std::optional<Admission> refusal = admitTitle(document.title)) return refusal;
  // A document's kinds REPLACE the legend rather than joining it, so the count is the list's length.
  if (document.kinds.size() > kMaxKinds)
    return Admission{Admission::Verdict::tooLarge,
                     "this legend would hold " + std::to_string(document.kinds.size()) +
                         " kinds, max " + std::to_string(kMaxKinds) + " — remove a kind before adding another"};
  for (const Kind& kind : document.kinds)
    if (std::optional<std::string> bad = kindFieldBounds(kind.id, kind.label, kind.description))
      return Admission{Admission::Verdict::malformed, *bad};
  // A posted document is judged as a graft into an empty tree; the tree it lands on is judged
  // separately by the caller holding that graph. A save grows a lattice rather than replacing it.
  return admit(LooseGraph{}, document);
}

std::optional<Admission> admit(const LooseGraph& graph, const Graft& incoming) {
  // The ids and edges the batch would ADD, as sets: a document may name the same id — or the same
  // prerequisite — many times, and each must count once. What the graft removes is subtracted, so
  // a rebuild that tombstones as much as it plants is judged on what it leaves behind.
  std::set<NodeId> arrivingNodes;
  std::set<Edge> arrivingEdges;
  for (const NodeSpec& node : incoming.document.nodes) {
    if (std::optional<std::string> bad =
            nodeFieldBounds(node.id, node.label, node.icon, node.description, node.links, node.opens, node.position))
      return Admission{Admission::Verdict::malformed, *bad};
    if (!graph.hasNode(node.id)) arrivingNodes.insert(node.id);  // a graft upserts: a present id costs nothing
    for (const NodeId& prereq : node.prerequisites)
      if (!graph.edgePresent(prereq, node.id)) arrivingEdges.insert(Edge{prereq, node.id});
  }
  const GraftFootprint footprint = footprintOf(graph, incoming);
  const std::size_t nodesBefore = graph.presentNodeCount();
  const std::size_t edgesBefore = graph.presentEdgeCount();
  const std::size_t leavingEdges = footprint.replacedEdges.size() + footprint.tombstonedEdges.size();
  return growthWithin(nodesBefore, nodesBefore + arrivingNodes.size() - footprint.tombstonedNodes.size(),
                      edgesBefore, edgesBefore + arrivingEdges.size() - leavingEdges);
}

std::optional<Admission> admit(const LooseGraph& graph, const TreeData& incoming) {
  return admit(graph, Graft{incoming});
}

std::optional<Admission> admit(const LooseGraph& graph, const GraphState& incoming) {
  // Run the element-set join itself rather than trusting each entry's stamps: an estimate lets a
  // losing tombstone or a repeated id subtract from a count it never lowered.
  std::map<NodeId, ElementSet> nodeLives;
  for (const NodeStateEntry& node : incoming.nodes) {
    if (std::optional<std::string> bad =
            nodeFieldBounds(node.id, node.label, node.icon, node.description, node.links, node.opens, node.position))
      return Admission{Admission::Verdict::malformed, *bad};
    auto [life, fresh] = nodeLives.try_emplace(node.id);
    if (fresh) life->second = graph.lifeOf(node.id).value_or(ElementSet{});
    life->second.add(node.createdAt);
    life->second.remove(node.deletedAt);
  }
  std::map<Edge, ElementSet> edgeLives;
  for (const EdgeStateEntry& edge : incoming.edges) {
    if (std::optional<std::string> bad = edgeEndpointBounds(edge.edge))
      return Admission{Admission::Verdict::malformed, *bad};
    auto [life, fresh] = edgeLives.try_emplace(edge.edge);
    if (fresh) life->second = graph.lifeOf(edge.edge).value_or(ElementSet{});
    life->second.add(edge.addedAt);
    life->second.remove(edge.removedAt);
  }

  // One key moves the count by at most one, in the direction the merge decided.
  std::size_t nodes = graph.presentNodeCount();
  for (const auto& [id, life] : nodeLives) {
    if (life.present() && !graph.hasNode(id)) ++nodes;
    else if (!life.present() && graph.hasNode(id)) --nodes;
  }
  std::size_t edges = graph.presentEdgeCount();
  for (const auto& [edge, life] : edgeLives) {
    if (life.present() && !graph.edgePresent(edge.from, edge.to)) ++edges;
    else if (!life.present() && graph.edgePresent(edge.from, edge.to)) --edges;
  }
  return growthWithin(graph.presentNodeCount(), nodes, graph.presentEdgeCount(), edges);
}

std::optional<Admission> admit(const Legend& legend, const LegendState& incoming) {
  // The legend rides the same frame the graph does: same element-set join, same growth rule.
  std::map<KindId, ElementSet> lives;
  std::size_t before = 0;
  for (const KindStateEntry& kind : legend.exportState().kinds) {
    ElementSet life{kind.createdAt, kind.deletedAt};
    if (life.present()) ++before;
    lives.emplace(kind.id, life);
  }
  for (const KindStateEntry& kind : incoming.kinds) {
    if (std::optional<std::string> bad = kindFieldBounds(kind.id, kind.label, kind.description))
      return Admission{Admission::Verdict::malformed, *bad};
    ElementSet& life = lives[kind.id];  // seeded above from the legend; default for a new id
    life.add(kind.createdAt);
    life.remove(kind.deletedAt);
  }

  std::size_t after = 0;
  for (const auto& [id, life] : lives) if (life.present()) ++after;
  if (after > kMaxKinds && after > before)
    return Admission{Admission::Verdict::tooLarge,
                     "this legend would hold " + std::to_string(after) + " kinds, max " +
                         std::to_string(kMaxKinds) + " — remove a kind before adding another"};
  return std::nullopt;
}

std::optional<Command> headline(const GraphState& graph, const LegendState& legend) {
  for (const NodeStateEntry& n : graph.nodes)
    if (n.createdAt.isSet()) return CreateNode{n.id, n.label, n.icon, n.color, {}, n.position, n.description, n.links};
  for (const NodeStateEntry& n : graph.nodes)
    if (n.deletedAt.isSet()) return DeleteNode{n.id};
  for (const KindStateEntry& k : legend.kinds)
    if (k.createdAt.isSet()) return AddKind{k.id, k.hue};
  for (const KindStateEntry& k : legend.kinds)
    if (k.hueAt.isSet()) return RecolorKind{k.id, k.hue};
  for (const KindStateEntry& k : legend.kinds)
    if (k.labelAt.isSet()) return RenameKind{k.id, k.label};
  for (const KindStateEntry& k : legend.kinds)
    if (k.descriptionAt.isSet()) return DescribeKind{k.id, k.description, std::nullopt};
  for (const KindStateEntry& k : legend.kinds)
    if (k.crossBranchExemptAt.isSet()) return DescribeKind{k.id, std::nullopt, k.crossBranchExempt};
  for (const KindStateEntry& k : legend.kinds)
    if (k.rankAt.isSet()) return ReorderKinds{};
  for (const NodeStateEntry& n : graph.nodes)
    if (n.labelAt.isSet()) return RenameNode{n.id, n.label};
  for (const NodeStateEntry& n : graph.nodes)
    if (n.colorAt.isSet()) return SetNodeColor{n.id, n.color};
  for (const NodeStateEntry& n : graph.nodes)
    if (n.descriptionAt.isSet() || n.linksAt.isSet())
      return AnnotateNode{n.id,
                          n.descriptionAt.isSet() ? std::optional<std::string>(n.description) : std::nullopt,
                          n.linksAt.isSet() ? std::optional<std::vector<Link>>(n.links) : std::nullopt};
  for (const EdgeStateEntry& e : graph.edges)
    if (e.addedAt.isSet()) return AddEdge{e.edge.from, e.edge.to};
  for (const EdgeStateEntry& e : graph.edges)
    if (e.removedAt.isSet()) return RemoveEdge{e.edge.from, e.edge.to};
  return std::nullopt;
}

}

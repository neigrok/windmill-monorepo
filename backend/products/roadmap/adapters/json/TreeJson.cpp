#include "products/roadmap/adapters/json/TreeJson.h"

#include <memory>
#include <sstream>

namespace wm {

namespace {
Json::Value edgeJson(const Edge& edge) {
  Json::Value value(Json::objectValue);
  value["from"] = edge.from.str();
  value["to"] = edge.to.str();
  return value;
}

// The stamp codec is shared with the op log and the subgraph wire (domain/Ids.h): the
// document and the wire speak one stamp format.
std::string hlcText(const Hlc& at) { return toString(at); }
Hlc hlcFromText(const std::string& text) { return parseHlc(text); }
}

Json::Value linksToJson(const std::vector<Link>& links) {
  Json::Value array(Json::arrayValue);
  for (const Link& link : links) {
    Json::Value value(Json::objectValue);
    value["url"] = link.url;
    if (!link.label.empty()) value["label"] = link.label;
    array.append(value);
  }
  return array;
}

std::vector<Link> linksFromJson(const Json::Value& array) {
  std::vector<Link> links;
  if (!array.isArray()) return links;
  for (const Json::Value& value : array) {
    if (value.isString()) { links.push_back(Link{"", value.asString()}); continue; }
    if (!value.isObject()) continue;
    // Each leaf read only once it IS a string: asString() on a number throws, and that throw used
    // to escape the handler as a 500 rather than being answered as the malformed input it is.
    Link link;
    if (value["label"].isString()) link.label = value["label"].asString();
    if (value["url"].isString()) link.url = value["url"].asString();
    links.push_back(std::move(link));
  }
  return links;
}

Json::Value nodeToJson(const NodeSpec& node) {
  Json::Value n(Json::objectValue);
  n["id"] = node.id.str();
  n["label"] = node.label;
  n["icon"] = node.icon;
  n["color"] = std::string(toString(node.color));
  if (!node.order.empty()) n["order"] = node.order;

  Json::Value prerequisites(Json::arrayValue);
  for (const NodeId& prereq : node.prerequisites) prerequisites.append(prereq.str());
  n["prerequisites"] = prerequisites;

  if (node.position) {
    Json::Value position(Json::objectValue);
    position["x"] = node.position->x;
    position["y"] = node.position->y;
    n["position"] = position;
  }
  if (node.status) n["status"] = *node.status;
  if (!node.description.empty()) n["description"] = node.description;
  if (!node.links.empty()) n["links"] = linksToJson(node.links);
  return n;
}

Json::Value toJson(const TreeData& data) {
  Json::Value root(Json::objectValue);
  root["id"] = data.id.str();
  root["title"] = data.title;

  Json::Value nodes(Json::arrayValue);
  for (const NodeSpec& node : data.nodes) nodes.append(nodeToJson(node));
  root["nodes"] = nodes;

  Json::Value kinds(Json::arrayValue);
  for (const Kind& kind : data.kinds) {
    Json::Value k(Json::objectValue);
    k["id"] = kind.id.str();
    k["hue"] = std::string(toString(kind.hue));
    k["label"] = kind.label;
    k["description"] = kind.description;
    kinds.append(k);
  }
  root["kinds"] = kinds;
  return root;
}

Json::Value toJson(const TreeSummary& summary) {
  Json::Value row(Json::objectValue);
  row["id"] = summary.id.str();
  row["title"] = summary.title;
  row["total"] = summary.stats.total;
  row["done"] = summary.stats.done;
  row["createdAt"] = static_cast<Json::Int64>(summary.createdAt);
  row["updatedAt"] = static_cast<Json::Int64>(summary.updatedAt);
  if (summary.stats.dominantKind) row["dominantKind"] = std::string(toString(*summary.stats.dominantKind));
  return row;
}

Json::Value toJson(const GalleryEntry& entry) {
  Json::Value row(Json::objectValue);
  // A gallery card is a registry row plus what the wall knows: the forks it inspired, the tree
  // it came from, and the two facts about its reader — spelled the same as GET /v1/trees so one
  // card component paints both surfaces.
  row["id"] = entry.id.str();
  row["title"] = entry.title;
  row["total"] = entry.stats.total;
  row["done"] = entry.stats.done;
  row["updatedAt"] = static_cast<Json::Int64>(entry.updatedAt);
  if (entry.stats.dominantKind) row["dominantKind"] = std::string(toString(*entry.stats.dominantKind));
  row["forks"] = entry.forks;
  // Always spelled, never inferred: a card that must say "Listed by you" or refuse a second fork
  // reads a boolean, and an absent key would leave it guessing.
  row["mine"] = entry.mine;
  row["forked"] = entry.forked;
  // Present only when this tree is a fork whose source may still be named — an unlisted, private
  // or deleted source leaves the key off entirely rather than naming an empty tree.
  if (!entry.sourceTitle.empty()) row["sourceTitle"] = entry.sourceTitle;
  return row;
}

// The overlay as a lattice frame: one stamped register per node, which is everything a
// replica needs to join it (GRAPH_SYNC_DESIGN.md §12). The three id sets are NOT sent — a
// reader derives them from the statuses, and shipping both would be two spellings of one
// fact on the wire. `none` rides along like any other value: it is a cleared register, and
// the client needs it to converge, not a tombstone list beside the data.
Json::Value toJson(const Progress& progress) {
  Json::Value marks(Json::arrayValue);
  for (const auto& [id, mark] : progress.marks) {
    Json::Value row(Json::objectValue);
    row["node"] = id.str();
    row["status"] = progressStatusName(mark.status);
    row["at"] = toString(mark.at);
    row["markedAt"] = Json::UInt64{mark.markedAt};
    marks.append(row);
  }
  Json::Value root(Json::objectValue);
  root["marks"] = marks;
  return root;
}

Json::Value toJson(const TreeDiagnostics& diagnostics) {
  Json::Value root(Json::objectValue);

  Json::Value cycles(Json::arrayValue);
  for (const Cycle& cycle : diagnostics.cycles) {
    Json::Value members(Json::arrayValue);
    for (const NodeId& id : cycle.members) members.append(id.str());
    cycles.append(members);
  }
  root["cycles"] = cycles;

  Json::Value dangling(Json::arrayValue);
  for (const Edge& edge : diagnostics.dangling) dangling.append(edgeJson(edge));
  root["dangling"] = dangling;

  Json::Value selfEdges(Json::arrayValue);
  for (const Edge& edge : diagnostics.selfEdges) selfEdges.append(edgeJson(edge));
  root["selfEdges"] = selfEdges;

  Json::Value smells(Json::arrayValue);
  for (const Smell& smell : diagnostics.smells) {
    Json::Value value(Json::objectValue);
    value["node"] = smell.node.str();
    value["kind"] = smell.kind;
    smells.append(value);
  }
  root["smells"] = smells;

  Json::Value maskedWork(Json::arrayValue);
  for (const NodeId& node : diagnostics.maskedWork) maskedWork.append(node.str());
  root["maskedWork"] = maskedWork;

  return root;
}

std::optional<TreeData> treeFromJson(const Json::Value& root, const TreeId& id) {
  // Every read below goes through these: a field that is absent or null takes its default, a
  // field of the wrong type refuses the whole document. Reading it any other way is what turned
  // {"nodes":[1]} into an uncaught Json::LogicError and a 500.
  auto text = [](const Json::Value& value, std::string& out) {
    if (value.isNull()) return true;
    if (!value.isString()) return false;
    out = value.asString();
    return true;
  };
  auto number = [](const Json::Value& value, double& out) {
    if (value.isNull()) return true;
    if (!value.isNumeric()) return false;
    out = value.asDouble();
    return true;
  };
  auto list = [](const Json::Value& value) { return value.isNull() || value.isArray(); };
  // linksFromJson is deliberately lenient (it is shared with the command decoder and must never
  // throw), so the document path states the strictness itself rather than letting a numeric url
  // land as an empty one.
  auto links = [](const Json::Value& value) {
    if (!value.isArray()) return false;
    for (const Json::Value& link : value) {
      if (link.isString()) continue;
      if (!link.isObject()) return false;
      if (!link["url"].isNull() && !link["url"].isString()) return false;
      if (!link["label"].isNull() && !link["label"].isString()) return false;
    }
    return true;
  };

  if (!root.isObject()) return std::nullopt;  // a keyed read of an array or a scalar throws

  TreeData data;
  data.id = id;
  if (!text(root["title"], data.title)) return std::nullopt;

  if (!list(root["nodes"])) return std::nullopt;
  for (const Json::Value& n : root["nodes"]) {
    if (!n.isObject()) return std::nullopt;
    NodeSpec node;
    std::string nodeId, color = "terracotta", status;
    if (!text(n["id"], nodeId) || !text(n["label"], node.label) || !text(n["icon"], node.icon) ||
        !text(n["color"], color) || !text(n["order"], node.order) ||
        !text(n["description"], node.description))
      return std::nullopt;
    node.id = NodeId{nodeId};
    node.color = parseColor(color).value_or(NodeColor::terracotta);
    if (!list(n["prerequisites"])) return std::nullopt;
    for (const Json::Value& prereq : n["prerequisites"]) {
      std::string prereqId;
      if (!text(prereq, prereqId)) return std::nullopt;
      node.prerequisites.push_back(NodeId{prereqId});
    }
    if (n.isMember("position") && !n["position"].isNull()) {
      if (!n["position"].isObject()) return std::nullopt;
      Vec2 position;
      if (!number(n["position"]["x"], position.x) || !number(n["position"]["y"], position.y))
        return std::nullopt;
      node.position = position;
    }
    if (n.isMember("status") && n["status"].isString()) node.status = n["status"].asString();
    if (n.isMember("links") && !n["links"].isNull()) {
      if (!links(n["links"])) return std::nullopt;
      node.links = linksFromJson(n["links"]);
    }
    data.nodes.push_back(std::move(node));
  }

  if (!list(root["kinds"])) return std::nullopt;
  for (const Json::Value& k : root["kinds"]) {
    if (!k.isObject()) return std::nullopt;
    Kind kind;
    std::string kindId, hue = "terracotta";
    if (!text(k["id"], kindId) || !text(k["hue"], hue) || !text(k["label"], kind.label) ||
        !text(k["description"], kind.description))
      return std::nullopt;
    kind.id = KindId{kindId};
    kind.hue = parseColor(hue).value_or(NodeColor::terracotta);
    data.kinds.push_back(std::move(kind));
  }
  return data;
}

Json::Value toJson(const GraphState& state) {
  Json::Value root(Json::objectValue);
  Json::Value nodes(Json::arrayValue);
  for (const NodeStateEntry& node : state.nodes) {
    Json::Value n(Json::objectValue);
    n["id"] = node.id.str();
    n["createdAt"] = hlcText(node.createdAt);
    n["deletedAt"] = hlcText(node.deletedAt);
    n["label"] = node.label;
    n["labelAt"] = hlcText(node.labelAt);
    n["icon"] = node.icon;
    n["iconAt"] = hlcText(node.iconAt);
    n["color"] = std::string(toString(node.color));
    n["colorAt"] = hlcText(node.colorAt);
    n["order"] = node.order;
    n["orderAt"] = hlcText(node.orderAt);
    if (node.position) {
      Json::Value position(Json::objectValue);
      position["x"] = node.position->x;
      position["y"] = node.position->y;
      n["position"] = position;
    }
    n["positionAt"] = hlcText(node.positionAt);
    if (node.status) n["status"] = *node.status;
    n["statusAt"] = hlcText(node.statusAt);
    n["description"] = node.description;
    n["descriptionAt"] = hlcText(node.descriptionAt);
    n["links"] = linksToJson(node.links);
    n["linksAt"] = hlcText(node.linksAt);
    nodes.append(n);
  }
  root["nodes"] = nodes;

  Json::Value edges(Json::arrayValue);
  for (const EdgeStateEntry& edge : state.edges) {
    Json::Value e = edgeJson(edge.edge);
    e["addedAt"] = hlcText(edge.addedAt);
    e["removedAt"] = hlcText(edge.removedAt);
    edges.append(e);
  }
  root["edges"] = edges;
  return root;
}

GraphState graphStateFromJson(const Json::Value& root) {
  GraphState state;
  for (const Json::Value& n : root["nodes"]) {
    NodeStateEntry node;
    node.id = NodeId{n["id"].asString()};
    node.createdAt = hlcFromText(n.get("createdAt", "").asString());
    node.deletedAt = hlcFromText(n.get("deletedAt", "").asString());
    node.label = n.get("label", "").asString();
    node.labelAt = hlcFromText(n.get("labelAt", "").asString());
    node.icon = n.get("icon", "").asString();
    node.iconAt = hlcFromText(n.get("iconAt", "").asString());
    node.color = parseColor(n.get("color", "terracotta").asString()).value_or(NodeColor::terracotta);
    node.colorAt = hlcFromText(n.get("colorAt", "").asString());
    node.order = n.get("order", "").asString();
    node.orderAt = hlcFromText(n.get("orderAt", "").asString());
    if (n.isMember("position") && n["position"].isObject()) {
      Vec2 position;
      position.x = n["position"].get("x", 0.0).asDouble();
      position.y = n["position"].get("y", 0.0).asDouble();
      node.position = position;
    }
    node.positionAt = hlcFromText(n.get("positionAt", "").asString());
    if (n.isMember("status") && n["status"].isString()) node.status = n["status"].asString();
    node.statusAt = hlcFromText(n.get("statusAt", "").asString());
    node.description = n.get("description", "").asString();
    node.descriptionAt = hlcFromText(n.get("descriptionAt", "").asString());
    if (n.isMember("links")) node.links = linksFromJson(n["links"]);
    node.linksAt = hlcFromText(n.get("linksAt", "").asString());
    state.nodes.push_back(std::move(node));
  }
  for (const Json::Value& e : root["edges"]) {
    EdgeStateEntry edge;
    edge.edge = Edge{NodeId{e["from"].asString()}, NodeId{e["to"].asString()}};
    edge.addedAt = hlcFromText(e.get("addedAt", "").asString());
    edge.removedAt = hlcFromText(e.get("removedAt", "").asString());
    state.edges.push_back(std::move(edge));
  }
  return state;
}

Json::Value toJson(const LegendState& legend) {
  Json::Value kinds(Json::arrayValue);
  for (const KindStateEntry& kind : legend.kinds) {
    Json::Value k(Json::objectValue);
    k["id"] = kind.id.str();
    k["createdAt"] = hlcText(kind.createdAt);
    k["deletedAt"] = hlcText(kind.deletedAt);
    k["hue"] = std::string(toString(kind.hue));
    k["hueAt"] = hlcText(kind.hueAt);
    k["label"] = kind.label;
    k["labelAt"] = hlcText(kind.labelAt);
    k["description"] = kind.description;
    k["descriptionAt"] = hlcText(kind.descriptionAt);
    k["rank"] = kind.rank;
    k["rankAt"] = hlcText(kind.rankAt);
    kinds.append(k);
  }
  return kinds;
}

LegendState legendStateFromJson(const Json::Value& kinds) {
  LegendState state;
  for (const Json::Value& k : kinds) {
    KindStateEntry kind;
    kind.id = KindId{k["id"].asString()};
    kind.createdAt = hlcFromText(k.get("createdAt", "").asString());
    kind.deletedAt = hlcFromText(k.get("deletedAt", "").asString());
    kind.hue = parseColor(k.get("hue", "terracotta").asString()).value_or(NodeColor::terracotta);
    kind.hueAt = hlcFromText(k.get("hueAt", "").asString());
    kind.label = k.get("label", "").asString();
    kind.labelAt = hlcFromText(k.get("labelAt", "").asString());
    kind.description = k.get("description", "").asString();
    kind.descriptionAt = hlcFromText(k.get("descriptionAt", "").asString());
    kind.rank = k.get("rank", 0.0).asDouble();
    kind.rankAt = hlcFromText(k.get("rankAt", "").asString());
    state.kinds.push_back(std::move(kind));
  }
  return state;
}

}

#include "adapters/json/TreeJson.h"

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

std::string hlcText(const Hlc& at) {
  return std::to_string(at.physicalMs) + ":" + std::to_string(at.counter) + ":" + at.actor;
}

Hlc hlcFromText(const std::string& text) {
  Hlc hlc;
  auto first = text.find(':');
  auto second = text.find(':', first + 1);
  if (first == std::string::npos || second == std::string::npos) return hlc;
  hlc.physicalMs = std::stoull(text.substr(0, first));
  hlc.counter = static_cast<std::uint32_t>(std::stoul(text.substr(first + 1, second - first - 1)));
  hlc.actor = text.substr(second + 1);
  return hlc;
}
}

Json::Value toJson(const TreeData& data) {
  Json::Value root(Json::objectValue);
  root["id"] = data.id.str();
  root["title"] = data.title;

  Json::Value nodes(Json::arrayValue);
  for (const NodeSpec& node : data.nodes) {
    Json::Value n(Json::objectValue);
    n["id"] = node.id.str();
    n["label"] = node.label;
    n["icon"] = node.icon;
    n["color"] = std::string(toString(node.color));

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
    nodes.append(n);
  }
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

Json::Value toJson(const Progress& progress) {
  Json::Value root(Json::objectValue);
  Json::Value completed(Json::arrayValue);
  for (const NodeId& id : progress.completed) completed.append(id.str());
  Json::Value inProgress(Json::arrayValue);
  for (const NodeId& id : progress.inProgress) inProgress.append(id.str());
  root["completed"] = completed;
  root["inProgress"] = inProgress;
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

  return root;
}

TreeData treeFromJson(const Json::Value& root, const TreeId& id) {
  TreeData data;
  data.id = id;
  data.title = root.get("title", "").asString();

  for (const Json::Value& n : root["nodes"]) {
    NodeSpec node;
    node.id = NodeId{n["id"].asString()};
    node.label = n.get("label", "").asString();
    node.icon = n.get("icon", "").asString();
    node.color = parseColor(n.get("color", "terracotta").asString()).value_or(NodeColor::terracotta);
    for (const Json::Value& prereq : n["prerequisites"]) node.prerequisites.push_back(NodeId{prereq.asString()});
    if (n.isMember("position") && n["position"].isObject()) {
      Vec2 position;
      position.x = n["position"].get("x", 0.0).asDouble();
      position.y = n["position"].get("y", 0.0).asDouble();
      node.position = position;
    }
    if (n.isMember("status") && n["status"].isString()) node.status = n["status"].asString();
    data.nodes.push_back(std::move(node));
  }

  for (const Json::Value& k : root["kinds"]) {
    Kind kind;
    kind.id = KindId{k["id"].asString()};
    kind.hue = parseColor(k.get("hue", "terracotta").asString()).value_or(NodeColor::terracotta);
    kind.label = k.get("label", "").asString();
    kind.description = k.get("description", "").asString();
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
    if (node.position) {
      Json::Value position(Json::objectValue);
      position["x"] = node.position->x;
      position["y"] = node.position->y;
      n["position"] = position;
    }
    n["positionAt"] = hlcText(node.positionAt);
    if (node.status) n["status"] = *node.status;
    n["statusAt"] = hlcText(node.statusAt);
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
    if (n.isMember("position") && n["position"].isObject()) {
      Vec2 position;
      position.x = n["position"].get("x", 0.0).asDouble();
      position.y = n["position"].get("y", 0.0).asDouble();
      node.position = position;
    }
    node.positionAt = hlcFromText(n.get("positionAt", "").asString());
    if (n.isMember("status") && n["status"].isString()) node.status = n["status"].asString();
    node.statusAt = hlcFromText(n.get("statusAt", "").asString());
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

std::string dump(const Json::Value& value) {
  Json::StreamWriterBuilder builder;
  builder["indentation"] = "";
  return Json::writeString(builder, value);
}

Json::Value parse(const std::string& text) {
  Json::Value root;
  Json::CharReaderBuilder builder;
  std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  std::string errors;
  // jsoncpp throws (not just returns false) once nesting passes its stack limit, so an
  // over-nested payload would otherwise escape every caller. Swallow it to a null value —
  // callers already treat a non-object frame as "ignore".
  try {
    reader->parse(text.c_str(), text.c_str() + text.size(), &root, &errors);
  } catch (const std::exception&) {
    return Json::Value(Json::nullValue);
  }
  return root;
}

}

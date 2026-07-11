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
  return data;
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
  reader->parse(text.c_str(), text.c_str() + text.size(), &root, &errors);
  return root;
}

}

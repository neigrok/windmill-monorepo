#include "products/roadmap/adapters/json/CommandJson.h"

#include "products/roadmap/adapters/json/TreeJson.h"
#include "products/roadmap/domain/Tree.h"

namespace wm {

namespace {
template <class... Ts>
struct overloaded : Ts... { using Ts::operator()...; };
template <class... Ts>
overloaded(Ts...) -> overloaded<Ts...>;

NodeId id(const Json::Value& payload, const char* key) { return NodeId{payload[key].asString()}; }
KindId kindId(const Json::Value& payload, const char* key) { return KindId{payload[key].asString()}; }
}

std::optional<Command> commandFromJson(const std::string& kind, const Json::Value& payload) {
  if (kind == "RenameNode") return RenameNode{id(payload, "id"), payload["label"].asString()};
  if (kind == "SetNodeColor") {
    auto color = parseColor(payload["color"].asString());
    if (!color) return std::nullopt;
    return SetNodeColor{id(payload, "id"), *color};
  }
  if (kind == "RepositionNode")
    return RepositionNode{id(payload, "id"), Vec2{payload["x"].asDouble(), payload["y"].asDouble()}};
  if (kind == "CreateNode") {
    CreateNode command;
    command.id = id(payload, "id");
    command.label = payload["label"].asString();
    command.icon = payload["icon"].asString();
    command.color = parseColor(payload.get("color", "terracotta").asString()).value_or(NodeColor::terracotta);
    if (payload.isMember("parentId") && payload["parentId"].isString())
      command.prerequisites.push_back(NodeId{payload["parentId"].asString()});
    for (const Json::Value& prereq : payload["prerequisites"])
      if (prereq.isString()) command.prerequisites.push_back(NodeId{prereq.asString()});
    if (payload.isMember("x") && payload.isMember("y")) command.position = Vec2{payload["x"].asDouble(), payload["y"].asDouble()};
    command.description = payload.get("description", "").asString();
    if (payload.isMember("links")) command.links = linksFromJson(payload["links"]);
    return command;
  }
  if (kind == "AnnotateNode") {
    AnnotateNode command;
    command.id = id(payload, "id");
    if (payload.isMember("description") && payload["description"].isString())
      command.description = payload["description"].asString();
    if (payload.isMember("links")) command.links = linksFromJson(payload["links"]);
    return command;
  }
  if (kind == "AddEdge") return AddEdge{id(payload, "from"), id(payload, "to")};
  if (kind == "RemoveEdge") return RemoveEdge{id(payload, "from"), id(payload, "to")};
  if (kind == "ReconnectEdge")
    return ReconnectEdge{id(payload, "oldFrom"), id(payload, "oldTo"), id(payload, "newFrom"), id(payload, "newTo")};
  if (kind == "DeleteNode") return DeleteNode{id(payload, "id")};
  if (kind == "TransitiveReduction") return TransitiveReduction{};
  if (kind == "PruneDangling") return PruneDangling{};
  if (kind == "RenameKind") return RenameKind{kindId(payload, "id"), payload["label"].asString()};
  if (kind == "DescribeKind") return DescribeKind{kindId(payload, "id"), payload["description"].asString()};
  if (kind == "AddKind") {
    auto hue = parseColor(payload["hue"].asString());
    if (!hue) return std::nullopt;
    return AddKind{kindId(payload, "id"), *hue, payload.get("label", "").asString(),
                   payload.get("description", "").asString()};
  }
  if (kind == "RemoveKind") return RemoveKind{kindId(payload, "id")};
  if (kind == "ReorderKinds") {
    std::vector<KindId> order;
    for (const Json::Value& member : payload["order"]) order.push_back(KindId{member.asString()});
    return ReorderKinds{std::move(order)};
  }
  if (kind == "RecolorKind") {
    auto hue = parseColor(payload["hue"].asString());
    if (!hue) return std::nullopt;
    return RecolorKind{kindId(payload, "id"), *hue};
  }
  return std::nullopt;
}

std::string commandKind(const Command& command) {
  return std::visit(overloaded{
    [](const RenameNode&) { return std::string("RenameNode"); },
    [](const SetNodeColor&) { return std::string("SetNodeColor"); },
    [](const RepositionNode&) { return std::string("RepositionNode"); },
    [](const CreateNode&) { return std::string("CreateNode"); },
    [](const AnnotateNode&) { return std::string("AnnotateNode"); },
    [](const AddEdge&) { return std::string("AddEdge"); },
    [](const RemoveEdge&) { return std::string("RemoveEdge"); },
    [](const ReconnectEdge&) { return std::string("ReconnectEdge"); },
    [](const DeleteNode&) { return std::string("DeleteNode"); },
    [](const TransitiveReduction&) { return std::string("TransitiveReduction"); },
    [](const PruneDangling&) { return std::string("PruneDangling"); },
    [](const RenameKind&) { return std::string("RenameKind"); },
    [](const DescribeKind&) { return std::string("DescribeKind"); },
    [](const AddKind&) { return std::string("AddKind"); },
    [](const RemoveKind&) { return std::string("RemoveKind"); },
    [](const ReorderKinds&) { return std::string("ReorderKinds"); },
    [](const RecolorKind&) { return std::string("RecolorKind"); },
  }, command);
}

Json::Value commandPayload(const Command& command) {
  Json::Value p(Json::objectValue);
  std::visit(overloaded{
    [&](const RenameNode& c) { p["id"] = c.id.str(); p["label"] = c.label; },
    [&](const SetNodeColor& c) { p["id"] = c.id.str(); p["color"] = std::string(toString(c.color)); },
    [&](const RepositionNode& c) { p["id"] = c.id.str(); p["x"] = c.position.x; p["y"] = c.position.y; },
    [&](const CreateNode& c) {
      p["id"] = c.id.str();
      p["label"] = c.label;
      p["icon"] = c.icon;
      p["color"] = std::string(toString(c.color));
      if (!c.prerequisites.empty()) {
        Json::Value prerequisites(Json::arrayValue);
        for (const NodeId& prereq : c.prerequisites) prerequisites.append(prereq.str());
        p["prerequisites"] = prerequisites;
      }
      if (c.position) { p["x"] = c.position->x; p["y"] = c.position->y; }
      if (!c.description.empty()) p["description"] = c.description;
      if (!c.links.empty()) p["links"] = linksToJson(c.links);
    },
    [&](const AnnotateNode& c) {
      p["id"] = c.id.str();
      if (c.description) p["description"] = *c.description;
      if (c.links) p["links"] = linksToJson(*c.links);
    },
    [&](const AddEdge& c) { p["from"] = c.from.str(); p["to"] = c.to.str(); },
    [&](const RemoveEdge& c) { p["from"] = c.from.str(); p["to"] = c.to.str(); },
    [&](const ReconnectEdge& c) {
      p["oldFrom"] = c.oldFrom.str(); p["oldTo"] = c.oldTo.str();
      p["newFrom"] = c.newFrom.str(); p["newTo"] = c.newTo.str();
    },
    [&](const DeleteNode& c) { p["id"] = c.id.str(); },
    [&](const TransitiveReduction&) {},
    [&](const PruneDangling&) {},
    [&](const RenameKind& c) { p["id"] = c.id.str(); p["label"] = c.label; },
    [&](const DescribeKind& c) { p["id"] = c.id.str(); p["description"] = c.description; },
    [&](const AddKind& c) {
      p["id"] = c.id.str();
      p["hue"] = std::string(toString(c.hue));
      if (!c.label.empty()) p["label"] = c.label;
      if (!c.description.empty()) p["description"] = c.description;
    },
    [&](const RemoveKind& c) { p["id"] = c.id.str(); },
    [&](const ReorderKinds& c) {
      Json::Value order(Json::arrayValue);
      for (const KindId& id : c.order) order.append(id.str());
      p["order"] = order;
    },
    [&](const RecolorKind& c) { p["id"] = c.id.str(); p["hue"] = std::string(toString(c.hue)); },
  }, command);
  return p;
}

}

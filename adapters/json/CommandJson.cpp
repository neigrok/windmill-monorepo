#include "adapters/json/CommandJson.h"

#include "domain/Tree.h"

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
    if (payload.isMember("parentId") && payload["parentId"].isString()) command.parent = NodeId{payload["parentId"].asString()};
    if (payload.isMember("x") && payload.isMember("y")) command.position = Vec2{payload["x"].asDouble(), payload["y"].asDouble()};
    return command;
  }
  if (kind == "AddEdge") return AddEdge{id(payload, "from"), id(payload, "to")};
  if (kind == "RemoveEdge") return RemoveEdge{id(payload, "from"), id(payload, "to")};
  if (kind == "ReconnectEdge")
    return ReconnectEdge{id(payload, "oldFrom"), id(payload, "oldTo"), id(payload, "newFrom"), id(payload, "newTo")};
  if (kind == "DeleteNode") return DeleteNode{id(payload, "id")};
  if (kind == "TransitiveReduction") return TransitiveReduction{};
  if (kind == "RenameKind") return RenameKind{kindId(payload, "id"), payload["label"].asString()};
  if (kind == "DescribeKind") return DescribeKind{kindId(payload, "id"), payload["description"].asString()};
  if (kind == "AddKind") {
    auto hue = parseColor(payload["hue"].asString());
    if (!hue) return std::nullopt;
    return AddKind{kindId(payload, "id"), *hue};
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
    [](const AddEdge&) { return std::string("AddEdge"); },
    [](const RemoveEdge&) { return std::string("RemoveEdge"); },
    [](const ReconnectEdge&) { return std::string("ReconnectEdge"); },
    [](const DeleteNode&) { return std::string("DeleteNode"); },
    [](const TransitiveReduction&) { return std::string("TransitiveReduction"); },
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
      if (c.parent) p["parentId"] = c.parent->str();
      if (c.position) { p["x"] = c.position->x; p["y"] = c.position->y; }
    },
    [&](const AddEdge& c) { p["from"] = c.from.str(); p["to"] = c.to.str(); },
    [&](const RemoveEdge& c) { p["from"] = c.from.str(); p["to"] = c.to.str(); },
    [&](const ReconnectEdge& c) {
      p["oldFrom"] = c.oldFrom.str(); p["oldTo"] = c.oldTo.str();
      p["newFrom"] = c.newFrom.str(); p["newTo"] = c.newTo.str();
    },
    [&](const DeleteNode& c) { p["id"] = c.id.str(); },
    [&](const TransitiveReduction&) {},
    [&](const RenameKind& c) { p["id"] = c.id.str(); p["label"] = c.label; },
    [&](const DescribeKind& c) { p["id"] = c.id.str(); p["description"] = c.description; },
    [&](const AddKind& c) { p["id"] = c.id.str(); p["hue"] = std::string(toString(c.hue)); },
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

Json::Value opFrame(const AppliedOp& op) {
  Json::Value frame(Json::objectValue);
  frame["t"] = "op";
  frame["seq"] = static_cast<Json::Int64>(op.seq);
  frame["opId"] = op.opId;  // lets an author recognize and skip the echo of its own op
  frame["actor"] = op.actor.str();
  frame["kind"] = commandKind(op.command);
  frame["payload"] = commandPayload(op.command);
  frame["hlc"] = std::to_string(op.hlc.physicalMs) + ":" + std::to_string(op.hlc.counter) + ":" + op.hlc.actor;
  return frame;
}

}

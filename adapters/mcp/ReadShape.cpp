#include "adapters/mcp/ReadShape.h"

#include "adapters/json/TreeJson.h"
#include "adapters/mcp/ToolArgs.h"

namespace wm {

namespace {

Json::Value idArray(const std::set<NodeId>& ids) {
  Json::Value array(Json::arrayValue);
  for (const NodeId& id : ids) array.append(id.str());
  return array;
}

}

const Vocabulary<NodeField>& nodeVocabulary() {
  static const Vocabulary<NodeField> vocabulary({{"id", NodeField::id},
                                                 {"label", NodeField::label},
                                                 {"icon", NodeField::icon},
                                                 {"color", NodeField::color},
                                                 {"order", NodeField::order},
                                                 {"prerequisites", NodeField::prerequisites},
                                                 {"position", NodeField::position},
                                                 {"status", NodeField::status},
                                                 {"description", NodeField::description},
                                                 {"links", NodeField::links}});
  return vocabulary;
}

const Vocabulary<KindField>& kindVocabulary() {
  static const Vocabulary<KindField> vocabulary({{"id", KindField::id},
                                                 {"hue", KindField::hue},
                                                 {"label", KindField::label},
                                                 {"description", KindField::description}});
  return vocabulary;
}

const Vocabulary<ProgressField>& progressVocabulary() {
  static const Vocabulary<ProgressField> vocabulary({{"completed", ProgressField::completed},
                                                     {"inProgress", ProgressField::inProgress},
                                                     {"cleared", ProgressField::cleared}});
  return vocabulary;
}

Json::Value projectNode(const NodeSpec& node, const NodeFields& fields) {
  Json::Value n(Json::objectValue);
  if (fields.count(NodeField::id)) n["id"] = node.id.str();
  if (fields.count(NodeField::label)) n["label"] = node.label;
  if (fields.count(NodeField::icon)) n["icon"] = node.icon;
  if (fields.count(NodeField::color)) n["color"] = std::string(toString(node.color));
  if (fields.count(NodeField::order) && !node.order.empty()) n["order"] = node.order;
  if (fields.count(NodeField::prerequisites)) {
    Json::Value prerequisites(Json::arrayValue);
    for (const NodeId& prereq : node.prerequisites) prerequisites.append(prereq.str());
    n["prerequisites"] = prerequisites;
  }
  if (fields.count(NodeField::position) && node.position) {
    Json::Value position(Json::objectValue);
    position["x"] = node.position->x;
    position["y"] = node.position->y;
    n["position"] = position;
  }
  if (fields.count(NodeField::status) && node.status) n["status"] = *node.status;
  if (fields.count(NodeField::description) && !node.description.empty()) n["description"] = node.description;
  if (fields.count(NodeField::links) && !node.links.empty()) n["links"] = linksToJson(node.links);
  return n;
}

Json::Value projectKind(const Kind& kind, const KindFields& fields) {
  Json::Value k(Json::objectValue);
  if (fields.count(KindField::id)) k["id"] = kind.id.str();
  if (fields.count(KindField::hue)) k["hue"] = std::string(toString(kind.hue));
  if (fields.count(KindField::label)) k["label"] = kind.label;
  if (fields.count(KindField::description)) k["description"] = kind.description;
  return k;
}

Json::Value projectProgress(const Progress& progress, const ProgressFields& fields) {
  Json::Value root(Json::objectValue);
  if (fields.count(ProgressField::completed)) root["completed"] = idArray(progress.completed);
  if (fields.count(ProgressField::inProgress)) root["inProgress"] = idArray(progress.inProgress);
  if (fields.count(ProgressField::cleared)) root["cleared"] = idArray(progress.cleared);
  return root;
}

std::optional<Page> pageOf(const std::vector<NodeSpec>& matches, const Json::Value& args, std::string& error) {
  const Json::Value& requestedLimit = args["limit"];
  int limit = kDefaultLimit;
  if (!requestedLimit.isNull()) {
    const double value = requestedLimit.isNumeric() ? requestedLimit.asDouble() : 0.0;
    if (!requestedLimit.isNumeric() || value < 1 || value > kMaxLimit) {
      error = "argument \"limit\" must be a number between 1 and " + std::to_string(kMaxLimit) +
              ", got " + literal(requestedLimit);
      return std::nullopt;
    }
    limit = static_cast<int>(value);
  }

  const std::string cursor = args["cursor"].isString() ? args["cursor"].asString() : "";
  Page page;
  if (!cursor.empty()) {
    const auto found = std::find_if(matches.begin(), matches.end(),
                                    [&](const NodeSpec& node) { return node.id.str() == cursor; });
    if (found == matches.end()) {
      error = "cursor \"" + cursor + "\" names no node in this result set. "
              "Call again without a cursor to walk it from the start.";
      return std::nullopt;
    }
    page.begin = static_cast<std::size_t>(found - matches.begin()) + 1;
  }

  page.end = std::min(page.begin + static_cast<std::size_t>(limit), matches.size());
  if (page.end < matches.size()) page.nextCursor = matches[page.end - 1].id.str();
  return page;
}

}

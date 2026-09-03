#include "products/roadmap/adapters/mcp/ReadShape.h"

#include "products/roadmap/adapters/json/TreeJson.h"
#include "products/roadmap/adapters/mcp/ToolArgs.h"

namespace wm {

namespace {

Json::Value idArray(const std::set<NodeId>& ids) {
  Json::Value array(Json::arrayValue);
  for (const NodeId& id : ids) array.append(id.str());
  return array;
}

// The byte offset where the code point numbered `codePoints` (zero-based) starts, or npos when
// the text holds no more than that many. Counts UTF-8 lead bytes, so a multi-byte character is one.
std::size_t byteOffsetOfCodePoint(const std::string& text, std::size_t codePoints) {
  std::size_t seen = 0;
  for (std::size_t i = 0; i < text.size(); ++i) {
    if ((static_cast<unsigned char>(text[i]) & 0xC0) == 0x80) continue;
    if (seen == codePoints) return i;
    ++seen;
  }
  return std::string::npos;
}

// The budget is CODE POINTS: the head is the first kSummaryChars of them, cut back to the last
// word boundary in its back half when there is one.
std::string summaryOf(const std::string& description) {
  const std::size_t cut = byteOffsetOfCodePoint(description, kSummaryChars);
  if (cut == std::string::npos) return description;
  std::string head = description.substr(0, cut);
  const std::size_t lastSpace = head.find_last_of(" \n\t");
  const std::size_t halfway = byteOffsetOfCodePoint(head, kSummaryChars / 2);
  if (lastSpace != std::string::npos && lastSpace > halfway) head.resize(lastSpace);
  return head + "\u2026";
}

const char* markOn(const Progress& marks, const NodeId& node) {
  if (marks.completed.count(node)) return progressStatusName(ProgressStatus::complete);
  if (marks.inProgress.count(node)) return progressStatusName(ProgressStatus::active);
  return progressStatusName(ProgressStatus::none);
}

}

const Vocabulary<NodeField>& nodeVocabulary() {
  static const Vocabulary<NodeField> vocabulary({{"id", NodeField::id},
                                                 {"label", NodeField::label},
                                                 {"icon", NodeField::icon},
                                                 {"color", NodeField::color},
                                                 {"kind", NodeField::kind},
                                                 {"order", NodeField::order},
                                                 {"prerequisites", NodeField::prerequisites},
                                                 {"position", NodeField::position},
                                                 {"status", NodeField::status},
                                                 {"seedStatus", NodeField::seedStatus},
                                                 {"state", NodeField::state},
                                                 {"summary", NodeField::summary},
                                                 {"description", NodeField::description},
                                                 {"links", NodeField::links}});
  return vocabulary;
}

const Vocabulary<KindField>& kindVocabulary() {
  static const Vocabulary<KindField> vocabulary({{"id", KindField::id},
                                                 {"hue", KindField::hue},
                                                 {"label", KindField::label},
                                                 {"description", KindField::description},
                                                 {"crossBranchExempt", KindField::crossBranchExempt}});
  return vocabulary;
}

const Vocabulary<ProgressField>& progressVocabulary() {
  static const Vocabulary<ProgressField> vocabulary({{"completed", ProgressField::completed},
                                                     {"inProgress", ProgressField::inProgress},
                                                     {"cleared", ProgressField::cleared}});
  return vocabulary;
}

Json::Value projectNode(const NodeSpec& node, const NodeFields& fields, const NodeReadContext& context) {
  Json::Value n(Json::objectValue);
  if (fields.count(NodeField::id)) n["id"] = node.id.str();
  if (fields.count(NodeField::label)) n["label"] = node.label;
  if (fields.count(NodeField::icon)) n["icon"] = node.icon;
  if (fields.count(NodeField::color)) n["color"] = std::string(toString(node.color));
  if (fields.count(NodeField::kind)) {
    const auto kind = context.kindByHue.find(node.color);
    if (kind != context.kindByHue.end()) n["kind"] = kind->second.str();
  }
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
  if (fields.count(NodeField::status)) n["status"] = markOn(context.marks, node.id);
  if (fields.count(NodeField::seedStatus) && node.status) n["seedStatus"] = *node.status;
  if (fields.count(NodeField::state)) n["state"] = std::string(toString(context.states.at(node.id)));
  if (fields.count(NodeField::summary) && !node.description.empty()) n["summary"] = summaryOf(node.description);
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
  if (fields.count(KindField::crossBranchExempt)) k["crossBranchExempt"] = kind.crossBranchExempt;
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

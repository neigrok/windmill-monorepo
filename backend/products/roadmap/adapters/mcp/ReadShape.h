#pragma once

#include "products/roadmap/domain/Tree.h"

#include <json/json.h>

#include <algorithm>
#include <cstddef>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace wm {

// How much of a tree an MCP read answers with. MCP-only: REST keeps the whole document.

// `status` is the CALLER'S OWN mark, `seedStatus` the document's authored baseline, and `state`
// what the tree DERIVES — the unlock cascade over the caller's marks. `summary` is the
// description's first kSummaryChars code points, cut at a word and marked with an ellipsis when
// cut. `kind` is the legend kind whose hue the node wears, omitted when no kind wears it.
enum class NodeField { id, label, icon, color, kind, order, prerequisites, position, status, seedStatus,
                       state, summary, description, links };
constexpr std::size_t kSummaryChars = 200;
// The most live edges one get_tree reply lists whole under `includeEdges`; past it the reply
// answers `edgesOmitted` with the count instead. Listing is linear, so only the edge count gates.
constexpr std::size_t kMaxListedEdges = 6000;
enum class KindField { id, hue, label, description, crossBranchExempt };
enum class ProgressField { completed, cleared, outOfOrder };

using NodeFields = std::set<NodeField>;
using KindFields = std::set<KindField>;
using ProgressFields = std::set<ProgressField>;

inline const NodeFields kFindNodesFields{NodeField::id, NodeField::label, NodeField::color};

inline const NodeFields kGetTreeFields{NodeField::id, NodeField::label, NodeField::color,
                                       NodeField::prerequisites};

inline const KindFields kLegendFields{KindField::id, KindField::hue, KindField::label};

// `cleared` lets a browser's reconcile tell "cleared" from "never marked"; an agent has no use
// for it. `outOfOrder` is the subset of `completed` the caller marked as meant out of order.
inline const ProgressFields kProgressFields{ProgressField::completed,
                                            ProgressField::outOfOrder};

// One shape's `fields` vocabulary: the legal names in wire order, each paired with its field.
template <typename Field>
class Vocabulary {
public:
  using Fields = std::set<Field>;

  explicit Vocabulary(std::vector<std::pair<std::string, Field>> entries) : entries_(std::move(entries)) {}

  // The legal set, for the `enum` a tool's schema advertises.
  std::vector<std::string> names() const {
    std::vector<std::string> out;
    for (const auto& [name, field] : entries_) out.push_back(name);
    return out;
  }

  std::string legalSet() const {
    std::string out = "{";
    for (const auto& [name, field] : entries_) {
      if (out.size() > 1) out += ", ";
      out += name;
    }
    return out + "}";
  }

  // The fields `requested` names, or `fallback` when the caller asked for nothing. `path` is the
  // spelling that tool publishes, and every refusal names it.
  std::optional<Fields> parse(const Json::Value& requested, const char* path, const Fields& fallback,
                              std::string& error) const {
    if (requested.isNull()) return fallback;
    if (!requested.isArray()) {
      error = "argument \"" + std::string(path) + "\" must be an array of field names, one of " + legalSet();
      return std::nullopt;
    }
    Fields chosen;
    for (Json::ArrayIndex i = 0; i < requested.size(); ++i) {
      const std::string element = std::string(path) + "[" + std::to_string(i) + "]";
      if (!requested[i].isString()) {
        error = element + " must be a string, one of " + legalSet();
        return std::nullopt;
      }
      const std::string name = requested[i].asString();
      const auto entry = std::find_if(entries_.begin(), entries_.end(),
                                      [&](const auto& candidate) { return candidate.first == name; });
      if (entry == entries_.end()) {
        error = element + " \"" + name + "\" is not one of " + legalSet();
        return std::nullopt;
      }
      chosen.insert(entry->second);
    }
    return chosen;
  }

private:
  std::vector<std::pair<std::string, Field>> entries_;
};

const Vocabulary<NodeField>& nodeVocabulary();
const Vocabulary<KindField>& kindVocabulary();
const Vocabulary<ProgressField>& progressVocabulary();

// Each part is filled only when a field or a filter asks for it, and stays empty otherwise.
// The states are derived over EVERY node the tree holds, since a prerequisite may sit off the page;
// `kindByHue` is the legend's hue -> kind id join, one entry per kind.
struct NodeReadContext {
  Progress marks;
  std::map<NodeId, NodeState> states;
  std::map<NodeColor, KindId> kindByHue;
};

// Field semantics are TreeJson's: empty and absent values are omitted as the document omits
// them. An unmarked node answers `status: "none"`, and `state` is derived for every node.
Json::Value projectNode(const NodeSpec& node, const NodeFields& fields, const NodeReadContext& context);
Json::Value projectKind(const Kind& kind, const KindFields& fields);
Json::Value projectProgress(const Progress& progress, const ProgressFields& fields);

inline constexpr std::size_t kMaxReadNodeIds = 200;
inline constexpr std::size_t kNodeBatchByteBudget = 256 * 1024;

inline constexpr int kDefaultLimit = 200;
inline constexpr int kMaxLimit = 1000;

// `[begin, end)` index the caller's own ordered match list; `nextCursor` is empty on the last page.
struct Page {
  std::size_t begin = 0;
  std::size_t end = 0;
  std::string nextCursor;
};

// The page `args` asks for out of `matches`. Fails, naming the offending value, on a limit out
// of range or a cursor these matches no longer hold.
std::optional<Page> pageOf(const std::vector<NodeSpec>& matches, const Json::Value& args, std::string& error);

// A page whose fields carry `description` is also held to a byte budget, measured on the wire it
// is sent as (`\uXXXX` escapes included): once the nodes serialized so far pass kPageByteBudget the
// page ends there and `nextCursor` resumes after it, so a thousand nodes of 16000 four-byte
// characters never make one 192 MB reply. `bytes` is set only when the budget, not `limit`, ended
// the page — the reply carries it as `pageBytes` so the caller knows why the page is short.
constexpr std::size_t kPageByteBudget = 4 * 1024 * 1024;
struct ProjectedPage {
  Json::Value nodes{Json::arrayValue};
  std::string nextCursor;
  std::optional<std::size_t> bytes;
};
ProjectedPage projectPage(const std::vector<NodeSpec>& matches, const Page& page, const NodeFields& fields,
                          const NodeReadContext& context);

}

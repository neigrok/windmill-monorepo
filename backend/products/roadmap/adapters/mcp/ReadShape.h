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
// description's first kSummaryChars, cut at a word and marked with an ellipsis when cut.
enum class NodeField { id, label, icon, color, order, prerequisites, position, status, seedStatus, state,
                       summary, description, links };
constexpr std::size_t kSummaryChars = 200;
enum class KindField { id, hue, label, description };
enum class ProgressField { completed, inProgress, cleared };

using NodeFields = std::set<NodeField>;
using KindFields = std::set<KindField>;
using ProgressFields = std::set<ProgressField>;

inline const NodeFields kFindNodesFields{NodeField::id, NodeField::label, NodeField::color};

inline const NodeFields kGetTreeFields{NodeField::id, NodeField::label, NodeField::color,
                                       NodeField::prerequisites};

inline const KindFields kLegendFields{KindField::id, KindField::hue, KindField::label};

// `cleared` lets a browser's reconcile tell "cleared" from "never marked"; an agent has no use
// for it.
inline const ProgressFields kProgressFields{ProgressField::completed, ProgressField::inProgress};

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

// Each half is filled only when a field or a filter asks for it, and stays empty otherwise.
// The states are derived over EVERY node the tree holds, since a prerequisite may sit off the page.
struct NodeReadContext {
  Progress marks;
  std::map<NodeId, NodeState> states;
};

// Field semantics are TreeJson's: empty and absent values are omitted as the document omits
// them. An unmarked node answers `status: "none"`, and `state` is derived for every node.
Json::Value projectNode(const NodeSpec& node, const NodeFields& fields, const NodeReadContext& context);
Json::Value projectKind(const Kind& kind, const KindFields& fields);
Json::Value projectProgress(const Progress& progress, const ProgressFields& fields);

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

}

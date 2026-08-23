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

// How much of a tree an MCP read answers with — which fields, and how many nodes at a time.
// MCP-only: the REST endpoints keep the whole document.

// Three distinct facts, deliberately three words: `status` is the CALLER'S OWN mark,
// `seedStatus` is the document's authored baseline, and `state` is what the tree DERIVES —
// locked / available / active / complete, the unlock cascade over the caller's marks. `summary`
// is the description's first kSummaryChars, cut at a word and marked with an ellipsis when cut.
enum class NodeField { id, label, icon, color, order, prerequisites, position, status, seedStatus, state,
                       summary, description, links };
constexpr std::size_t kSummaryChars = 200;
enum class KindField { id, hue, label, description };
enum class ProgressField { completed, inProgress, cleared };

using NodeFields = std::set<NodeField>;
using KindFields = std::set<KindField>;
using ProgressFields = std::set<ProgressField>;

// find_nodes answers an INDEX: the ids are what you edit by, the label and hue what you pick
// them out by.
inline const NodeFields kFindNodesFields{NodeField::id, NodeField::label, NodeField::color};

// get_tree answers the SHAPE: what exists, and what unlocks what. Everything else is one
// `fields` away.
inline const NodeFields kGetTreeFields{NodeField::id, NodeField::label, NodeField::color,
                                       NodeField::prerequisites};

// The legend names the hues; a kind's description is rarely read.
inline const KindFields kLegendFields{KindField::id, KindField::hue, KindField::label};

// `cleared` lets a browser's reconcile tell "cleared" from "never marked"; an agent has no use
// for it.
inline const ProgressFields kProgressFields{ProgressField::completed, ProgressField::inProgress};

// One shape's `fields` vocabulary: the legal names, in wire order, each paired with the field it
// selects.
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
  // spelling that tool publishes — "fields" or "kindFields" — and every refusal names it.
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

// The caller's side of one read: their own progress rows, and the states derived from them over
// EVERY node the tree holds (a prerequisite may sit off the page). Each half is filled only when
// a field or a filter asks for it, and stays empty otherwise.
struct NodeReadContext {
  Progress marks;
  std::map<NodeId, NodeState> states;
};

// The field semantics are TreeJson's, field for field: empty and absent values are omitted
// exactly as the document omits them. `status` and `state` are the exceptions — an unmarked node
// answers `status: "none"`, and `state` is derived for every node the tree holds.
Json::Value projectNode(const NodeSpec& node, const NodeFields& fields, const NodeReadContext& context);
Json::Value projectKind(const Kind& kind, const KindFields& fields);
Json::Value projectProgress(const Progress& progress, const ProgressFields& fields);

inline constexpr int kDefaultLimit = 200;
inline constexpr int kMaxLimit = 1000;

// One page of a read's matches: `[begin, end)` index the caller's own ordered match list, and
// `nextCursor` is the opaque token asking for the page after this one — empty on the last page.
struct Page {
  std::size_t begin = 0;
  std::size_t end = 0;
  std::string nextCursor;
};

// The page `args` asks for out of `matches`: `limit` nodes starting after the node `cursor`
// names. Fails, naming the offending value, on a limit out of range or a cursor these matches no
// longer hold.
std::optional<Page> pageOf(const std::vector<NodeSpec>& matches, const Json::Value& args, std::string& error);

}

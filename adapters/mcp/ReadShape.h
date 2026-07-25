#pragma once

#include "domain/Tree.h"

#include <json/json.h>

#include <algorithm>
#include <cstddef>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace wm {

// How much of a tree an MCP read answers with — which fields, and how many nodes at a time.
//
// adapters/json/TreeJson.h is the document the browser paints from: it needs `position`,
// `order`, `icon` and every link to draw a first frame. An agent reading those same bytes pays
// for all of it and uses almost none — one node's `description` alone may run to 4000
// characters, its `links` to 32 × 2048. So every MCP read projects. `fields` is spelled the
// same on every tool that takes one; each shape carries its own vocabulary, and each default is
// the lean answer that tool exists to give. This is MCP-only: the REST endpoints keep the whole
// document.

enum class NodeField { id, label, icon, color, order, prerequisites, position, status, description, links };
enum class KindField { id, hue, label, description };
enum class ProgressField { completed, inProgress, cleared };

using NodeFields = std::set<NodeField>;
using KindFields = std::set<KindField>;
using ProgressFields = std::set<ProgressField>;

// find_nodes answers an INDEX: the ids are what you edit by, the label and hue what you pick
// them out by. Returning whole node bodies is what once blew a caller's token budget on a
// three-letter query.
inline const NodeFields kFindNodesFields{NodeField::id, NodeField::label, NodeField::color};

// get_tree answers the SHAPE: what exists, and what unlocks what. Layout (`position`, `order`),
// `icon`, and the authoring-time `status` seed the server round-trips but never acts on are
// noise to a reader; `description` and `links` are the bulk. All of them are one `fields` away.
inline const NodeFields kGetTreeFields{NodeField::id, NodeField::label, NodeField::color,
                                       NodeField::prerequisites};

// The legend names the hues; a kind's description is the generator's sorting brief, rarely read.
inline const KindFields kLegendFields{KindField::id, KindField::hue, KindField::label};

// `cleared` lets a browser's reconcile tell "cleared" from "never marked". To an agent it is a
// third full list of ids with no meaning — the tool's own description never mentions it.
inline const ProgressFields kProgressFields{ProgressField::completed, ProgressField::inProgress};

// One shape's `fields` vocabulary: the legal names, in wire order, each paired with the field it
// selects. Parsing is the same for every shape — only the table differs.
template <typename Field>
class Vocabulary {
public:
  using Fields = std::set<Field>;

  explicit Vocabulary(std::vector<std::pair<std::string, Field>> entries) : entries_(std::move(entries)) {}

  // The legal set, for the `enum` a tool's schema advertises — a client can pre-validate only
  // what the schema states.
  std::vector<std::string> names() const {
    std::vector<std::string> out;
    for (const auto& [name, field] : entries_) out.push_back(name);
    return out;
  }

  std::string legalSet() const {
    std::string out;
    for (const auto& [name, field] : entries_) {
      if (!out.empty()) out += ", ";
      out += name;
    }
    return out;
  }

  // The fields `requested` names, or `fallback` when the caller asked for nothing. An unknown
  // name is refused with a message that names the offender AND enumerates the legal set, so one
  // round trip is enough to fix it.
  std::optional<Fields> parse(const Json::Value& requested, const Fields& fallback, std::string& error) const {
    if (requested.isNull()) return fallback;
    if (!requested.isArray()) {
      error = "fields must be an array of field names; legal fields: " + legalSet();
      return std::nullopt;
    }
    Fields chosen;
    for (const Json::Value& value : requested) {
      if (!value.isString()) {
        error = "fields must be an array of field names; legal fields: " + legalSet();
        return std::nullopt;
      }
      const std::string name = value.asString();
      const auto entry = std::find_if(entries_.begin(), entries_.end(),
                                      [&](const auto& candidate) { return candidate.first == name; });
      if (entry == entries_.end()) {
        error = "unknown field: " + name + "; legal fields: " + legalSet();
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

// The field semantics are TreeJson's, field for field — an empty `order`, an absent `position`
// or `status`, an empty `description` or `links` are omitted exactly as the document omits them.
Json::Value projectNode(const NodeSpec& node, const NodeFields& fields);
Json::Value projectKind(const Kind& kind, const KindFields& fields);
Json::Value projectProgress(const Progress& progress, const ProgressFields& fields);

inline constexpr int kDefaultLimit = 200;
inline constexpr int kMaxLimit = 1000;

// One page of a read's matches: `[begin, end)` index the caller's own ordered match list, and
// `nextCursor` is the opaque token that asks for the page after this one — empty when this page
// is the last. A cap without a way past it makes the rows beyond it unreachable, so a capped
// answer always carries the token that resumes it.
struct Page {
  std::size_t begin = 0;
  std::size_t end = 0;
  std::string nextCursor;
};

// The page `args` asks for out of `matches`: `limit` nodes (default 200, max 1000) starting
// after the node `cursor` names. Fails, naming the offending value, on a limit out of range or
// a cursor these matches no longer hold — a walk that silently restarted would hand back rows
// the caller has already read.
std::optional<Page> pageOf(const std::vector<NodeSpec>& matches, const Json::Value& args, std::string& error);

}

#pragma once

#include "products/roadmap/domain/Crdt.h"
#include "products/roadmap/domain/GraphState.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tree.h"

#include <cstddef>
#include <map>
#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace wm {

// The full CRDT state of one legend kind: element-set life stamps plus each field's LWW
// stamp. Mirrors NodeStateEntry, so reload is lossless (tombstones and ranks included).
struct KindStateEntry {
  KindId id;
  Hlc createdAt;
  Hlc deletedAt;
  NodeColor hue = NodeColor::terracotta;
  Hlc hueAt;
  std::string label;
  Hlc labelAt;
  std::string description;
  Hlc descriptionAt;
  bool crossBranchExempt = false;
  Hlc crossBranchExemptAt;
  double rank = 0;
  Hlc rankAt;
  bool operator==(const KindStateEntry&) const = default;
};

struct LegendState {
  std::vector<KindStateEntry> kinds;
  bool operator==(const LegendState&) const = default;
};

// The ordered legend of one tree, under the same CRDT discipline as LooseGraph. Kinds sort by `rank`
// (then id), and legend order is generation priority. Validity (hue uniqueness, ≤6, in-use removal,
// length caps) is enforced at the edge by validate(), never here.
class Legend {
public:
  Legend() = default;
  explicit Legend(const LegendState& state);
  Legend(const std::vector<Kind>& kinds, const Hlc& at);

  // Fold a partial legend state in, under the same element-set + LWW discipline as LooseGraph::join.
  void join(const LegendState& state);

  // The kinds a tree is born with: those it is sent, in their order, or the three defaults when it is
  // sent none. TreeRegistry plants them and create_tree answers them, so the two cannot disagree.
  static std::vector<Kind> bornWith(const std::vector<Kind>& sent);
  // The three default kinds, stamped `at`: bornWith({}).
  static Legend seededDefaults(const Hlc& at);

  void addKind(const KindId& id, NodeColor hue, const Hlc& at);
  void removeKind(const KindId& id, const Hlc& at);
  void setLabel(const KindId& id, const std::string& label, const Hlc& at);
  void setDescription(const KindId& id, const std::string& description, const Hlc& at);
  void setCrossBranchExempt(const KindId& id, bool exempt, const Hlc& at);
  void setHue(const KindId& id, NodeColor hue, const Hlc& at);
  void reorder(const std::vector<KindId>& order, const Hlc& at);

  bool has(const KindId& id) const;
  bool empty() const;
  std::size_t size() const;
  std::optional<NodeColor> hueOf(const KindId& id) const;
  std::optional<KindId> ownerOf(NodeColor hue) const;
  std::optional<Kind> view(const KindId& id) const;
  std::vector<Kind> kinds() const;
  std::vector<KindId> orderedIds() const;

  LegendState exportState() const;
  // One kind's full CRDT state, for sparse persistence. nullopt for a never-seen id.
  std::optional<KindStateEntry> exportKind(const KindId& id) const;

  // One past the highest present rank: where addKind lands a kind, and where a graft lands a new one.
  double nextRank() const;

private:
  struct KindRecord {
    ElementSet life;
    Lww<NodeColor> hue;
    Lww<std::string> label;
    Lww<std::string> description;
    Lww<bool> crossBranchExempt;
    Lww<double> rank;
  };

  std::map<KindId, KindRecord> kinds_;
};

// A node's hue as a write names it: by a colour, by a legend kind, or by both when they agree.
struct HueChoice {
  std::optional<NodeColor> color;
  std::optional<KindId> kind;
};

// A node write's `kind` refused: the legend holds no kind of that id, or the colour sent beside it is
// another hue than that kind wears. The sentence is what the caller reads.
struct KindRefusal {
  enum class Reason { unknownKind, hueMismatch };
  Reason reason;
  std::string sentence;

  bool operator==(const KindRefusal&) const = default;
};

// The hue a node write lands among `kinds`, the legend the write applies to: the hue its kind wears, else its colour,
// else nullopt when it names neither. A colour sent beside a kind must equal the hue that kind wears, unless it is an
// echo — a colour that does not land over `held`, the node as the tree holds it (landsOver) — when the kind is the
// write's word. A node the tree does not hold has no echo. A refusal's sentence names the arguments under `path`
// ("", "updates[0].").
std::variant<std::optional<NodeColor>, KindRefusal> resolveHue(const std::vector<Kind>& kinds, const HueChoice& choice,
                                                               const std::optional<NodeStateEntry>& held,
                                                               const std::string& path);

}

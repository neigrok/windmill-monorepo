#pragma once

#include "platform/domain/Crdt.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tree.h"

#include <cstddef>
#include <map>
#include <optional>
#include <string>
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
  double rank = 0;
  Hlc rankAt;
  bool operator==(const KindStateEntry&) const = default;
};

struct LegendState {
  std::vector<KindStateEntry> kinds;
  bool operator==(const LegendState&) const = default;
};

// The ordered legend of one tree, kept under the same CRDT discipline as LooseGraph: an add-biased
// element-set of kinds, each field a last-writer-wins register. Kinds sort by `rank` (then id), and
// legend order is generation priority. Every mutation is an unconditional LWW merge; validity (hue
// uniqueness, ≤6, in-use removal, length caps) is enforced at the edge by validate(), never here.
class Legend {
public:
  Legend() = default;
  explicit Legend(const LegendState& state);
  Legend(const std::vector<Kind>& kinds, const Hlc& at);

  // Fold a partial legend state in, under the same element-set + LWW discipline as LooseGraph::join.
  void join(const LegendState& state);

  // Build's terracotta, Learn's olive, Milestone's gold — the three a new tree is born with, in
  // that order. Never all six.
  static Legend seededDefaults(const Hlc& at);

  void addKind(const KindId& id, NodeColor hue, const Hlc& at);
  void removeKind(const KindId& id, const Hlc& at);
  void setLabel(const KindId& id, const std::string& label, const Hlc& at);
  void setDescription(const KindId& id, const std::string& description, const Hlc& at);
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

private:
  struct KindRecord {
    ElementSet life;
    Lww<NodeColor> hue;
    Lww<std::string> label;
    Lww<std::string> description;
    Lww<double> rank;
  };

  double nextRank() const;

  std::map<KindId, KindRecord> kinds_;
};

}

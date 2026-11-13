#include "products/roadmap/domain/Legend.h"

#include "products/roadmap/domain/TreeDiagnostics.h"

#include <algorithm>

namespace wm {

Legend::Legend(const LegendState& state) {
  for (const KindStateEntry& kind : state.kinds) {
    KindRecord record;
    record.life.addedAt = kind.createdAt;
    record.life.removedAt = kind.deletedAt;
    record.hue = {kind.hue, kind.hueAt};
    record.label = {kind.label, kind.labelAt};
    record.description = {kind.description, kind.descriptionAt};
    record.rank = {kind.rank, kind.rankAt};
    kinds_[kind.id] = std::move(record);
  }
}

Legend::Legend(const std::vector<Kind>& kinds, const Hlc& at) {
  for (std::size_t i = 0; i < kinds.size(); ++i) {
    const Kind& kind = kinds[i];
    KindRecord& record = kinds_[kind.id];
    record.life.add(at);
    record.hue.merge(kind.hue, at);
    record.label.merge(kind.label, at);
    record.description.merge(kind.description, at);
    record.rank.merge(static_cast<double>(i), at);
  }
}

LegendState Legend::join(const LegendState& state) {
  LegendState landed;
  for (const KindStateEntry& kind : state.kinds) {
    const auto [held, fresh] = kinds_.try_emplace(kind.id);
    KindRecord& record = held->second;
    KindStateEntry took{.id = kind.id};
    if (record.life.add(kind.createdAt)) took.createdAt = kind.createdAt;
    if (record.life.remove(kind.deletedAt)) took.deletedAt = kind.deletedAt;
    if (record.hue.merge(kind.hue, kind.hueAt)) { took.hue = kind.hue; took.hueAt = kind.hueAt; }
    if (record.label.merge(kind.label, kind.labelAt)) { took.label = kind.label; took.labelAt = kind.labelAt; }
    if (record.description.merge(kind.description, kind.descriptionAt)) {
      took.description = kind.description;
      took.descriptionAt = kind.descriptionAt;
    }
    if (record.rank.merge(kind.rank, kind.rankAt)) { took.rank = kind.rank; took.rankAt = kind.rankAt; }
    if (took != KindStateEntry{.id = kind.id}) landed.kinds.push_back(std::move(took));
    else if (fresh) kinds_.erase(held);
  }
  return landed;
}

std::vector<Kind> Legend::bornWith(const std::vector<Kind>& sent) {
  if (!sent.empty()) return sent;
  return {{KindId{"build"}, NodeColor::terracotta, "Build", "Things you make"},
          {KindId{"learn"}, NodeColor::olive, "Learn", "Things you figure out"},
          {KindId{"milestone"}, NodeColor::gold, "Milestone", "Moments that matter"}};
}

Legend Legend::seededDefaults(const Hlc& at) { return Legend(bornWith({}), at); }

double Legend::nextRank() const {
  double max = -1;
  for (const auto& [id, record] : kinds_) {
    if (record.life.present()) max = std::max(max, record.rank.value);
  }
  return max + 1;
}

void Legend::addKind(const KindId& id, NodeColor hue, const Hlc& at) {
  double rank = nextRank();
  KindRecord& record = kinds_[id];
  record.life.add(at);
  record.hue.merge(hue, at);
  record.rank.merge(rank, at);
}

void Legend::removeKind(const KindId& id, const Hlc& at) {
  kinds_[id].life.remove(at);
}

void Legend::setLabel(const KindId& id, const std::string& label, const Hlc& at) {
  kinds_[id].label.merge(label, at);
}

void Legend::setDescription(const KindId& id, const std::string& description, const Hlc& at) {
  kinds_[id].description.merge(description, at);
}

void Legend::setHue(const KindId& id, NodeColor hue, const Hlc& at) {
  kinds_[id].hue.merge(hue, at);
}

void Legend::reorder(const std::vector<KindId>& order, const Hlc& at) {
  for (std::size_t i = 0; i < order.size(); ++i) {
    auto it = kinds_.find(order[i]);
    if (it != kinds_.end() && it->second.life.present()) it->second.rank.merge(static_cast<double>(i), at);
  }
}

bool Legend::has(const KindId& id) const {
  auto it = kinds_.find(id);
  return it != kinds_.end() && it->second.life.present();
}

bool Legend::empty() const {
  return size() == 0;
}

std::size_t Legend::size() const {
  std::size_t count = 0;
  for (const auto& [id, record] : kinds_) {
    if (record.life.present()) ++count;
  }
  return count;
}

std::optional<NodeColor> Legend::hueOf(const KindId& id) const {
  auto it = kinds_.find(id);
  if (it == kinds_.end() || !it->second.life.present()) return std::nullopt;
  return it->second.hue.value;
}

std::optional<KindId> Legend::ownerOf(NodeColor hue) const {
  for (const auto& [id, record] : kinds_) {
    if (record.life.present() && record.hue.value == hue) return id;
  }
  return std::nullopt;
}

std::optional<Kind> Legend::view(const KindId& id) const {
  auto it = kinds_.find(id);
  if (it == kinds_.end() || !it->second.life.present()) return std::nullopt;
  const KindRecord& record = it->second;
  return Kind{id, record.hue.value, record.label.value, record.description.value};
}

std::vector<Kind> Legend::kinds() const {
  std::vector<std::pair<double, Kind>> ordered;
  for (const auto& [id, record] : kinds_) {
    if (record.life.present())
      ordered.push_back({record.rank.value, Kind{id, record.hue.value, record.label.value, record.description.value}});
  }
  std::sort(ordered.begin(), ordered.end(), [](const auto& a, const auto& b) {
    if (a.first != b.first) return a.first < b.first;
    return a.second.id < b.second.id;
  });

  std::vector<Kind> out;
  for (auto& [rank, kind] : ordered) out.push_back(std::move(kind));
  return out;
}

std::vector<KindId> Legend::orderedIds() const {
  std::vector<KindId> ids;
  for (const Kind& kind : kinds()) ids.push_back(kind.id);
  return ids;
}

LegendState Legend::exportState() const {
  LegendState state;
  for (const auto& [id, record] : kinds_) state.kinds.push_back(*exportKind(id));
  return state;
}

std::optional<KindStateEntry> Legend::exportKind(const KindId& id) const {
  auto it = kinds_.find(id);
  if (it == kinds_.end()) return std::nullopt;
  const KindRecord& record = it->second;
  KindStateEntry entry;
  entry.id = id;
  entry.createdAt = record.life.addedAt;
  entry.deletedAt = record.life.removedAt;
  entry.hue = record.hue.value;
  entry.hueAt = record.hue.stamp;
  entry.label = record.label.value;
  entry.labelAt = record.label.stamp;
  entry.description = record.description.value;
  entry.descriptionAt = record.description.stamp;
  entry.rank = record.rank.value;
  entry.rankAt = record.rank.stamp;
  return entry;
}

std::variant<std::optional<NodeColor>, KindRefusal> resolveHue(const std::vector<Kind>& kinds, const HueChoice& choice,
                                                               const std::optional<NodeStateEntry>& held,
                                                               const std::string& path) {
  using Reason = KindRefusal::Reason;
  if (!choice.kind) return choice.color;
  const std::string named = path + "kind \"" + choice.kind->str() + "\"";
  const auto worn = std::find_if(kinds.begin(), kinds.end(), [&](const Kind& kind) { return kind.id == *choice.kind; });
  if (worn == kinds.end()) {
    if (kinds.empty())
      return KindRefusal{Reason::unknownKind, named + " is not a kind of this tree, whose legend holds none — add one "
                                                      "with roadmap_add_kind first"};
    std::string ids;
    for (const Kind& kind : kinds) ids += (ids.empty() ? "\"" : ", \"") + kind.id.str() + "\"";
    return KindRefusal{Reason::unknownKind, named + " is not a kind of this tree; its legend holds " + ids};
  }
  // A colour the node already holds does not land: it is an echo beside the kind, which is the write's word.
  const bool disagrees = choice.color && *choice.color != worn->hue;
  if (disagrees && landsOver(held, &NodeStateEntry::color, *choice.color))
    return KindRefusal{Reason::hueMismatch, named + " wears " + std::string(toString(worn->hue)) + ", but " + path +
                                                "color is \"" + std::string(toString(*choice.color)) +
                                                "\" — send one of the two, or both when they agree"};
  return worn->hue;
}

std::optional<KindRefusal> unnamedHueRefusal(const std::vector<Kind>& kinds, const std::vector<std::string>& unnamed,
                                             JudgedLegend judged) {
  const bool worn =
      std::any_of(kinds.begin(), kinds.end(), [](const Kind& kind) { return kind.hue == kUnnamedNodeHue; });
  if (unnamed.empty() || kinds.empty() || worn) return std::nullopt;
  std::string nodes;
  for (std::size_t i = 0; i < unnamed.size() && i < CountedNodes::cap; ++i) nodes += (nodes.empty() ? "" : ", ") + unnamed[i];
  if (unnamed.size() > CountedNodes::cap) nodes += " and " + std::to_string(unnamed.size() - CountedNodes::cap) + " more";
  std::string legend;
  for (const Kind& kind : kinds)
    legend += (legend.empty() ? "\"" : ", \"") + kind.id.str() + "\"" + (kind.label.empty() ? "" : " (" + kind.label + ")");
  const bool one = unnamed.size() == 1;
  const bool held = judged == JudgedLegend::held;
  return KindRefusal{KindRefusal::Reason::unnamedHue,
                     nodes + (one ? " names" : " name") + " neither \"kind\" nor \"color\", and no kind of " +
                         (held ? "this tree" : "the legend this batch would leave") + " wears " +
                         std::string(toString(kUnnamedNodeHue)) + ", the hue a new node takes without them — name one of " +
                         (held ? "the legend's" : "that legend's") + " kinds" + (one ? "" : " for each") + ": " + legend};
}

}

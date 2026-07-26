#include "domain/Legend.h"

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

void Legend::join(const LegendState& state) {
  for (const KindStateEntry& kind : state.kinds) {
    KindRecord& record = kinds_[kind.id];
    record.life.add(kind.createdAt);
    record.life.remove(kind.deletedAt);
    record.hue.merge(kind.hue, kind.hueAt);
    record.label.merge(kind.label, kind.labelAt);
    record.description.merge(kind.description, kind.descriptionAt);
    record.rank.merge(kind.rank, kind.rankAt);
  }
}

Legend Legend::seededDefaults(const Hlc& at) {
  return Legend({{KindId{"build"}, NodeColor::terracotta, "Build", "Things you make"},
                 {KindId{"learn"}, NodeColor::olive, "Learn", "Things you figure out"},
                 {KindId{"milestone"}, NodeColor::gold, "Milestone", "Moments that matter"}},
                at);
}

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

}

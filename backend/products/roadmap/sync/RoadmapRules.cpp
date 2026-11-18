#include "products/roadmap/sync/RoadmapRules.h"

#include <algorithm>
#include <deque>
#include <set>

namespace wm::roadmap::engine {

using namespace sync;

Json::Value valueOf(const std::optional<Row>& row, const std::string& field) {
  if (!row) return Json::Value(Json::nullValue);
  const auto reg = row->lattice.f.find(field);
  return reg == row->lattice.f.end() ? Json::Value(Json::nullValue) : reg->second.value;
}

bool present(const std::optional<Row>& row) {
  return row && row->lattice.life && row->lattice.life->alive();
}

std::optional<Place> Place::of(const Json::Value& parent) {
  if (!parent.isObject() || !parent["tree"].isString() || !parent["step"].isString()) return std::nullopt;
  return Place{parent["tree"].asString(), parent["step"].asString()};
}

Json::Value Place::toJson() const {
  Json::Value place(Json::objectValue);
  place["tree"] = tree;
  place["step"] = step;
  return place;
}

Roadmaps::Roadmaps(const std::vector<Row>& rows) {
  for (const Row& row : rows) rows_.insert_or_assign(row.id.column(), row);
}

std::optional<Row> Roadmaps::row(const std::string& id) const {
  const auto found = rows_.find(id);
  return found == rows_.end() ? std::nullopt : std::optional<Row>(found->second);
}

std::optional<Place> Roadmaps::placeOf(const std::string& id) const {
  return Place::of(valueOf(row(id), "parent"));
}

bool Roadmaps::isAlive(const std::string& id) const {
  return present(row(id));
}

std::vector<std::string> Roadmaps::ids() const {
  std::vector<std::string> ids;
  for (const auto& [id, row] : rows_) ids.push_back(id);
  return ids;
}

std::vector<std::string> Roadmaps::ownedBy(const std::string& tree, const std::string& step) const {
  std::vector<std::string> owned;
  for (const auto& [id, row] : rows_) {
    if (isAlive(id) && placeOf(id) == Place{tree, step}) owned.push_back(id);
  }
  return owned;
}

std::vector<std::string> Roadmaps::under(const std::string& tree) const {
  std::vector<std::string> found;
  std::deque<std::string> holders{tree};
  while (!holders.empty()) {
    const std::string holder = holders.front();
    holders.pop_front();
    for (const auto& [id, row] : rows_) {
      const std::optional<Place> place = placeOf(id);
      if (!isAlive(id) || !place || place->tree != holder || id == tree) continue;
      if (std::find(found.begin(), found.end(), id) != found.end()) continue;
      found.push_back(id);
      holders.push_back(id);
    }
  }
  return found;
}

std::vector<std::string> Roadmaps::branchOf(const std::string& tree, const std::string& step) const {
  std::vector<std::string> branch;
  for (const std::string& id : ownedBy(tree, step)) {
    branch.push_back(id);
    for (const std::string& below : under(id)) branch.push_back(below);
  }
  return branch;
}

std::int64_t Roadmaps::depthOf(const std::string& id) const {
  std::int64_t depth = 0;
  for (std::optional<Place> place = placeOf(id); place && depth <= kMaxDepth + 1; place = placeOf(place->tree)) ++depth;
  return depth;
}

std::vector<Reach> reaches(const Roadmaps& roadmaps, const std::vector<std::string>& subtrees,
                           const std::function<std::string(const std::string& tree)>& reachOf,
                           const std::function<bool(const Place& step)>& stepPresent) {
  const std::set<std::string> distinct(subtrees.begin(), subtrees.end());
  std::vector<std::string> ordered(distinct.begin(), distinct.end());
  std::stable_sort(ordered.begin(), ordered.end(), [&](const std::string& a, const std::string& b) {
    return roadmaps.depthOf(a) < roadmaps.depthOf(b);
  });
  std::map<std::string, std::string> settled;
  std::vector<Reach> changed;
  for (const std::string& id : ordered) {
    const std::optional<Place> place = roadmaps.placeOf(id);
    const bool stands = roadmaps.isAlive(id) && place && stepPresent(*place);
    const auto above = place ? settled.find(place->tree) : settled.end();
    const std::string reach = !stands ? "private" : above != settled.end() ? above->second : reachOf(place->tree);
    settled[id] = reach;
    if (reach != reachOf(id)) changed.push_back(Reach{id, reach});
  }
  return changed;
}

}

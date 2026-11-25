#include "products/roadmap/adoption/Adoption.h"

#include "platform/domain/sync/FractionalIndex.h"
#include "products/roadmap/domain/Crdt.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tree.h"
#include "products/roadmap/sync/RoadmapProduct.h"
#include "products/roadmap/sync/RoadmapRules.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <tuple>
#include <utility>

namespace wm::roadmap::adoption {

using sync::Life;
using sync::LifeState;
using sync::RecordId;
using sync::Reg;
using sync::Row;
using sync::ScopeKey;
using sync::Stamp;

void Tally::add(const std::string& name, std::uint64_t count) {
  if (count > 0) counts_[name] += count;
}

std::uint64_t Tally::operator[](const std::string& name) const {
  const auto found = counts_.find(name);
  return found == counts_.end() ? 0 : found->second;
}

Tally& Tally::operator+=(const Tally& other) {
  for (const auto& [name, count] : other.counts_) add(name, count);
  return *this;
}

Json::Value Tally::toJson() const {
  Json::Value out(Json::objectValue);
  for (const auto& [name, count] : counts_) {
    Json::Value* at = &out;
    std::size_t start = 0;
    for (std::size_t dot = name.find('.'); dot != std::string::npos; dot = name.find('.', start)) {
      at = &(*at)[name.substr(start, dot - start)];
      start = dot + 1;
    }
    (*at)[name.substr(start)] = Json::UInt64(count);
  }
  return out;
}

ReadStamp readStamp(const std::string& text, sync::Ms now) {
  if (text.empty()) return ReadStamp{};
  const std::optional<Hlc> parsed = parseHlc(text);
  if (!parsed) return ReadStamp{StampState::malformed, kLowestServerStamp};
  if (!parsed->isSet()) return ReadStamp{};
  if (parsed->physicalMs > now + kMaxSkewMs) return ReadStamp{StampState::future, kLowestServerStamp};
  return ReadStamp{StampState::kept, *parsed};
}

const char* stampStateName(StampState state) {
  switch (state) {
    case StampState::kept: return "kept";
    case StampState::unset: return "unset";
    case StampState::malformed: return "malformed";
    case StampState::future: return "future";
  }
  return "unset";
}

std::optional<AdoptedLife> lifeOf(const std::string& addedText, const std::string& removedText, sync::Ms now) {
  const ReadStamp added = readStamp(addedText, now);
  const ReadStamp removed = readStamp(removedText, now);
  if (!added.set() && !removed.set()) return std::nullopt;
  const auto asTheOldServerReads = [](const std::string& text) { return text.empty() ? std::optional(Hlc{}) : parseHlc(text); };
  const std::optional<Hlc> oldAdded = asTheOldServerReads(addedText);
  const std::optional<Hlc> oldRemoved = asTheOldServerReads(removedText);
  const bool alive = oldAdded && oldRemoved ? ElementSet{*oldAdded, *oldRemoved}.present() : added.set() && !(removed.stamp > added.stamp);
  return AdoptedLife{Life(alive ? LifeState::alive : LifeState::dead, std::max(added.stamp, removed.stamp)),
                     added.set() ? added.stamp : kLowestServerStamp};
}

std::map<std::string, std::string> stepKeys(const std::vector<OrderedStep>& steps) {
  std::vector<const OrderedStep*> today;
  for (const OrderedStep& step : steps) today.push_back(&step);
  std::sort(today.begin(), today.end(), [](const OrderedStep* a, const OrderedStep* b) {
    return std::tie(a->ord, a->created, a->id) < std::tie(b->ord, b->created, b->id);
  });
  std::map<std::string, std::string> keys;
  std::optional<std::string> below;
  for (std::size_t at = 0; at < today.size();) {
    if (sync::isOrderKey(today[at]->ord)) {
      below = today[at]->ord;
      keys.emplace(today[at]->id, today[at]->ord);
      ++at;
      continue;
    }
    std::size_t end = at;
    while (end < today.size() && !sync::isOrderKey(today[end]->ord)) ++end;
    const std::optional<std::string> above = end < today.size() ? std::optional(today[end]->ord) : std::nullopt;
    for (; at < end; ++at) {
      below = sync::between(below, above);
      keys.emplace(today[at]->id, *below);
    }
  }
  return keys;
}

std::map<std::string, std::string> kindKeys(const std::vector<OldKind>& kinds) {
  const auto rank = [](const OldKind& kind) {
    const double value = kind.rank.value.isNumeric() ? kind.rank.value.asDouble() : 0;
    return std::isnan(value) ? std::numeric_limits<double>::infinity() : value;
  };
  std::vector<const OldKind*> today;
  for (const OldKind& kind : kinds) today.push_back(&kind);
  std::sort(today.begin(), today.end(), [&rank](const OldKind* a, const OldKind* b) {
    return std::pair(rank(*a), a->id) < std::pair(rank(*b), b->id);
  });
  std::map<std::string, std::string> keys;
  std::optional<std::string> below;
  for (const OldKind* kind : today) {
    below = sync::between(below, std::nullopt);
    keys.emplace(kind->id, *below);
  }
  return keys;
}

namespace {

constexpr std::size_t kMaxIdChars = 128;
// The visibilities the old tables hold. An unlisted one is adopted as private, as every read of it reads it (domain/Access.h).
const std::set<std::string> kVisibilities{"private", "unlisted", "public"};
const std::set<std::string> kStatuses{"none", "complete", "active", "inProgress"};

// An id a step or a kind takes by its type's domain: 1 to 128 code points.
bool inIdDomain(const std::string& id) {
  const std::size_t points = static_cast<std::size_t>(
      std::count_if(id.begin(), id.end(), [](char c) { return (static_cast<unsigned char>(c) & 0xC0) != 0x80; }));
  return points >= 1 && points <= kMaxIdChars;
}

std::string text(const Json::Value& value) { return value.isString() ? value.asString() : ""; }

std::string colorOf(const Json::Value& value) { return std::string(toString(parseColor(text(value)).value_or(NodeColor::terracotta))); }

// A step's status as the old server reads it: active and inProgress are none, and null stays null.
Json::Value statusOf(const Json::Value& value) {
  if (!value.isString()) return Json::Value();
  const std::optional<std::string> status = normalizeSeedStatus(value.asString());
  return Json::Value(*status);
}

Json::Value parentJson(const read::Parent& parent) {
  Json::Value out(Json::objectValue);
  out["tree"] = parent.tree;
  out["step"] = parent.step;
  return out;
}

// When things happened in one roadmap, in epoch ms: a stamp's time, kept between the roadmap's creation and its last
// change, so no record of it reads as received before it was made or after the roadmap last changed.
struct Times {
  sync::Ms created = 0;
  sync::Ms changed = 0;

  explicit Times(const OldRoadmap& roadmap)
      : created(static_cast<sync::Ms>(std::max<std::int64_t>(roadmap.createdAt, 0))),
        changed(std::max(created, static_cast<sync::Ms>(std::max<std::int64_t>(roadmap.updatedAt, 0)))) {}

  sync::Ms of(const Stamp& stamp) const { return std::clamp<sync::Ms>(stamp.physicalMs, created, changed); }
};

// The registers of one row the plan writes, and the tally of their stamps.
class Registers {
public:
  Registers(Row& row, sync::Ms now, Tally& tally) : row_(row), now_(now), tally_(tally) {}

  // An old register: kept under its stamp, a malformed one's value under the lowest server stamp, and an unset one left
  // unset while it holds the field's default, the lowest server stamp taking any other value it holds.
  ReadStamp put(const std::string& field, const Json::Value& value, const std::string& stamp, const Json::Value& fallback) {
    const ReadStamp read = readStamp(stamp, now_);
    tally_.add(std::string("stamps.") + stampStateName(read.state));
    if (read.set()) {
      row_.lattice.f.insert_or_assign(field, Reg(value, read.stamp));
      return read;
    }
    if (value == fallback) return read;
    tally_.add("stamps.unsetHoldingAValue");
    row_.lattice.f.insert_or_assign(field, Reg(value, kLowestServerStamp));
    return ReadStamp{StampState::unset, kLowestServerStamp};
  }

  // A value roadmap holds under no stamp, or one the move computes: the lowest server stamp.
  void server(const std::string& field, const Json::Value& value) { row_.lattice.f.insert_or_assign(field, Reg(value, kLowestServerStamp)); }

private:
  Row& row_;
  sync::Ms now_;
  Tally& tally_;
};

// Roadmap's registry, whose type order the move numbers rows in, after which each by id, and whose caps it counts.
const sync::TypeDef& typeOf(const std::string& name) {
  const sync::TypeDef* type = engine::registry().type(name);
  if (!type) throw std::logic_error("roadmap's registry declares no type the move writes");
  return *type;
}

std::ptrdiff_t rankOf(const std::string& type) {
  const std::vector<sync::TypeDef>& types = engine::registry().types();
  return std::find_if(types.begin(), types.end(), [&](const sync::TypeDef& each) { return each.name == type; }) - types.begin();
}

// The rows numbered after `base` in the registry's order, then by id, and the scope's seq, the alive count of each capped
// type, and its digest.
void number(ScopePlan& scope, Seq base) {
  std::sort(scope.rows.begin(), scope.rows.end(),
            [](const Row& a, const Row& b) { return std::pair(rankOf(a.t), a.id) < std::pair(rankOf(b.t), b.id); });
  std::vector<Json::Value> hashed;
  scope.seq = base;
  for (Row& row : scope.rows) {
    row.seq = ++scope.seq;
    if (typeOf(row.t).cap && row.alive()) ++scope.counters[row.t];
    hashed.push_back(row.toJson());
  }
  scope.digest = sync::scopeDigest(hashed);
}

}

Survey::Survey(OldDatabase database, Expectation expectation)
    : database_(std::move(database)), expectation_(std::move(expectation)), accounts_(database_.accounts) {
  for (const OldRoadmap& roadmap : database_.roadmaps) byId_.emplace(roadmap.id, &roadmap);
  for (const OldRoadmap& roadmap : database_.roadmaps) place(roadmap.id);
  for (const auto& [id, surveyed] : roadmaps_) {
    if (surveyed.deleted || !surveyed.roadmap->parent) continue;
    const auto holder = roadmaps_.find(surveyed.roadmap->parent->tree);
    if (holder != roadmaps_.end()) holder->second.branches[surveyed.roadmap->parent->step] = id;
  }
  for (const auto& [kind, count] : database_.rowsOfNoRoadmap) tally_.add("notAdopted." + kind + "OfNoRoadmap", count);
  for (const auto& [id, surveyed] : roadmaps_) {
    const OldRoadmap& roadmap = *surveyed.roadmap;
    tally_.add("roadmaps.total");
    tally_.add(roadmap.parent ? "roadmaps.subtrees" : "roadmaps.roots");
    if (roadmap.wholeDocument) tally_.add("roadmaps.wholeDocument");
    if (surveyed.deleted) {
      tally_.add("notAdopted.deletedRoadmaps");
      continue;
    }
    tally_.add("roadmaps.adopted");
    if (!surveyed.readableToday) tally_.add("roadmaps.unreadableToday");
    if (roadmap.ogImage) tally_.add("kept.shareCards");
    if (roadmap.ogVideo) tally_.add("kept.shareVideos");
    tally_.add("kept.activityLines", roadmap.activity);
    if (roadmap.parent) tally_.add(surveyed.stands ? "subtrees.standing" : "subtrees.hidden");
    if (roadmap.unreadableDocument) stop(id, "stop.unreadableDocument");
    for (std::uint64_t repeated = 0; repeated < roadmap.repeatedDocumentIds; ++repeated) stop(id, "stop.idRepeatedInAWholeDocument");
    for (const OldStep& step : roadmap.steps) {
      if (!inIdDomain(step.id)) stop(id, "stop.stepIdOutsideItsDomain");
      if (step.status.value.isString() && !kStatuses.contains(step.status.value.asString())) stop(id, "stop.unknownStepStatus");
    }
    for (const OldKind& kind : roadmap.kinds) {
      if (!inIdDomain(kind.id)) stop(id, "stop.kindIdOutsideItsDomain");
    }
    for (const OldMark& mark : roadmap.marks) {
      if (!accounts_.contains(mark.account)) continue;
      if (!kStatuses.contains(mark.status)) stop(id, "stop.unknownMarkStatus");
      if (!inIdDomain(mark.step)) stop(id, "stop.markedStepIdOutsideItsDomain");
    }
  }
}

namespace {

// Whether the old server parses every stamp a roadmap holds: it throws on one that is no D-1 stamp (roadmapStamp).
bool readableToday(const OldRoadmap& roadmap) {
  const auto parses = [](const std::string& text) { return text.empty() || parseHlc(text).has_value(); };
  const auto stamped = [&](const OldRegister& held) { return parses(held.stamp); };
  if (roadmap.unreadableDocument || !stamped(roadmap.title) || !stamped(roadmap.guide)) return false;
  for (const OldStep& step : roadmap.steps) {
    for (const OldRegister* held : {&step.label, &step.icon, &step.color, &step.ord, &step.status, &step.description, &step.links, &step.opens})
      if (!stamped(*held)) return false;
    if (!parses(step.added) || !parses(step.removed)) return false;
  }
  for (const OldLink& link : roadmap.links)
    if (!parses(link.added) || !parses(link.removed)) return false;
  for (const OldKind& kind : roadmap.kinds) {
    for (const OldRegister* held : {&kind.hue, &kind.label, &kind.description, &kind.rank})
      if (!stamped(*held)) return false;
    if (!parses(kind.added) || !parses(kind.removed)) return false;
  }
  return std::all_of(roadmap.marks.begin(), roadmap.marks.end(), [&](const OldMark& mark) { return parses(mark.stamp); });
}

}

void Survey::stop(const std::string& roadmap, const std::string& reason) {
  stops_.add(reason);
  stoppedBy_.emplace_back(roadmap, reason);
}

// Where `id` sits, read up its parents: its root, whose owner and visibility it takes, whether it or a roadmap above it
// is deleted, and whether every step owning a roadmap on its way down is present. A parent no row holds, a way up that
// meets itself, a root, depth or owner that does not follow from the parent's, or an owning step no row of the parent
// holds stops the move.
void Survey::place(const std::string& id) {
  if (roadmaps_.contains(id)) return;
  const OldRoadmap& roadmap = *byId_.at(id);
  Surveyed& surveyed = roadmaps_[id];
  surveyed.roadmap = &roadmap;
  surveyed.readableToday = readableToday(roadmap);
  if (!wellFormedTreeId(roadmap.id)) stop(id, "stop.roadmapIdOutsideItsPattern");

  std::vector<const OldRoadmap*> up{&roadmap};
  std::set<std::string> seen{roadmap.id};
  while (up.back()->parent) {
    const auto parent = byId_.find(up.back()->parent->tree);
    if (parent == byId_.end()) {
      stop(id, "stop.subtreeOfAMissingRoadmap");
      return;
    }
    if (!seen.insert(parent->first).second) {
      stop(id, "stop.placeLoops");
      return;
    }
    up.push_back(parent->second);
  }
  const OldRoadmap& root = *up.back();
  for (std::size_t at = 0; at + 1 < up.size(); ++at) {
    if (up[at]->root != root.id || up[at]->depth != up[at + 1]->depth + 1 || up[at]->owner != root.owner) {
      stop(id, "stop.placeDisagreesWithItsParent");
      return;
    }
  }
  if (root.root != root.id || root.depth != 0) stop(id, "stop.rootDisagreesWithItself");
  if (roadmap.depth > engine::kMaxDepth) stop(id, "stop.deeperThanTheLimit");

  for (const OldRoadmap* each : up) {
    if (!each->deletedAt) continue;
    surveyed.deleted = true;
    surveyed.deletedAt = *each->deletedAt;
    break;
  }

  if (root.owner && accounts_.contains(*root.owner)) surveyed.owner = UserId{*root.owner};
  else if (expectation_.ownerless.contains(root.id)) surveyed.owner = kHouseAccount;
  else {
    stop(id, roadmap.parent ? "stop.subtreeOfAnUnexpectedOwnerlessRoadmap" : "stop.unexpectedOwnerlessRoadmap");
    return;
  }
  if (!roadmap.parent && surveyed.owner == kHouseAccount) tally_.add(surveyed.deleted ? "ownerless.expectedDeleted" : "ownerless.expected");

  if (!kVisibilities.contains(root.visibility)) {
    stop(id, "stop.unknownVisibility");
    return;
  }
  surveyed.visibility = toString(parseVisibility(root.visibility));
  if (surveyed.deleted) return;

  surveyed.stands = true;
  for (std::size_t at = 0; at + 1 < up.size(); ++at) {
    const OldRoadmap& holder = *up[at + 1];
    const auto owning = std::find_if(holder.steps.begin(), holder.steps.end(),
                                     [&](const OldStep& step) { return step.id == up[at]->parent->step; });
    const std::optional<AdoptedLife> life =
        owning == holder.steps.end() ? std::nullopt : lifeOf(owning->added, owning->removed, expectation_.now);
    if (!life) {
      if (at == 0) stop(id, "stop.subtreeOfAStepNoRowHolds");
      surveyed.stands = false;
      continue;
    }
    if (!life->life.alive()) surveyed.stands = false;
  }
  surveyed.reach = surveyed.stands ? surveyed.visibility : "private";
}

namespace {

// One adopted roadmap's tree scope and overlays, and its `tree` record.
class RoadmapPlanner {
public:
  RoadmapPlanner(const Survey& survey, const Surveyed& surveyed, Tally& tally)
      : survey_(survey), surveyed_(surveyed), roadmap_(*surveyed.roadmap), times_(roadmap_), now_(survey.expectation().now), tally_(tally) {}

  RoadmapPlan plan() {
    RoadmapPlan planned{.id = roadmap_.id, .record = record(), .tree = ScopePlan{.key = ScopeKey::tree(roadmap_.id), .owner = surveyed_.owner}};
    planned.tree.governedBy = ScopeKey::product(surveyed_.owner, "roadmap").text() + "#tree#" + roadmap_.id;
    if (surveyed_.deleted) {
      planned.tree.deadAt = static_cast<sync::Ms>(std::max<std::int64_t>(surveyed_.deletedAt, 0));
      return planned;
    }
    planned.tree.rows.push_back(meta());
    adoptSteps(planned.tree.rows);
    adoptLinks(planned.tree.rows);
    adoptKinds(planned.tree.rows);
    number(planned.tree, roadmap_.head);
    planned.tree.open = surveyed_.reach != "private";
    if (roadmap_.head > 0) tally_.add("seq.continuedAboveAHead");
    countCaps(planned.tree);
    adoptOverlays(planned.overlays);
    return planned;
  }

private:
  Row record() {
    Row row("tree", RecordId(roadmap_.id));
    row.lattice.born = kLowestServerStamp;
    row.lattice.life = Life(surveyed_.deleted ? LifeState::dead : LifeState::alive, kLowestServerStamp);
    if (!surveyed_.deleted && roadmap_.parent) row.lattice.f.emplace("parent", Reg(parentJson(*roadmap_.parent), kLowestServerStamp));
    row.rc = times_.created;
    row.ru = surveyed_.deleted ? std::max(times_.created, static_cast<sync::Ms>(std::max<std::int64_t>(surveyed_.deletedAt, 0))) : times_.changed;
    return row;
  }

  Row meta() {
    Row row("meta", RecordId(std::string("meta")));
    Registers registers(row, now_, tally_);
    registers.put("title", roadmap_.title.value, roadmap_.title.stamp, Json::Value(""));
    registers.put("guide", roadmap_.guide.value, roadmap_.guide.stamp, Json::Value(""));
    if (roadmap_.guideInherited) registers.server("guideInherited", true);
    if (!roadmap_.parent) registers.server("visibility", surveyed_.visibility);
    registers.server("reach", surveyed_.reach);
    if (roadmap_.parent) {
      registers.server("root", roadmap_.root);
      registers.server("parent", parentJson(*roadmap_.parent));
      registers.server("depth", Json::Int64(roadmap_.depth));
    }
    if (roadmap_.forkedFrom) registers.server("forkedFrom", *roadmap_.forkedFrom);
    row.rc = times_.created;
    row.ru = times_.changed;
    return row;
  }

  void adoptSteps(std::vector<Row>& rows) {
    std::vector<OrderedStep> ordered;
    std::map<std::string, AdoptedLife> lives;
    for (const OldStep& step : roadmap_.steps) {
      const std::optional<AdoptedLife> life = lifeOf(step.added, step.removed, now_);
      if (!life) {
        tally_.add("notAdopted.stepsWithNeitherStamp");
        continue;
      }
      countLife(step.added, step.removed);
      lives.emplace(step.id, *life);
      ordered.push_back(OrderedStep{step.id, text(step.ord.value), life->born});
    }
    const std::map<std::string, std::string> keys = stepKeys(ordered);
    for (const OldStep& step : roadmap_.steps) {
      const auto life = lives.find(step.id);
      if (life == lives.end()) continue;
      adopted_.insert(step.id);
      Row row("node", RecordId(step.id));
      row.lattice.born = life->second.born;
      row.lattice.life = life->second.life;
      Registers registers(row, now_, tally_);
      Stamp newest = std::max(life->second.born, life->second.life.stamp);
      const auto keep = [&](const ReadStamp& read) { newest = std::max(newest, read.stamp); };
      keep(registers.put("label", Json::Value(text(step.label.value)), step.label.stamp, Json::Value("")));
      keep(registers.put("icon", Json::Value(text(step.icon.value)), step.icon.stamp, Json::Value("")));
      if (step.color.value.isString() && !parseColor(step.color.value.asString())) tally_.add("values.unknownColorReadAsTerracotta");
      keep(registers.put("color", Json::Value(colorOf(step.color.value)), step.color.stamp, Json::Value("terracotta")));
      const std::string& key = keys.at(step.id);
      if (key != text(step.ord.value)) tally_.add(text(step.ord.value).empty() ? "ord.emptyGivenAKey" : "ord.malformedGivenAKey");
      const ReadStamp ordStamp = readStamp(step.ord.stamp, now_);
      tally_.add(std::string("stamps.") + stampStateName(ordStamp.state));
      row.lattice.f.insert_or_assign("ord", Reg(key, ordStamp.state == StampState::kept ? ordStamp.stamp : kLowestServerStamp));
      keep(ordStamp);
      if (step.status.value.isString() && step.status.value.asString() != *normalizeSeedStatus(step.status.value.asString()))
        tally_.add("values.statusReadAsNone");
      keep(registers.put("status", statusOf(step.status.value), step.status.stamp, Json::Value()));
      keep(registers.put("description", Json::Value(text(step.description.value)), step.description.stamp, Json::Value("")));
      keep(registers.put("links", step.links.value, step.links.stamp, Json::Value(Json::arrayValue)));
      if (const auto owned = surveyed_.branches.find(step.id); owned != surveyed_.branches.end()) {
        registers.server("branch", owned->second);
        tally_.add("steps.owningASubtree");
      }
      row.rc = times_.of(life->second.born);
      row.ru = std::max(row.rc, times_.of(newest));
      tally_.add(life->second.life.alive() ? "steps.alive" : "steps.dead");
      rows.push_back(std::move(row));
    }
  }

  void adoptLinks(std::vector<Row>& rows) {
    for (const OldLink& link : roadmap_.links) {
      if (link.from == link.to) {
        tally_.add("notAdopted.linksFromAStepToItself");
        continue;
      }
      if (!adopted_.contains(link.from) || !adopted_.contains(link.to)) {
        tally_.add("notAdopted.linksToAnIdNoStepHolds");
        continue;
      }
      const std::optional<AdoptedLife> life = lifeOf(link.added, link.removed, now_);
      if (!life) {
        tally_.add("notAdopted.linksWithNeitherStamp");
        continue;
      }
      countLife(link.added, link.removed);
      Json::Value ends(Json::arrayValue);
      ends.append(link.from);
      ends.append(link.to);
      Row row("edge", RecordId(ends));
      row.lattice.life = life->life;
      row.rc = times_.of(life->born);
      row.ru = std::max(row.rc, times_.of(life->life.stamp));
      tally_.add(life->life.alive() ? "links.alive" : "links.dead");
      rows.push_back(std::move(row));
    }
  }

  void adoptKinds(std::vector<Row>& rows) {
    std::vector<OldKind> kinds;
    std::map<std::string, AdoptedLife> lives;
    for (const OldKind& kind : roadmap_.kinds) {
      const std::optional<AdoptedLife> life = lifeOf(kind.added, kind.removed, now_);
      if (!life) {
        tally_.add("notAdopted.kindsWithNeitherStamp");
        continue;
      }
      countLife(kind.added, kind.removed);
      lives.emplace(kind.id, *life);
      kinds.push_back(kind);
    }
    const std::map<std::string, std::string> keys = kindKeys(kinds);
    for (const OldKind& kind : kinds) {
      const AdoptedLife& life = lives.at(kind.id);
      Row row("kind", RecordId(kind.id));
      row.lattice.born = life.born;
      row.lattice.life = life.life;
      Registers registers(row, now_, tally_);
      Stamp newest = std::max(life.born, life.life.stamp);
      const auto keep = [&](const ReadStamp& read) { newest = std::max(newest, read.stamp); };
      if (kind.hue.value.isString() && !parseColor(kind.hue.value.asString())) tally_.add("values.unknownHueReadAsTerracotta");
      keep(registers.put("hue", Json::Value(colorOf(kind.hue.value)), kind.hue.stamp, Json::Value("terracotta")));
      keep(registers.put("label", Json::Value(text(kind.label.value)), kind.label.stamp, Json::Value("")));
      keep(registers.put("description", Json::Value(text(kind.description.value)), kind.description.stamp, Json::Value("")));
      const ReadStamp rank = readStamp(kind.rank.stamp, now_);
      tally_.add(std::string("stamps.") + stampStateName(rank.state));
      row.lattice.f.insert_or_assign("ord", Reg(keys.at(kind.id), rank.state == StampState::kept ? rank.stamp : kLowestServerStamp));
      keep(rank);
      tally_.add("kinds.rankGivenAKey");
      row.rc = times_.of(life.born);
      row.ru = std::max(row.rc, times_.of(newest));
      tally_.add(life.life.alive() ? "kinds.alive" : "kinds.dead");
      rows.push_back(std::move(row));
    }
  }

  // Each account's marks into its overlay, the owner's with the owner's pointers. A mark of no account is not adopted.
  // A mark is a row, so one under no stamp, none included, holds a value: the lowest server stamp takes it.
  void adoptOverlays(std::vector<ScopePlan>& overlays) {
    std::map<std::string, std::vector<Row>> byAccount;
    for (const OldMark& mark : roadmap_.marks) {
      if (!survey_.accounts().contains(mark.account)) {
        tally_.add("notAdopted.marksOfNoAccount");
        continue;
      }
      const bool complete = parseProgressStatus(mark.status).value_or(ProgressStatus::none) == ProgressStatus::complete;
      Json::Value value(Json::objectValue);
      value["status"] = complete ? "complete" : "none";
      value["outOfOrder"] = complete && mark.outOfOrder;
      Row row("progress", RecordId(mark.step));
      Registers(row, now_, tally_).put("mark", value, mark.stamp, Json::Value());
      if (mark.status != value["status"].asString()) tally_.add("values.markStatusReadAsNone");
      row.rc = row.ru = static_cast<sync::Ms>(std::max<std::int64_t>(mark.recordedAt, 0));
      tally_.add("marks.adopted");
      byAccount[mark.account].push_back(std::move(row));
    }
    for (const OldStep& step : roadmap_.steps) {
      const std::string opens = text(step.opens.value);
      if (!adopted_.contains(step.id)) continue;
      if (opens.empty()) {
        if (readStamp(step.opens.stamp, now_).set()) tally_.add("pointers.clearedReadAsNone");
        continue;
      }
      const ReadStamp read = readStamp(step.opens.stamp, now_);
      tally_.add(std::string("stamps.") + stampStateName(read.state));
      const Stamp stamp = read.set() ? read.stamp : kLowestServerStamp;
      Row row("pointer", RecordId(step.id));
      row.lattice.life = Life(LifeState::alive, stamp);
      row.lattice.f.emplace("opens", Reg(opens, stamp));
      row.rc = row.ru = times_.of(stamp);
      tally_.add("pointers.adopted");
      byAccount[surveyed_.owner.str()].push_back(std::move(row));
    }
    for (auto& [account, rows] : byAccount) {
      const UserId reader{account};
      ScopePlan overlay{.key = ScopeKey::overlay(reader, roadmap_.id), .owner = reader, .governedBy = ScopeKey::tree(roadmap_.id).text(),
                        .rows = std::move(rows)};
      number(overlay, 0);
      tally_.add(reader == surveyed_.owner ? "overlays.owners" : "overlays.readers");
      overlays.push_back(std::move(overlay));
    }
  }

  // The add and remove stamps of an adopted step, link or kind, by what the move made of each.
  void countLife(const std::string& added, const std::string& removed) {
    tally_.add(std::string("lifeStamps.") + stampStateName(readStamp(added, now_).state));
    tally_.add(std::string("lifeStamps.") + stampStateName(readStamp(removed, now_).state));
  }

  // A roadmap holding more than a type's cap stands as it is: the cap binds the next create (engine.md §6.5).
  void countCaps(const ScopePlan& scope) {
    for (const auto& [type, count] : scope.counters) {
      if (count > *typeOf(type).cap) tally_.add("roadmaps.pastTheCapOf." + type);
    }
  }

  const Survey& survey_;
  const Surveyed& surveyed_;
  const OldRoadmap& roadmap_;
  Times times_;
  sync::Ms now_;
  Tally& tally_;
  std::set<std::string> adopted_;
};

}

Plan plan(const Survey& survey, const std::optional<std::set<std::string>>& only) {
  Plan planned;
  planned.stops = survey.stops();
  if (survey.stopped()) return planned;
  const auto admitted = [&](const std::string& roadmap, const Row& row) {
    const sync::TypeDef& type = typeOf(row.t);
    for (const auto& [name, reg] : row.lattice.f) {
      if (engine::registry().admitsValue(type.fields.at(name), reg.value)) continue;
      const std::string reason = "stop.outsideItsDomain." + row.t + "." + name;
      planned.stops.add(reason);
      planned.stoppedBy.emplace_back(roadmap, reason);
    }
  };
  std::map<UserId, OwnerPlan> owners;
  for (const auto& [id, surveyed] : survey.roadmaps()) {
    if (only && !only->contains(id)) continue;
    OwnerPlan& owner = owners.try_emplace(surveyed.owner, OwnerPlan{surveyed.owner, {}, {}}).first->second;
    RoadmapPlan roadmap = RoadmapPlanner(survey, surveyed, planned.tally).plan();
    admitted(id, roadmap.record);
    for (const Row& row : roadmap.tree.rows) admitted(id, row);
    for (const ScopePlan& overlay : roadmap.overlays) {
      for (const Row& row : overlay.rows) admitted(id, row);
    }
    owner.roadmaps.push_back(std::move(roadmap));
    owner.readFrom.push_back(*surveyed.roadmap);
  }
  for (auto& [account, owner] : owners) planned.owners.push_back(std::move(owner));
  return planned;
}

}

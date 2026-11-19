#include "products/roadmap/sync/RoadmapDeeds.h"

#include "platform/domain/sync/Jcs.h"
#include "products/roadmap/sync/RoadmapRules.h"

#include <algorithm>
#include <set>

namespace wm::roadmap::engine {

using namespace sync;

namespace {

std::string textOf(const std::optional<Row>& row, const std::string& field) {
  const Json::Value value = valueOf(row, field);
  return value.isString() ? value.asString() : std::string{};
}

NodeColor colorOf(const std::optional<Row>& row, const std::string& field) {
  return parseColor(textOf(row, field)).value_or(NodeColor::terracotta);
}

std::vector<Link> linksOf(const std::optional<Row>& row) {
  std::vector<Link> links;
  for (const Json::Value& link : valueOf(row, "links")) {
    if (link.isObject()) links.push_back(Link{link.get("label", "").asString(), link.get("url", "").asString()});
  }
  return links;
}

bool differs(const Touched& record, const std::string& field) {
  return jcs(valueOf(record.before, field)) != jcs(valueOf(record.after, field));
}

}

std::optional<Command> deedOf(const std::vector<Touched>& records) {
  const auto came = [](const Touched& record) { return !present(record.before) && present(record.after); };
  const auto went = [](const Touched& record) { return present(record.before) && !present(record.after); };
  const auto stayed = [](const Touched& record) { return present(record.before) && present(record.after); };
  const auto typeOf = [](const Touched& record) { return (record.after ? record.after : record.before)->t; };
  const auto idOf = [](const Touched& record) { return (record.after ? record.after : record.before)->id; };

  const bool born = std::any_of(records.begin(), records.end(), [&](const Touched& record) {
    return typeOf(record) == "meta" && !record.before && record.after;
  });
  std::set<std::string> arrived;
  std::set<NodeColor> recoloured;
  std::vector<Command> stepsCame, stepsWent, kindsCame, kindsWent, kindsRecoloured, kindsRenamed, kindsDescribed;
  std::vector<Command> stepsRenamed, stepsRecoloured, linksDrawn, linksTaken;
  bool reordered = false;

  for (const Touched& record : records) {
    if (typeOf(record) != "kind") continue;
    const KindId id{idOf(record).column()};
    if (came(record) && !born) {
      kindsCame.push_back(AddKind{id, colorOf(record.after, "hue"), textOf(record.after, "label"), textOf(record.after, "description")});
    } else if (went(record)) {
      kindsWent.push_back(RemoveKind{id});
    } else if (stayed(record)) {
      if (differs(record, "hue")) {
        kindsRecoloured.push_back(RecolorKind{id, colorOf(record.after, "hue")});
        recoloured.insert(colorOf(record.after, "hue"));
      }
      if (differs(record, "label")) kindsRenamed.push_back(RenameKind{id, textOf(record.after, "label")});
      if (differs(record, "description")) kindsDescribed.push_back(DescribeKind{id, textOf(record.after, "description")});
      reordered = reordered || differs(record, "ord");
    }
  }
  for (const Touched& record : records) {
    if (typeOf(record) != "node") continue;
    const NodeId id{idOf(record).column()};
    if (came(record)) {
      arrived.insert(id.str());
      stepsCame.push_back(CreateNode{id, textOf(record.after, "label"), textOf(record.after, "icon"), colorOf(record.after, "color"), {},
                                     textOf(record.after, "description"), linksOf(record.after)});
    } else if (went(record)) {
      stepsWent.push_back(DeleteNode{id});
    } else if (stayed(record)) {
      if (differs(record, "label")) stepsRenamed.push_back(RenameNode{id, textOf(record.after, "label")});
      if (differs(record, "color") && !recoloured.contains(colorOf(record.after, "color")))
        stepsRecoloured.push_back(SetNodeColor{id, colorOf(record.after, "color")});
    }
  }
  for (const Touched& record : records) {
    if (typeOf(record) != "edge") continue;
    const Json::Value ends = idOf(record).json();
    const NodeId from{ends[0].asString()}, to{ends[1].asString()};
    if (arrived.contains(from.str()) || arrived.contains(to.str())) continue;
    if (came(record)) linksDrawn.push_back(AddEdge{from, to});
    else if (went(record)) linksTaken.push_back(RemoveEdge{from, to});
  }

  std::vector<Command> deeds;
  for (std::vector<Command>* told : {&stepsCame, &stepsWent, &kindsCame, &kindsWent, &kindsRecoloured, &kindsRenamed, &kindsDescribed}) {
    deeds.insert(deeds.end(), told->begin(), told->end());
  }
  if (reordered) deeds.push_back(ReorderKinds{});
  for (std::vector<Command>* told : {&stepsRenamed, &stepsRecoloured, &linksDrawn, &linksTaken}) {
    deeds.insert(deeds.end(), told->begin(), told->end());
  }
  if (deeds.empty()) return std::nullopt;
  if (deeds.size() == 1) return deeds.front();
  return Command{Batch{std::move(deeds)}};
}

}

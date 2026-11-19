#include "products/roadmap/adoption/Audit.h"

#include "products/roadmap/domain/Tree.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <tuple>
#include <utility>

namespace wm::roadmap::adoption {

namespace {

std::string text(const Json::Value& value) { return value.isString() ? value.asString() : ""; }

std::string colorName(const std::string& value) { return std::string(toString(parseColor(value).value_or(NodeColor::terracotta))); }

bool sameLinks(const std::vector<read::StepLink>& a, const std::vector<read::StepLink>& b) {
  return std::equal(a.begin(), a.end(), b.begin(), b.end(),
                    [](const read::StepLink& x, const read::StepLink& y) { return x.url == y.url && x.label == y.label; });
}

bool sameStep(const DocStep& a, const DocStep& b) {
  return std::tie(a.id, a.present, a.label, a.icon, a.color, a.status, a.description, a.opens, a.branch) ==
             std::tie(b.id, b.present, b.label, b.icon, b.color, b.status, b.description, b.opens, b.branch) &&
         sameLinks(a.links, b.links);
}

template <typename Record, typename Same>
bool sameById(const std::vector<Record>& a, const std::vector<Record>& b, Same same) {
  std::map<std::string, const Record*> byId;
  for (const Record& record : b) byId.emplace(record.id, &record);
  if (a.size() != b.size() || byId.size() != b.size()) return false;
  return std::all_of(a.begin(), a.end(), [&](const Record& record) {
    const auto other = byId.find(record.id);
    return other != byId.end() && same(record, *other->second);
  });
}

template <typename Record>
std::vector<std::string> idsOf(const std::vector<Record>& records) {
  std::vector<std::string> ids;
  for (const Record& record : records) ids.push_back(record.id);
  return ids;
}

Json::Value linksJson(const std::vector<read::StepLink>& links) {
  Json::Value out(Json::arrayValue);
  for (const read::StepLink& link : links) {
    Json::Value entry(Json::objectValue);
    entry["url"] = link.url;
    entry["label"] = link.label;
    out.append(entry);
  }
  return out;
}

std::vector<read::StepLink> linksOf(const Json::Value& links) {
  std::vector<read::StepLink> read;
  for (const Json::Value& link : links) read.push_back(read::StepLink{text(link["url"]), text(link["label"])});
  return read;
}

void sortMarks(std::vector<DocMark>& marks) {
  std::sort(marks.begin(), marks.end(), [](const DocMark& a, const DocMark& b) { return std::tie(a.account, a.step) < std::tie(b.account, b.step); });
}

void sortLinks(std::vector<DocLink>& links) {
  std::sort(links.begin(), links.end(), [](const DocLink& a, const DocLink& b) { return std::tie(a.from, a.to) < std::tie(b.from, b.to); });
}

}

Json::Value Document::toJson() const {
  Json::Value out(Json::objectValue);
  out["id"] = id;
  out["owner"] = owner;
  out["title"] = title;
  out["guide"] = guide;
  out["guideInherited"] = guideInherited;
  out["forkedFrom"] = forkedFrom;
  out["root"] = root;
  out["parent"] = Json::Value();
  if (parent) {
    out["parent"]["tree"] = parent->tree;
    out["parent"]["step"] = parent->step;
  }
  out["depth"] = Json::Int64(depth);
  out["visibility"] = visibility;
  out["reach"] = reach;
  out["stands"] = stands;
  out["steps"] = Json::Value(Json::arrayValue);
  for (const DocStep& step : steps) {
    Json::Value entry(Json::objectValue);
    entry["id"] = step.id;
    entry["present"] = step.present;
    entry["label"] = step.label;
    entry["icon"] = step.icon;
    entry["color"] = step.color;
    entry["status"] = step.status;
    entry["description"] = step.description;
    entry["links"] = linksJson(step.links);
    entry["opens"] = step.opens;
    entry["branch"] = step.branch;
    out["steps"].append(entry);
  }
  out["links"] = Json::Value(Json::arrayValue);
  for (const DocLink& link : links) {
    Json::Value entry(Json::objectValue);
    entry["from"] = link.from;
    entry["to"] = link.to;
    entry["present"] = link.present;
    out["links"].append(entry);
  }
  out["kinds"] = Json::Value(Json::arrayValue);
  for (const DocKind& kind : kinds) {
    Json::Value entry(Json::objectValue);
    entry["id"] = kind.id;
    entry["present"] = kind.present;
    entry["hue"] = kind.hue;
    entry["label"] = kind.label;
    entry["description"] = kind.description;
    out["kinds"].append(entry);
  }
  out["marks"] = Json::Value(Json::arrayValue);
  for (const DocMark& mark : marks) {
    Json::Value entry(Json::objectValue);
    entry["account"] = mark.account;
    entry["step"] = mark.step;
    entry["status"] = mark.status;
    entry["outOfOrder"] = mark.outOfOrder;
    entry["at"] = Json::Int64(mark.at);
    out["marks"].append(entry);
  }
  return out;
}

std::vector<std::string> differences(const Document& before, const Document& after) {
  const auto sameKind = [](const DocKind& a, const DocKind& b) {
    return std::tie(a.present, a.hue, a.label, a.description) == std::tie(b.present, b.hue, b.label, b.description);
  };
  const auto sameLink = [](const DocLink& a, const DocLink& b) { return std::tie(a.from, a.to, a.present) == std::tie(b.from, b.to, b.present); };
  const auto sameMark = [](const DocMark& a, const DocMark& b) {
    return std::tie(a.account, a.step, a.status, a.outOfOrder, a.at) == std::tie(b.account, b.step, b.status, b.outOfOrder, b.at);
  };
  const std::map<std::string, bool> same{
      {"owner", before.owner == after.owner},
      {"title", before.title == after.title},
      {"guide", std::tie(before.guide, before.guideInherited) == std::tie(after.guide, after.guideInherited)},
      {"place", std::tie(before.root, before.parent, before.depth, before.forkedFrom) == std::tie(after.root, after.parent, after.depth, after.forkedFrom)},
      {"visibility", before.visibility == after.visibility},
      {"reach", before.reach == after.reach},
      {"standing", before.stands == after.stands},
      {"steps", sameById(before.steps, after.steps, sameStep)},
      {"stepOrder", idsOf(before.steps) == idsOf(after.steps)},
      {"links", std::equal(before.links.begin(), before.links.end(), after.links.begin(), after.links.end(), sameLink)},
      {"kinds", sameById(before.kinds, after.kinds, sameKind)},
      {"kindOrder", idsOf(before.kinds) == idsOf(after.kinds)},
      {"marks", std::equal(before.marks.begin(), before.marks.end(), after.marks.begin(), after.marks.end(), sameMark)},
  };
  std::vector<std::string> differ;
  for (const char* section : kSections) {
    if (!same.at(section)) differ.emplace_back(section);
  }
  return differ;
}

std::map<std::string, Document> documentsBefore(const Survey& survey) {
  const sync::Ms now = survey.expectation().now;
  const auto life = [now](const std::string& added, const std::string& removed) { return lifeOf(readStamp(added, now), readStamp(removed, now)); };
  std::map<std::string, Document> documents;
  for (const auto& [id, surveyed] : survey.roadmaps()) {
    if (surveyed.deleted) continue;
    const OldRoadmap& roadmap = *surveyed.roadmap;
    Document document{.id = id, .owner = surveyed.owner.str(), .title = text(roadmap.title.value), .guide = text(roadmap.guide.value),
                      .guideInherited = roadmap.guideInherited, .forkedFrom = roadmap.forkedFrom.value_or(""), .root = roadmap.root,
                      .parent = roadmap.parent, .depth = roadmap.depth, .visibility = surveyed.visibility, .reach = surveyed.reach,
                      .stands = surveyed.stands};

    struct Today {
      DocStep step;
      std::string ord;
      Hlc created;
    };
    std::vector<Today> steps;
    std::set<std::string> held;
    for (const OldStep& step : roadmap.steps) {
      const std::optional<AdoptedLife> read = life(step.added, step.removed);
      if (!read) continue;
      held.insert(step.id);
      const auto owned = surveyed.branches.find(step.id);
      steps.push_back(Today{DocStep{.id = step.id, .present = read->life.alive(), .label = text(step.label.value), .icon = text(step.icon.value),
                                    .color = colorName(text(step.color.value)),
                                    .status = step.status.value.isString() ? *normalizeSeedStatus(step.status.value.asString()) : "none",
                                    .description = text(step.description.value), .links = linksOf(step.links.value),
                                    .opens = text(step.opens.value), .branch = owned == surveyed.branches.end() ? "" : owned->second},
                            text(step.ord.value), read->born});
    }
    std::sort(steps.begin(), steps.end(),
              [](const Today& a, const Today& b) { return std::tie(a.ord, a.created, a.step.id) < std::tie(b.ord, b.created, b.step.id); });
    for (Today& step : steps) document.steps.push_back(std::move(step.step));

    for (const OldLink& link : roadmap.links) {
      const std::optional<AdoptedLife> read = life(link.added, link.removed);
      if (!read || link.from == link.to || !held.contains(link.from) || !held.contains(link.to)) continue;
      document.links.push_back(DocLink{link.from, link.to, read->life.alive()});
    }
    sortLinks(document.links);

    std::vector<std::pair<double, DocKind>> kinds;
    for (const OldKind& kind : roadmap.kinds) {
      const std::optional<AdoptedLife> read = life(kind.added, kind.removed);
      if (!read) continue;
      const double rank = kind.rank.value.isNumeric() ? kind.rank.value.asDouble() : 0;
      kinds.emplace_back(std::isnan(rank) ? std::numeric_limits<double>::infinity() : rank,
                         DocKind{kind.id, read->life.alive(), colorName(text(kind.hue.value)), text(kind.label.value), text(kind.description.value)});
    }
    std::sort(kinds.begin(), kinds.end(), [](const auto& a, const auto& b) { return std::tie(a.first, a.second.id) < std::tie(b.first, b.second.id); });
    for (auto& [rank, kind] : kinds) document.kinds.push_back(std::move(kind));

    for (const OldMark& mark : roadmap.marks) {
      if (!survey.accounts().contains(mark.account)) continue;
      const bool complete = parseProgressStatus(mark.status).value_or(ProgressStatus::none) == ProgressStatus::complete;
      document.marks.push_back(DocMark{mark.account, mark.step, complete ? "complete" : "none", complete && mark.outOfOrder, mark.recordedAt});
    }
    sortMarks(document.marks);
    documents.emplace(id, std::move(document));
  }
  return documents;
}

std::map<std::string, Document> documentsAfter(const std::vector<EngineRoadmap>& roadmaps) {
  std::vector<read::RoadmapTree> trees;
  std::map<std::string, const EngineRoadmap*> byId;
  for (const EngineRoadmap& roadmap : roadmaps) {
    trees.emplace_back(roadmap.records);
    byId.emplace(roadmap.records.id, &roadmap);
  }
  const read::RoadmapAccount account(std::move(trees));
  std::map<std::string, Document> documents;
  for (const auto& [id, tree] : account.trees()) {
    if (!tree.present || !tree.meta) continue;
    const EngineRoadmap& engine = *byId.at(id);
    const read::RoadmapTree* root = account.tree(tree.meta->root);
    Document document{.id = id, .owner = engine.owner, .title = tree.meta->title, .guide = tree.meta->guide,
                      .guideInherited = tree.meta->guideInherited, .forkedFrom = engine.forkedFrom, .root = tree.meta->root,
                      .parent = tree.parent, .depth = tree.meta->depth,
                      .visibility = root && root->meta ? root->meta->visibility : "", .reach = tree.meta->reach,
                      .stands = account.locationOf(id).standing == read::Standing::standing};
    for (const read::Step& step : tree.nodes) {
      const read::Pointer* pointer = tree.pointerOn(step.id);
      document.steps.push_back(DocStep{.id = step.id, .present = step.present, .label = step.label, .icon = step.icon, .color = step.color,
                                       .status = step.status, .description = step.description, .links = step.links,
                                       .opens = pointer && pointer->present ? pointer->opens : "", .branch = step.branch.value_or("")});
    }
    for (const read::Edge& edge : tree.edges) document.links.push_back(DocLink{edge.from, edge.to, edge.present});
    sortLinks(document.links);
    for (const read::Kind& kind : tree.kinds) document.kinds.push_back(DocKind{kind.id, kind.present, kind.hue, kind.label, kind.description});
    const auto marked = [&](const std::string& account, const read::Mark& mark) {
      document.marks.push_back(DocMark{account, mark.node, mark.status, mark.outOfOrder, mark.recordedAt.value_or(0)});
    };
    for (const auto& [step, mark] : tree.marks) marked(engine.owner, mark);
    for (const auto& [reader, marks] : engine.otherMarks) {
      for (const read::Mark& mark : marks) marked(reader, mark);
    }
    sortMarks(document.marks);
    documents.emplace(id, std::move(document));
  }
  return documents;
}

}

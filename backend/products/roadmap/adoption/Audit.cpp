#include "products/roadmap/adoption/Audit.h"

#include "products/roadmap/domain/Crdt.h"
#include "products/roadmap/domain/Tree.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <tuple>
#include <utility>

namespace wm::roadmap::adoption {

namespace {

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

std::map<std::string, Document> documentsBefore(const std::vector<OldReading>& readings, const Expectation& expectation,
                                                const std::set<std::string>& accounts) {
  std::map<std::string, Document> documents;
  for (const OldReading& reading : readings) {
    const StoredTree& stored = reading.stored;
    const TreeAccess& access = reading.access.access;
    std::string owner;
    if (access.owner && accounts.contains(access.owner->str())) owner = access.owner->str();
    else if (expectation.ownerless.contains(access.root.str())) owner = kHouseAccount.str();
    std::optional<read::Parent> parent;
    if (const std::optional<OwningStep> place = access.parent()) parent = read::Parent{place->tree.str(), place->step.str()};
    const std::string visibility = toString(access.visibility);
    Document document{.id = reading.id, .owner = owner, .title = stored.title.value, .guide = stored.guide.value,
                      .guideInherited = stored.guideInherited, .forkedFrom = reading.forkedFrom.value_or(""), .root = access.root.str(),
                      .parent = parent, .depth = static_cast<std::int64_t>(access.path.size()), .visibility = visibility,
                      .reach = reading.access.stands ? visibility : "private", .stands = reading.access.stands};

    std::vector<const NodeStateEntry*> today;
    for (const NodeStateEntry& node : stored.state.nodes) {
      if (node.createdAt.isSet() || node.deletedAt.isSet()) today.push_back(&node);
    }
    std::sort(today.begin(), today.end(), [](const NodeStateEntry* a, const NodeStateEntry* b) {
      return std::tie(a->order, a->createdAt, a->id) < std::tie(b->order, b->createdAt, b->id);
    });
    std::set<std::string> held;
    for (const NodeStateEntry* node : today) {
      held.insert(node->id.str());
      std::vector<read::StepLink> links;
      for (const Link& link : node->links) links.push_back(read::StepLink{link.url, link.label});
      const auto owned = stored.subtrees.find(node->id);
      document.steps.push_back(DocStep{.id = node->id.str(), .present = ElementSet{node->createdAt, node->deletedAt}.present(),
                                       .label = node->label, .icon = node->icon, .color = std::string(toString(node->color)),
                                       .status = node->status.value_or("none"), .description = node->description, .links = links,
                                       .opens = node->opens.str(), .branch = owned == stored.subtrees.end() ? "" : owned->second.str()});
    }

    for (const EdgeStateEntry& edge : stored.state.edges) {
      const bool recorded = edge.addedAt.isSet() || edge.removedAt.isSet();
      if (!recorded || edge.edge.from == edge.edge.to || !held.contains(edge.edge.from.str()) || !held.contains(edge.edge.to.str())) continue;
      document.links.push_back(DocLink{edge.edge.from.str(), edge.edge.to.str(), ElementSet{edge.addedAt, edge.removedAt}.present()});
    }
    sortLinks(document.links);

    std::vector<const KindStateEntry*> kinds;
    for (const KindStateEntry& kind : stored.legend.kinds) {
      if (kind.createdAt.isSet() || kind.deletedAt.isSet()) kinds.push_back(&kind);
    }
    const auto rank = [](const KindStateEntry* kind) { return std::isnan(kind->rank) ? std::numeric_limits<double>::infinity() : kind->rank; };
    std::sort(kinds.begin(), kinds.end(), [&](const KindStateEntry* a, const KindStateEntry* b) {
      return std::pair(rank(a), a->id) < std::pair(rank(b), b->id);
    });
    for (const KindStateEntry* kind : kinds)
      document.kinds.push_back(DocKind{kind->id.str(), ElementSet{kind->createdAt, kind->deletedAt}.present(), std::string(toString(kind->hue)),
                                       kind->label, kind->description});

    for (const auto& [account, progress] : reading.marks) {
      for (const auto& [step, mark] : progress.marks)
        document.marks.push_back(DocMark{account, step.str(), progressStatusName(mark.status), mark.outOfOrder,
                                         static_cast<std::int64_t>(mark.markedAt)});
    }
    sortMarks(document.marks);
    documents.emplace(reading.id, std::move(document));
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

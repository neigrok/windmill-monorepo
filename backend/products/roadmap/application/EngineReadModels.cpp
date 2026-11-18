#include "products/roadmap/application/EngineReadModels.h"

#include "products/roadmap/domain/TreeSummary.h"

#include <algorithm>
#include <utility>

namespace wm {

namespace read = roadmap::read;

namespace {

read::RoadmapAccount accountOf(AccountRoadmaps roadmaps) {
  std::vector<read::RoadmapTree> trees;
  for (read::TreeRecords& records : roadmaps.trees) trees.emplace_back(std::move(records));
  return read::RoadmapAccount(std::move(trees));
}

NodeColor colorOf(const std::string& name) { return parseColor(name).value_or(NodeColor::terracotta); }

std::uint64_t dateOf(const read::Instant& at) { return at ? static_cast<std::uint64_t>(*at) : 0; }

// A standing roadmap as the feed and the gallery read a tree: its present steps in authored order, each after the steps
// it follows (D-5), named as its place names it.
TreeData treeDataOf(const read::RoadmapAccount& account, const std::string& id) {
  const read::RoadmapTree& tree = *account.tree(id);
  const read::FollowGraph graph = *account.graph(id);
  TreeData data;
  data.id = TreeId{id};
  data.title = account.locationOf(id).title.value_or("");
  data.guide = tree.meta.guide;
  for (const std::string& stepId : graph.ids()) {
    const read::Step& step = *tree.step(stepId);
    NodeSpec node;
    node.id = NodeId{step.id};
    node.label = step.label;
    node.icon = step.icon;
    node.color = colorOf(step.color);
    node.order = step.ord;
    for (const read::Followed& followed : graph.followed(stepId)) node.prerequisites.push_back(NodeId{followed.id});
    node.description = step.description;
    for (const read::StepLink& link : step.links) node.links.push_back(Link{link.label, link.url});
    data.nodes.push_back(std::move(node));
  }
  for (const read::Kind& kind : tree.kinds)
    if (kind.present) data.kinds.push_back(Kind{KindId{kind.id}, colorOf(kind.hue), kind.label, kind.description});
  return data;
}

ProgressMark markOf(const read::Mark& mark) {
  return ProgressMark{parseProgressStatus(mark.status).value_or(ProgressStatus::none), mark.stamp, dateOf(mark.recordedAt),
                      mark.outOfOrder};
}

// readerView's answer over the read domain: the owner's marks, but on a step that opens a roadmap still read (its
// opening not dangling), which is complete exactly when the roadmap it opens is, dated as the read domain dates it.
Progress shownToReaders(const read::RoadmapAccount& account, const std::string& id) {
  const read::RoadmapTree& tree = *account.tree(id);
  std::set<std::string> opening;
  for (const read::Opening& each : account.openingsOf(id))
    if (each.status != read::OpeningStatus::dangling) opening.insert(each.node);
  Progress shown;
  for (const auto& [node, mark] : tree.marks)
    if (!opening.contains(node)) shown.record(NodeId{node}, markOf(mark));
  const std::set<std::string> completed = account.completedNodes(id);
  const read::Progress progress = *account.progress(id);
  for (const read::DatedStep& dated : progress.dates) {
    if (!opening.contains(dated.node) || !completed.contains(dated.node)) continue;
    const read::Mark* own = tree.markOn(dated.node);
    const Hlc at = own && own->status == "complete" ? own->stamp : Hlc{};
    shown.record(NodeId{dated.node}, ProgressMark{ProgressStatus::complete, at, dateOf(dated.at)});
  }
  return shown;
}

std::vector<SubtreeCount> subtreesOf(const read::RoadmapAccount& account, const std::string& id) {
  std::vector<SubtreeCount> subtrees;
  for (const read::Opening& opening : account.openingsOf(id)) {
    if (opening.kind != read::OpeningKind::subtree || opening.status != read::OpeningStatus::loaded) continue;
    const read::Counts counts = *account.counts(opening.tree);
    subtrees.push_back(SubtreeCount{NodeId{opening.node}, TreeId{opening.tree}, counts.done, counts.total});
  }
  return subtrees;
}

std::uint64_t lastMarkedAt(const read::RoadmapTree& tree) {
  std::uint64_t latest = 0;
  for (const auto& [node, mark] : tree.marks) latest = std::max(latest, dateOf(mark.recordedAt));
  return latest;
}

std::uint64_t editedAtOf(const std::map<std::string, std::uint64_t>& editedAt, const std::string& id) {
  const auto found = editedAt.find(id);
  return found == editedAt.end() ? 0 : found->second;
}

}

EngineReadModels::EngineReadModels(RoadmapRecords& records, OpLog& activity) : records_(records), activity_(activity) {}

std::optional<ReadableRoadmap> EngineReadModels::open(const TreeId& tree, const std::optional<UserId>& caller) {
  const std::optional<UserId> owner = records_.ownerOf(tree);
  if (!owner) return std::nullopt;
  read::RoadmapAccount account = accountOf(records_.roadmapsOf(*owner));
  if (account.locationOf(tree.str()).standing != read::Standing::standing) return std::nullopt;
  const bool mine = caller && *caller == *owner;
  if (!mine && parseVisibility(account.tree(tree.str())->meta.reach) == Visibility::private_) return std::nullopt;
  return ReadableRoadmap{tree, *owner, mine, std::move(account)};
}

std::vector<ActivityEvent> EngineReadModels::activity(const ReadableRoadmap& roadmap, Seq since, std::size_t limit) {
  return activityFeed(treeDataOf(roadmap.account, roadmap.tree.str()), activity_.since(roadmap.tree, since), limit);
}

ShownProgress EngineReadModels::progress(const ReadableRoadmap& roadmap) {
  const std::string& id = roadmap.tree.str();
  ShownProgress shown{Progress{}, subtreesOf(roadmap.account, id)};
  if (!roadmap.mine) {
    shown.progress = shownToReaders(roadmap.account, id);
    return shown;
  }
  for (const auto& [node, mark] : roadmap.account.tree(id)->marks) shown.progress.record(NodeId{node}, markOf(mark));
  return shown;
}

SharedRoadmap EngineReadModels::shared(const ReadableRoadmap& roadmap) {
  const std::string& id = roadmap.tree.str();
  return SharedRoadmap{roadmap.account.locationOf(id).title.value_or(""), roadmap.account.counts(id)->total,
                       parseVisibility(roadmap.account.tree(id)->meta.reach), records_.lineageOf(roadmap.tree)};
}

std::vector<WallCandidate> EngineReadModels::wall() {
  std::map<UserId, std::vector<ListedRoot>> byOwner;
  for (ListedRoot& root : records_.publicRoots()) byOwner[root.owner].push_back(std::move(root));
  std::vector<WallCandidate> candidates;
  for (const auto& [owner, roots] : byOwner) {
    AccountRoadmaps roadmaps = records_.roadmapsOf(owner);
    const std::map<std::string, std::uint64_t> editedAt = std::move(roadmaps.editedAt);
    const read::RoadmapAccount account = accountOf(std::move(roadmaps));
    for (const ListedRoot& root : roots) {
      if (!account.counts(root.id.str())) continue;
      candidates.push_back(WallCandidate{treeDataOf(account, root.id.str()), owner, shownToReaders(account, root.id.str()),
                                         editedAtOf(editedAt, root.id.str()), root.lineage.forkCount, root.lineage.sourceTitle});
    }
  }
  return candidates;
}

std::set<TreeId> EngineReadModels::forkedSources(const UserId& viewer) { return records_.forkedSources(viewer); }

std::vector<TreeReadiness> EngineReadModels::readiness(const UserId& owner) {
  AccountRoadmaps roadmaps = records_.roadmapsOf(owner);
  const std::map<std::string, std::uint64_t> editedAt = std::move(roadmaps.editedAt);
  const read::RoadmapAccount account = accountOf(std::move(roadmaps));
  std::vector<TreeReadiness> readiness;
  for (const auto& [id, tree] : account.trees()) {
    if (tree.parent) continue;
    const std::optional<read::FollowGraph> graph = account.graph(id);
    if (!graph) continue;
    const read::Counts counts = *account.counts(id);
    TreeReadiness row;
    row.id = TreeId{id};
    row.title = tree.meta.title;
    row.lastActivityAtMs = lastActiveAt(editedAtOf(editedAt, id), lastMarkedAt(tree));
    row.total = static_cast<int>(counts.total);
    row.done = static_cast<int>(counts.done);
    std::vector<std::string> ready;
    for (const std::string& step : graph->ids())
      if (graph->state(step) == read::StepState::available) ready.push_back(step);
    std::sort(ready.begin(), ready.end());
    for (const std::string& step : ready) {
      const read::Step& held = *tree.step(step);
      row.ready.push_back(ReadyStep{NodeId{step}, held.label, colorOf(held.color)});
    }
    readiness.push_back(std::move(row));
  }
  return readiness;
}

}

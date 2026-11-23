#include "products/roadmap/domain/read/RoadmapAccount.h"

#include <algorithm>
#include <stdexcept>

namespace wm::roadmap::read {

const char* standingName(Standing standing) {
  switch (standing) {
    case Standing::standing: return "standing";
    case Standing::hidden: return "hidden";
    case Standing::unknown: return "unknown";
  }
  return "unknown";
}

const char* openingKindName(OpeningKind kind) { return kind == OpeningKind::subtree ? "subtree" : "pointer"; }

const char* openingStatusName(OpeningStatus status) {
  switch (status) {
    case OpeningStatus::loaded: return "loaded";
    case OpeningStatus::unread: return "unread";
    case OpeningStatus::unknown: return "unknown";
    case OpeningStatus::dangling: return "dangling";
  }
  return "unknown";
}

std::optional<RoadmapAccount::LatestMark> RoadmapAccount::later(const std::optional<LatestMark>& a,
                                                                const std::optional<LatestMark>& b) {
  if (!a) return b;
  if (!b) return a;
  return a->stamp < b->stamp ? b : a;
}

RoadmapAccount::RoadmapAccount(std::vector<RoadmapTree> trees) {
  const std::size_t given = trees.size();
  for (RoadmapTree& tree : trees) {
    const std::string id = tree.id;
    trees_.emplace(id, std::move(tree));
  }
  if (trees_.size() != given) throw std::invalid_argument("Duplicate normalized tree identity");
  for (const auto& [id, tree] : trees_) locate(id);

  std::vector<std::string> ready;
  for (const auto& [id, tree] : trees_) {
    if (locations_.at(id).standing != Standing::standing || tree.read != Read::loaded) continue;
    std::vector<Opening> openings;
    std::vector<StaleBranch> stale;
    std::int64_t pending = 0;
    for (const Step& node : tree.nodes) pending += node.present ? 1 : 0;
    std::optional<LatestMark> latest;
    for (const Step& node : tree.nodes) {
      if (!node.present) continue;
      const Pointer* pointer = tree.pointerOn(node.id);
      std::optional<std::string> branch = node.branch;
      if (branch) {
        const RoadmapTree* child = this->tree(*branch);
        const auto place = locations_.find(*branch);
        const bool hidden = place != locations_.end() && place->second.standing == Standing::hidden;
        const bool misplaced = child && child->read == Read::loaded &&
                               !(child->parent && child->parent->tree == id && child->parent->step == node.id);
        if (child && (hidden || misplaced)) {
          stale.push_back(StaleBranch{node.id, *branch});
          branch.reset();
        }
      }
      const std::optional<std::string> target =
          branch ? branch : pointer && pointer->present ? std::optional<std::string>(pointer->opens) : std::nullopt;
      if (target) {
        const OpeningKind kind = branch ? OpeningKind::subtree : OpeningKind::pointer;
        const RoadmapTree* opened = this->tree(*target);
        const auto place = locations_.find(*target);
        OpeningStatus status = OpeningStatus::unknown;
        if (opened) {
          const bool allowed = kind == OpeningKind::pointer
                                   ? !opened->parent
                                   : opened->read == Read::unread ||
                                         (opened->parent && opened->parent->tree == id && opened->parent->step == node.id);
          const bool hidden = place != locations_.end() && place->second.standing == Standing::hidden;
          const bool standing = place != locations_.end() && place->second.standing == Standing::standing;
          if (!allowed || hidden) status = OpeningStatus::dangling;
          else if (standing) status = opened->read == Read::loaded ? OpeningStatus::loaded : OpeningStatus::unread;
        }
        openings.push_back(Opening{node.id, kind, *target, status});
        if (status != OpeningStatus::dangling) {
          if (status == OpeningStatus::loaded || status == OpeningStatus::unread)
            openers_[*target].push_back(Opener{id, node.id});
          continue;
        }
      }
      const Mark* mark = tree.markOn(node.id);
      if (!mark || mark->status != "complete") continue;
      --pending;
      if (mark->stamp.isSet())
        latest = later(latest, LatestMark{mark->stamp, mark->at()});
    }
    const bool hasSteps = std::any_of(tree.nodes.begin(), tree.nodes.end(), [](const Step& step) { return step.present; });
    openings_[id] = std::move(openings);
    staleBranches_[id] = std::move(stale);
    pending_[id] = pending;
    latestMarks_[id] = latest;
    if (hasSteps && pending == 0) ready.push_back(id);
  }
  while (!ready.empty()) {
    const std::string id = ready.back();
    ready.pop_back();
    if (complete_.contains(id)) continue;
    complete_.insert(id);
    const auto openers = openers_.find(id);
    if (openers == openers_.end()) continue;
    for (const Opener& opener : openers->second) {
      const std::int64_t remaining = pending_[opener.tree] - 1;
      pending_[opener.tree] = remaining;
      latestMarks_[opener.tree] = later(latestMarks_[opener.tree], latestMarks_[id]);
      if (remaining == 0) ready.push_back(opener.tree);
    }
  }

  std::vector<std::string> standing;
  std::map<std::string, std::size_t> slots;
  for (const auto& [id, tree] : trees_)
    if (locations_.at(id).standing == Standing::standing) {
      slots.emplace(id, standing.size());
      standing.push_back(id);
    }
  std::vector<std::vector<std::size_t>> adjacency(standing.size());
  for (std::size_t slot = 0; slot < standing.size(); ++slot) {
    const auto openers = openers_.find(standing[slot]);
    if (openers == openers_.end()) continue;
    for (const Opener& opener : openers->second) {
      const auto found = slots.find(opener.tree);
      if (found != slots.end()) adjacency[slot].push_back(found->second);
    }
  }
  for (const std::vector<std::size_t>& group : components(adjacency).groups) {
    const bool selfLoop = std::find(adjacency[group[0]].begin(), adjacency[group[0]].end(), group[0]) != adjacency[group[0]].end();
    if (group.size() <= 1 && !selfLoop) continue;
    std::vector<std::string> loop;
    for (const std::size_t slot : group) loop.push_back(standing[slot]);
    std::sort(loop.begin(), loop.end());
    loops_.push_back(std::move(loop));
  }
  std::stable_sort(loops_.begin(), loops_.end(), [](const auto& a, const auto& b) { return a[0] < b[0]; });
  for (std::size_t index = 0; index < loops_.size(); ++index)
    for (const std::string& id : loops_[index]) loopOf_[id] = index;
}

const RoadmapTree* RoadmapAccount::tree(const std::string& id) const {
  const auto found = trees_.find(id);
  return found == trees_.end() ? nullptr : &found->second;
}

Location RoadmapAccount::locationOf(const std::string& id) const {
  const auto found = locations_.find(id);
  return found == locations_.end() ? Location{} : found->second;
}

const std::vector<Opening>& RoadmapAccount::openingsOf(const std::string& id) const {
  static const std::vector<Opening> kNone;
  const auto found = openings_.find(id);
  return found == openings_.end() ? kNone : found->second;
}

const std::vector<StaleBranch>& RoadmapAccount::staleBranchesOf(const std::string& id) const {
  static const std::vector<StaleBranch> kNone;
  const auto found = staleBranches_.find(id);
  return found == staleBranches_.end() ? kNone : found->second;
}

bool RoadmapAccount::sharesALoop(const std::string& a, const std::string& b) const {
  const auto first = loopOf_.find(a);
  const auto second = loopOf_.find(b);
  return first != loopOf_.end() && second != loopOf_.end() && first->second == second->second;
}

Location RoadmapAccount::locate(const std::string& id) {
  if (const auto known = locations_.find(id); known != locations_.end()) return known->second;
  std::vector<const RoadmapTree*> path;
  std::set<std::string> seen;
  std::string current = id;
  Location base;
  while (!seen.contains(current)) {
    seen.insert(current);
    if (const auto known = locations_.find(current); known != locations_.end()) {
      base = known->second;
      break;
    }
    const RoadmapTree* tree = this->tree(current);
    if (!tree) break;
    // D-3: a root stands once its tree scope holds its meta; one read without it, a creation or a fork under way, does not.
    if (!tree->present || (!tree->parent && tree->read == Read::loaded && !tree->meta)) {
      base = Location{Standing::hidden, std::nullopt, std::nullopt};
      locations_[current] = base;
      break;
    }
    if (!tree->parent) {
      base = Location{Standing::standing, Place{tree->id, std::nullopt, {}, 0},
                      tree->read == Read::loaded && tree->meta ? std::optional<std::string>(tree->meta->title) : std::nullopt};
      locations_[current] = base;
      break;
    }
    path.push_back(tree);
    current = tree->parent->tree;
  }
  for (auto below = path.rbegin(); below != path.rend(); ++below) {
    const RoadmapTree& tree = **below;
    const Parent& parent = *tree.parent;
    const RoadmapTree* parentTree = this->tree(parent.tree);
    const Step* step = parentTree ? parentTree->step(parent.step) : nullptr;
    if (base.standing == Standing::standing && !(parentTree && parentTree->read == Read::loaded)) {
      base = Location{};
    } else if (base.standing == Standing::standing && !(step && step->present)) {
      base = Location{Standing::hidden, std::nullopt, std::nullopt};
    } else if (base.place && step) {
      Place place{base.place->root, parent, base.place->path, base.place->depth + 1};
      place.path.push_back(PlaceStep{parent.tree, parent.step, base.title});
      base = Location{Standing::standing, std::move(place), step->label};
    }
    locations_[tree.id] = base;
  }
  const auto found = locations_.find(id);
  return found == locations_.end() ? base : found->second;
}

std::optional<Counts> RoadmapAccount::counts(const std::string& id) const {
  const RoadmapTree* tree = this->tree(id);
  if (!tree || tree->read != Read::loaded || locationOf(id).standing != Standing::standing) return std::nullopt;
  const std::size_t total = std::count_if(tree->nodes.begin(), tree->nodes.end(), [](const Step& step) { return step.present; });
  const auto pending = pending_.find(id);
  const std::int64_t left = pending == pending_.end() ? static_cast<std::int64_t>(total) : pending->second;
  return Counts{static_cast<std::size_t>(static_cast<std::int64_t>(total) - left), total};
}

std::set<std::string> RoadmapAccount::completedNodes(const std::string& id) const {
  std::set<std::string> completed;
  const RoadmapTree* tree = this->tree(id);
  if (!tree) return completed;
  std::map<std::string, const Opening*> openings;
  for (const Opening& opening : openingsOf(id)) openings[opening.node] = &opening;
  for (const Step& node : tree->nodes) {
    if (!node.present) continue;
    const auto opening = openings.find(node.id);
    if (opening != openings.end() && opening->second->status != OpeningStatus::dangling) {
      if (complete_.contains(opening->second->tree)) completed.insert(node.id);
      continue;
    }
    const Mark* mark = tree->markOn(node.id);
    if (mark && mark->status == "complete") completed.insert(node.id);
  }
  return completed;
}

std::optional<FollowGraph> RoadmapAccount::graph(const std::string& id) const {
  const RoadmapTree* tree = this->tree(id);
  if (!tree || locationOf(id).standing != Standing::standing || tree->read != Read::loaded) return std::nullopt;
  std::map<std::string, Instant> dates;
  if (const std::optional<Progress> read = progress(id))
    for (const DatedStep& date : read->dates) dates[date.node] = date.at;
  return FollowGraph(*tree, completedNodes(id), std::move(dates));
}

std::optional<Progress> RoadmapAccount::progress(const std::string& id) const {
  const RoadmapTree* tree = this->tree(id);
  if (!tree || !counts(id)) return std::nullopt;
  const std::set<std::string> completedSet = completedNodes(id);
  Progress progress;
  for (const Step& node : tree->nodes)
    if (completedSet.contains(node.id)) progress.completed.push_back(node.id);
  std::map<std::string, const Opening*> openings;
  for (const Opening& opening : openingsOf(id)) openings[opening.node] = &opening;
  for (const std::string& node : progress.completed) {
    const Mark* mark = tree->markOn(node);
    const auto found = openings.find(node);
    const Opening* opening = found == openings.end() ? nullptr : found->second;
    if (!opening || opening->status == OpeningStatus::dangling) {
      progress.dates.push_back(DatedStep{node, mark ? mark->at() : std::nullopt});
      continue;
    }
    if (mark && mark->status == "complete" && mark->stamp.isSet()) {
      progress.dates.push_back(DatedStep{node, mark->at()});
      continue;
    }
    Hlc setAt;
    if (opening->kind == OpeningKind::subtree) {
      if (const Step* step = tree->step(node)) setAt = step->branchStamp;
    } else if (const Pointer* pointer = tree->pointerOn(node)) {
      setAt = pointer->setAt;
    }
    std::optional<LatestMark> pointerMark;
    if (setAt.isSet()) pointerMark = LatestMark{setAt, static_cast<std::int64_t>(setAt.physicalMs)};
    const auto latest = latestMarks_.find(opening->tree);
    const std::optional<LatestMark> dated = later(latest == latestMarks_.end() ? std::nullopt : latest->second, pointerMark);
    progress.dates.push_back(DatedStep{node, dated ? dated->at : std::nullopt});
  }
  return progress;
}

std::map<std::string, WayBack> RoadmapAccount::waysBack(const std::string& target) const {
  std::map<std::string, WayBack> ways;
  if (locationOf(target).standing != Standing::standing) return ways;
  ways[target] = WayBack{0, std::nullopt};
  std::vector<std::string> level{target};
  std::size_t distance = 0;
  while (!level.empty()) {
    ++distance;
    std::vector<std::string> above;
    for (const std::string& below : level) {
      const auto openers = openers_.find(below);
      if (openers == openers_.end()) continue;
      for (const Opener& opener : openers->second) {
        const auto old = ways.find(opener.tree);
        if (old == ways.end()) {
          ways[opener.tree] = WayBack{distance, below};
          above.push_back(opener.tree);
        } else if (old->second.distance == distance && old->second.next && below < *old->second.next) {
          old->second.next = below;
        }
      }
    }
    level = std::move(above);
  }
  return ways;
}

std::vector<Guide> RoadmapAccount::guides(const std::string& id) const {
  if (locationOf(id).standing != Standing::standing) return {};
  struct Candidate {
    Guide guide;
    std::size_t distance;
  };
  std::vector<Candidate> candidates;
  for (const auto& [treeId, way] : waysBack(id)) {
    const RoadmapTree* tree = this->tree(treeId);
    if (!tree || tree->read != Read::loaded || !tree->meta || tree->meta->guide.empty()) continue;
    candidates.push_back(Candidate{Guide{treeId, locationOf(treeId).title.value_or(""), tree->meta->guide, !tree->meta->guideInherited},
                                   way.distance});
  }
  std::stable_sort(candidates.begin(), candidates.end(), [](const Candidate& a, const Candidate& b) {
    return a.distance != b.distance ? a.distance < b.distance : a.guide.tree < b.guide.tree;
  });
  if (candidates.size() > 8) candidates.resize(8);
  std::stable_sort(candidates.begin(), candidates.end(), [](const Candidate& a, const Candidate& b) {
    return a.distance != b.distance ? a.distance > b.distance : a.guide.tree < b.guide.tree;
  });
  std::vector<Guide> guides;
  for (Candidate& candidate : candidates) guides.push_back(std::move(candidate.guide));
  return guides;
}

}

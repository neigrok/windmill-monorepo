#pragma once

#include "products/roadmap/domain/Command.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "products/roadmap/domain/Tree.h"
#include "products/roadmap/ports/OgVideoRepository.h"
#include "products/roadmap/ports/OpLog.h"
#include "products/roadmap/ports/PresenceBus.h"
#include "products/roadmap/ports/ProgressRepository.h"
#include "products/roadmap/ports/TreeRepository.h"

#include <algorithm>
#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

namespace wm::fake {

struct FakeOpLog : OpLog {
  std::map<std::string, std::vector<AppliedOp>> byTree;
  int failNextAppends = 0;  // the next N appends throw before recording, the way a dropped connection does
  void append(const TreeId& tree, const AppliedOp& op) override {
    if (failNextAppends > 0) {
      --failNextAppends;
      throw std::runtime_error("connection reset before the row landed");
    }
    byTree[tree.str()].push_back(op);
  }
  std::vector<AppliedOp> since(const TreeId& tree, Seq afterSeq) const override {
    std::vector<AppliedOp> out;
    auto it = byTree.find(tree.str());
    if (it == byTree.end()) return out;
    for (const auto& op : it->second) {
      if (op.seq > afterSeq) out.push_back(op);
    }
    return out;
  }
};

struct FakeBus : PresenceBus {
  struct ProgressBroadcast {
    std::string tree;
    std::string user;
    Progress marks;
  };
  struct SubgraphBroadcast {
    std::string tree;
    Seq seq;
    Subgraph subgraph;
  };
  struct SubtreeBroadcast {
    std::string tree;
    Seq seq;
    NodeId step;
    Subtree subtree;
    bool operator==(const SubtreeBroadcast&) const = default;
  };
  std::vector<ProgressBroadcast> progressBroadcasts;
  std::vector<SubgraphBroadcast> subgraphBroadcasts;
  std::vector<SubtreeBroadcast> subtreeBroadcasts;
  bool subtreeBroadcastsFail = false;  // broadcastSubtree throws before it tells anyone, the way a broken fan-out does
  void broadcastSubgraph(const TreeId& tree, Seq seq, const Subgraph& subgraph) override {
    subgraphBroadcasts.push_back({tree.str(), seq, subgraph});
  }
  void broadcastSubtree(const TreeId& tree, Seq seq, const NodeId& step, const Subtree& subtree) override {
    if (subtreeBroadcastsFail) throw std::runtime_error("the fan-out broke");
    subtreeBroadcasts.push_back({tree.str(), seq, step, subtree});
  }
  // The real bus's rule: where no register was recorded there is nothing to fan out.
  void broadcastProgress(const TreeId& tree, const UserId& user, const Progress& marks) override {
    if (marks.marks.empty()) return;
    progressBroadcasts.push_back({tree.str(), user.str(), marks});
  }
};

struct FakeProgressRepository : ProgressRepository {
  struct Entry {
    ProgressStatus status;
    Hlc at;
    bool outOfOrder = false;
    bool operator==(const Entry&) const = default;
  };
  std::map<std::string, Entry> byKey;
  std::function<void()> duringBatchWrite;  // runs as setStatuses starts, before it reads a row: another door's write
                                           // made here is one the statement meets, and a slow one holds its caller
  bool loadsFail = false;   // load throws, the way a read Postgres refuses does
  std::function<void()> afterRead;  // runs once load has read its rows, before it answers: a mark made here is one
                                    // the answer misses
  bool writesFail = false;  // setStatuses throws before anything lands

  static std::string key(const TreeId& t, const UserId& u, const NodeId& n) {
    return t.str() + "\n" + u.str() + "\n" + n.str();
  }

  Progress load(const TreeId& tree, const UserId& user) override {
    if (loadsFail) throw std::runtime_error("the progress store refused the read");
    Progress progress;
    std::string prefix = tree.str() + "\n" + user.str() + "\n";
    for (const auto& [k, entry] : byKey) {
      if (k.rfind(prefix, 0) != 0) continue;
      // The fake dates a mark by the stamp it arrived with; a real store answers with its OWN receipt instant, so tests that care about the difference must use the real repository.
      progress.record(NodeId{k.substr(prefix.size())},
                      ProgressMark{entry.status, entry.at, entry.at.physicalMs, entry.outOfOrder});
    }
    if (afterRead) afterRead();
    return progress;
  }

  // The real store's rules: a replica's mark lands when its stamp is later, a server's always, at its own stamp or
  // just after the one it found. Later is by millisecond and counter alone, as the statement compares them: a stamp
  // that ties on both does not land over the one held, whatever its actor.
  std::vector<ProgressWritten> setStatuses(const TreeId& tree, const UserId& user,
                                           const std::vector<ProgressUpdate>& updates, StampedBy stampedBy,
                                           std::uint64_t receivedAtMs) override {
    if (writesFail) throw std::runtime_error("the progress store refused the write");
    if (duringBatchWrite) duringBatchWrite();
    auto next = byKey;
    std::vector<ProgressWritten> written;
    for (const ProgressUpdate& update : updates) {
      const std::string nodeKey = key(tree, user, update.node);
      const auto current = next.find(nodeKey);
      ProgressWritten did;
      did.held = current == next.end()
                     ? ProgressMark{}
                     : ProgressMark{current->second.status, current->second.at, 0, current->second.outOfOrder};
      const bool later = current == next.end() || std::pair(update.at.physicalMs, update.at.counter) >
                                                      std::pair(current->second.at.physicalMs, current->second.at.counter);
      const Hlc at = later ? update.at : current->second.at.successor(update.at.actor);
      if (later || stampedBy == StampedBy::server) {
        next[nodeKey] = Entry{update.status, at, update.outOfOrder};
        did.landed = ProgressMark{update.status, at, receivedAtMs, update.outOfOrder};
      }
      written.push_back(did);
    }
    byKey = std::move(next);
    return written;
  }

  std::map<TreeId, ProgressDigest> overlaysFor(const UserId& user) override {
    std::map<TreeId, ProgressDigest> overlays;
    for (const auto& [k, entry] : byKey) {
      std::size_t firstNl = k.find('\n');
      std::size_t secondNl = k.find('\n', firstNl + 1);
      if (k.substr(firstNl + 1, secondNl - firstNl - 1) != user.str()) continue;
      ProgressDigest& digest = overlays[TreeId{k.substr(0, firstNl)}];
      NodeId node{k.substr(secondNl + 1)};
      if (entry.status == ProgressStatus::complete) digest.overlay.completed.insert(node);
      if (entry.at.physicalMs > digest.lastMarkedAt) digest.lastMarkedAt = entry.at.physicalMs;
    }
    return overlays;
  }
};

struct FakeTreeRepository : TreeRepository {
  FakeTreeRepository() = default;
  // The marks openedFrom counts, which the real repository reads in the same statement; none without one.
  explicit FakeTreeRepository(FakeProgressRepository& marks) : marks_(&marks) {}

  std::map<std::string, StoredTree> byId;
  std::map<std::string, std::string> forkedFrom;
  std::map<std::string, std::uint64_t> updatedAt;  // epoch ms per tree, for registry ordering
  std::set<std::string> deletedIds;
  // One entry per save call: how many node rows the slice carried.
  std::vector<std::size_t> savedNodeCounts;
  // One entry per titlesOwnedBy read: the ids it asked after.
  std::vector<std::set<TreeId>> titleReads;
  // One entry per openedFrom read: the trees it started from.
  std::vector<std::set<TreeId>> openedReads;
  bool latticeLoadsFail = false;  // load throws, the way a dropped connection does; loadAccess still answers
  std::set<std::string> latticeLoadsFailFor;  // load throws for these trees alone, the others still answer
  // One entry per openedFrom read: the budget it was given.
  std::vector<std::optional<std::chrono::milliseconds>> openedBudgets;
  bool openedReadsFail = false;  // openedFrom throws, the way a dropped connection does
  bool budgetedReadsTimeOut = false;  // openedFrom given a budget throws FollowTimedOut, the way a slow statement does
  // Runs inside openedFrom once the read is counted, the way a slow statement holds its caller; a case that makes one
  // owner slow or failing reads whose and with what budget off the back of openedOwners and openedBudgets.
  std::function<void()> duringOpenedRead;
  // One entry per openedFrom read: whose trees it followed.
  std::vector<UserId> openedOwners;
  // One entry per guidedTreesAbove read: the tree it walked up from.
  std::vector<TreeId> aboveReads;
  bool aboveReadsFail = false;  // guidedTreesAbove throws, the way a dropped connection does
  // One entry per treesOpening read: the tree it asked after.
  std::vector<TreeId> openingReads;
  bool openingReadsFail = false;  // treesOpening throws, the way a dropped connection does
  std::function<void()> duringAboveRead;  // runs inside guidedTreesAbove, the way a slow statement holds its caller
  bool savesFail = false;  // save throws, the way a write Postgres refuses does
  // Runs inside save before anything lands, the way a slow or refused statement holds its caller; it may throw.
  std::function<void(const TreeId&)> duringSave;
  std::optional<StoredTree> load(const TreeId& tree) override {
    if (latticeLoadsFail || latticeLoadsFailFor.count(tree.str())) throw std::runtime_error("connection reset mid-read");
    return placed(tree);
  }
  std::optional<StoredTree> row(const TreeId& tree) const {
    if (deletedIds.count(tree.str())) return std::nullopt;
    auto it = byId.find(tree.str());
    if (it == byId.end()) return std::nullopt;
    return it->second;
  }
  // The same facts the real repository reads off the root's row, projected off the stored trees.
  std::optional<TreeAccess> loadAccess(const TreeId& tree) override {
    const std::optional<StoredTree> stored = placed(tree);
    if (!stored) return std::nullopt;
    return TreeAccess{stored->owner, stored->visibility, stored->root, stored->parent};
  }
  // The row as the real repository answers it: with its place and the standing subtree each step owns, a subtree read
  // by its root's owner and visibility, and nothing while it or its root does not stand.
  std::optional<StoredTree> placed(const TreeId& tree) const {
    std::optional<StoredTree> stored = row(tree);
    if (!stored) return std::nullopt;
    stored->root = rootOf(tree);
    stored->depth = depthOf(tree);
    stored->subtrees = ownedBy(tree);
    const auto subtree = subtrees.find(tree.str());
    if (subtree == subtrees.end()) return stored;
    const std::optional<StoredTree> root = row(stored->root);
    if (!root) return std::nullopt;
    stored->owner = root->owner;
    stored->visibility = root->visibility;
    stored->parent = subtree->second.parent;
    return stored;
  }
  // The standing subtree each step of `tree` owns, by step.
  std::map<NodeId, TreeId> ownedBy(const TreeId& tree) const {
    std::map<NodeId, TreeId> owned;
    for (const auto& [id, subtree] : subtrees)
      if (subtree.parent.tree == tree && row(TreeId{id})) owned.emplace(subtree.parent.step, TreeId{id});
    return owned;
  }
  // A tree's name as every read of the real repository answers it, with its stamp: a root's title, a subtree's owning
  // step's label.
  Lww<std::string> nameOf(const TreeId& tree) const {
    const auto subtree = subtrees.find(tree.str());
    if (subtree == subtrees.end()) return byId.at(tree.str()).title;
    for (const NodeStateEntry& node : byId.at(subtree->second.parent.tree.str()).state.nodes)
      if (node.id == subtree->second.parent.step) return {node.label, node.labelAt};
    return {};
  }
  // The document every read of the real repository projects: present steps, each opening the subtree it owns whatever
  // its pointer holds, under the tree's name.
  TreeData documentOf(const TreeId& tree) const {
    TreeData data = LooseGraph(byId.at(tree.str()).state).toTreeData(tree, nameOf(tree).value);
    const std::map<NodeId, TreeId> owned = ownedBy(tree);
    for (NodeSpec& node : data.nodes)
      if (const auto subtree = owned.find(node.id); subtree != owned.end()) node.opens = subtree->second;
    return data;
  }
  bool placeReadsFail = false;  // placeOf throws, the way a dropped connection does
  // The real statement's walk: up the parents of a standing tree, each named as every read names it.
  std::optional<Place> placeOf(const TreeId& tree) override {
    if (placeReadsFail) throw std::runtime_error("connection reset mid-read");
    const std::optional<StoredTree> stored = placed(tree);
    if (!stored) return std::nullopt;
    const Lww<std::string> name = nameOf(tree);
    Place place{name.value, name.stamp, stored->root, stored->parent, {}, stored->depth};
    for (std::optional<OwningStep> above = stored->parent; above; above = placed(above->tree)->parent)
      place.path.insert(place.path.begin(), PathStep{above->tree, above->step, nameOf(above->tree).value});
    return place;
  }
  // Projected off the row the delete left behind: only a deleted id answers, and only when it had an owner.
  std::optional<UserId> retiredOwner(const TreeId& tree) override {
    if (!deletedIds.count(tree.str())) return std::nullopt;
    auto it = byId.find(tree.str());
    if (it == byId.end()) return std::nullopt;
    return it->second.owner;
  }

  ForkLineage loadForkLineage(const TreeId& tree) override {
    ForkLineage lineage;
    auto source = forkedFrom.find(tree.str());
    lineage.isFork = source != forkedFrom.end();
    if (lineage.isFork) {
      auto src = byId.find(source->second);
      if (src != byId.end() && !deletedIds.count(source->second) && src->second.visibility == Visibility::public_)
        lineage.sourceTitle = src->second.title.value;
    }
    for (const auto& [id, from] : forkedFrom)
      if (from == tree.str() && !deletedIds.count(id)) lineage.forkCount++;
    return lineage;
  }
  bool save(const TreeId& tree, const GraphState& state, const LegendState& legend,
            const Lww<std::string>& title, const Lww<std::string>& guide, Seq head) override {
    if (savesFail) throw std::runtime_error("the write was refused");
    if (duringSave) duringSave(tree);
    savedNodeCounts.push_back(state.nodes.size());
    if (!row(tree)) return false;  // a tree whose row is gone or retired is left as it is
    StoredTree& stored = byId[tree.str()];  // merge the slice, keep the rest
    for (const NodeStateEntry& node : state.nodes) {
      auto match = std::find_if(stored.state.nodes.begin(), stored.state.nodes.end(),
                                [&](const NodeStateEntry& n) { return n.id == node.id; });
      if (match != stored.state.nodes.end()) *match = node;
      else stored.state.nodes.push_back(node);
    }
    for (const EdgeStateEntry& edge : state.edges) {
      auto match = std::find_if(stored.state.edges.begin(), stored.state.edges.end(),
                                [&](const EdgeStateEntry& e) { return e.edge == edge.edge; });
      if (match != stored.state.edges.end()) *match = edge;
      else stored.state.edges.push_back(edge);
    }
    for (const KindStateEntry& kind : legend.kinds) {
      auto match = std::find_if(stored.legend.kinds.begin(), stored.legend.kinds.end(),
                                [&](const KindStateEntry& k) { return k.id == kind.id; });
      if (match != stored.legend.kinds.end()) *match = kind;
      else stored.legend.kinds.push_back(kind);
    }
    // Each register lands only under a dominating stamp, the rule PgTreeRepository enforces in SQL; only Postgres carries the byte-order tiebreak collation.
    if (title.stamp > stored.title.stamp) stored.title = title;
    if (guide.stamp > stored.guide.stamp) {
      stored.guide = guide;
      stored.guideInherited = false;
    }
    stored.head = head;
    return true;
  }
  void create(const TreeId& tree, const GraphState& state, const LegendState& legend,
              const std::string& title, const UserId& owner) override {
    if (byId.count(tree.str())) throw DuplicateTree{};
    byId[tree.str()] = StoredTree{state, legend, {title, {}}, 0, owner};
  }
  std::vector<OwnedTree> listOwnedBy(const UserId& owner) override {
    std::vector<OwnedTree> owned;
    for (const auto& [id, stored] : byId) {
      if (deletedIds.count(id)) continue;
      if (!stored.owner || *stored.owner != owner) continue;
      TreeData data = documentOf(TreeId{id});
      data.title = stored.title.value;  // the real list reads the column, which a subtree never writes
      std::uint64_t ms = updatedAt.count(id) ? updatedAt.at(id) : 0;
      // The planting time rides the stored tree, unlike updated_at, which this fake keeps in its own map.
      owned.push_back(OwnedTree{std::move(data), stored.createdAt, ms, placed(TreeId{id})->parent});
    }
    return owned;
  }
  std::vector<ListedTree> listPublic() override {
    std::vector<ListedTree> listed;
    for (const auto& [id, stored] : byId) {
      if (deletedIds.count(id)) continue;
      if (!stored.owner) continue;
      if (stored.visibility != Visibility::public_) continue;  // the query's own visibility filter
      if (subtrees.count(id)) continue;                         // and its roots alone
      ListedTree entry;
      entry.data = documentOf(TreeId{id});
      entry.pointers = LooseGraph(stored.state).stampedPointers();
      for (const auto& [step, subtree] : ownedBy(TreeId{id}))
        if (LooseGraph(stored.state).hasNode(step)) entry.pointers[step] = StampedPointer{subtree, Hlc{}};
      entry.updatedAt = updatedAt.count(id) ? updatedAt.at(id) : 0;
      entry.owner = *stored.owner;
      for (const auto& [forkId, from] : forkedFrom)
        if (from == id && !deletedIds.count(forkId)) entry.forks++;
      // The same rule the real query carries in its join: a source is named only while it exists and is public.
      auto source = forkedFrom.find(id);
      if (source != forkedFrom.end()) {
        auto src = byId.find(source->second);
        if (src != byId.end() && !deletedIds.count(source->second) &&
            src->second.visibility == Visibility::public_)
          entry.sourceTitle = src->second.title.value;
      }
      listed.push_back(std::move(entry));
    }
    return listed;
  }
  std::set<TreeId> listForkedSources(const UserId& owner) override {
    std::set<TreeId> sources;
    for (const auto& [id, from] : forkedFrom) {
      if (deletedIds.count(id)) continue;
      auto it = byId.find(id);
      if (it == byId.end() || !it->second.owner || *it->second.owner != owner) continue;
      sources.insert(TreeId{from});
    }
    return sources;
  }
  // The same three rules the real query filters on: the row stands, it has an owner, and the owner is this one.
  // Asked for no tree it reads nothing, as the real repository sends no query.
  std::map<TreeId, std::string> titlesOwnedBy(const UserId& owner, const std::set<TreeId>& trees) override {
    if (trees.empty()) return {};
    titleReads.push_back(trees);
    std::map<TreeId, std::string> titles;
    for (const TreeId& tree : trees) {
      const std::optional<StoredTree> stored = row(tree);
      if (stored && stored->owner == std::optional<UserId>(owner)) titles.emplace(tree, stored->title.value);
    }
    return titles;
  }
  // The real statement's rules: this owner's standing trees only, each once, wherever the pointers of `opened` lead.
  std::map<TreeId, OpenedTree> openedFrom(const UserId& owner, const std::set<TreeId>& opened,
                                          std::optional<std::chrono::milliseconds> budget = std::nullopt) override {
    if (opened.empty()) return {};
    openedReads.push_back(opened);
    openedBudgets.push_back(budget);
    openedOwners.push_back(owner);
    if (openedReadsFail) throw std::runtime_error("connection reset mid-read");
    if (budget && budgetedReadsTimeOut) throw FollowTimedOut{};
    if (duringOpenedRead) duringOpenedRead();
    std::map<TreeId, OpenedTree> trees;
    std::vector<TreeId> reached(opened.begin(), opened.end());
    while (!reached.empty()) {
      const TreeId tree = reached.back();
      reached.pop_back();
      const std::optional<StoredTree> stored = placed(tree);
      if (trees.count(tree) || !stored || stored->owner != std::optional<UserId>(owner)) continue;
      const OpenedTree& walked =
          trees.emplace(tree, OpenedTree(documentOf(tree), marks_ ? marks_->load(tree, owner) : Progress{})).first->second;
      for (const auto& [target, pointers] : walked.pointers) reached.push_back(target);
    }
    return trees;
  }
  // The real statement's rules: this owner's standing trees only, level by level up the present pointers, so each
  // sits at its shortest distance, the walk ends at kMaxLevelsAbove and `tree` is never above itself; then the
  // nearest kMaxGuides that carry a guide.
  std::map<TreeId, TreeAbove> guidedTreesAbove(const UserId& owner, const TreeId& tree) override {
    aboveReads.push_back(tree);
    if (aboveReadsFail) throw std::runtime_error("connection reset mid-read");
    if (duringAboveRead) duringAboveRead();
    std::map<TreeId, TreeAbove> above;
    const std::optional<StoredTree> asked = placed(tree);
    if (!asked || asked->owner != std::optional<UserId>(owner)) return above;
    // What lies directly below a tree: the subtrees it owns, and each root its steps that own none point at.
    const auto below = [&](const TreeId& opener) {
      const std::map<NodeId, TreeId> owned = ownedBy(opener);
      std::set<TreeId> under;
      for (const auto& [step, subtree] : owned) under.insert(subtree);
      for (const auto& [step, target] : LooseGraph(byId.at(opener.str()).state).pointers())
        if (!owned.count(step) && !subtrees.count(target.str())) under.insert(target);
      return under;
    };
    std::set<TreeId> level{tree};
    for (int distance = 1; distance <= kMaxLevelsAbove && !level.empty(); ++distance) {
      std::set<TreeId> next;
      for (const auto& [id, stored] : byId) {
        const TreeId opener{id};
        if (opener == tree || above.count(opener) || !placed(opener) || stored.owner != std::optional<UserId>(owner))
          continue;
        const std::set<TreeId> under = below(opener);
        if (std::none_of(level.begin(), level.end(), [&](const TreeId& lower) { return under.count(lower) > 0; }))
          continue;
        above.emplace(opener, TreeAbove{distance, nameOf(opener).value, stored.guide.value, stored.guideInherited});
        next.insert(opener);
      }
      level = std::move(next);
    }
    return nearestGuided(above, kMaxGuides);
  }
  // The real statement's rules: this owner's standing trees other than `tree`, each once, in id order, and only for a
  // `tree` of this owner's, whether or not it stands.
  std::vector<TreeId> treesOpening(const UserId& owner, const TreeId& tree) override {
    openingReads.push_back(tree);
    if (openingReadsFail) throw std::runtime_error("connection reset mid-read");
    std::vector<TreeId> opening;
    const auto opened = byId.find(tree.str());
    if (opened == byId.end() || opened->second.owner != std::optional<UserId>(owner)) return opening;
    for (const auto& [id, stored] : byId) {
      if (id == tree.str() || deletedIds.count(id) || stored.owner != std::optional<UserId>(owner)) continue;
      if (treesOpenedBy(LooseGraph(stored.state).pointers()).count(tree)) opening.emplace_back(id);
    }
    return opening;
  }
  void softDelete(const TreeId& tree) override { deletedIds.insert(tree.str()); }
  void rename(const TreeId& tree, const Lww<std::string>& title) override {
    auto it = byId.find(tree.str());
    if (it == byId.end() || deletedIds.count(tree.str())) return;
    if (title.stamp > it->second.title.stamp) it->second.title = title;  // the same LWW guard as save
  }
  // Runs inside setVisibility before the row changes, the way a slow or refused statement holds its caller; it may throw.
  std::function<void()> duringVisibilitySet;
  // The real statement's rule: a standing root's row alone.
  void setVisibility(const TreeId& tree, Visibility visibility) override {
    if (duringVisibilitySet) duringVisibilitySet();
    if (!row(tree) || subtrees.count(tree.str())) return;
    byId[tree.str()].visibility = visibility;
  }
  void fork(const TreeId& newTree, const TreeId& source, const GraphState& state,
            const LegendState& legend, const Lww<std::string>& title, const Lww<std::string>& guide,
            bool guideInherited, const UserId& owner) override {
    if (byId.count(newTree.str())) throw DuplicateTree{};  // the same unique index as create
    // A fork is born private, like every fresh tree.
    byId[newTree.str()] = StoredTree{state, legend, title, 0, owner, Visibility::private_, 0, guide, guideInherited};
    forkedFrom[newTree.str()] = source.str();
  }

  // Each subtree by its id; a tree absent here is a root.
  std::map<std::string, Subtree> subtrees;
  // Runs inside createSubtree before anything lands, the way a refused or dropped statement holds its caller; it may throw.
  std::function<void()> duringSubtreeCreate;
  TreeId rootOf(const TreeId& tree) const {
    const auto subtree = subtrees.find(tree.str());
    return subtree == subtrees.end() ? tree : subtree->second.root;
  }
  int depthOf(const TreeId& tree) const {
    const auto subtree = subtrees.find(tree.str());
    return subtree == subtrees.end() ? 0 : subtree->second.depth;
  }
  // The real statement's rules: the subtree the pair holds standing or deleted, a pointer valid only at a standing tree of
  // the parent's owner, and a proposed id taken by any row.
  std::optional<SubtreeSite> subtreeSite(const TreeId& parent, const NodeId& step, const std::optional<TreeId>& opened,
                                         const std::optional<TreeId>& proposed) override {
    const std::optional<StoredTree> stored = row(parent);
    if (!stored) return std::nullopt;
    SubtreeSite site{rootOf(parent), depthOf(parent), stored->head};
    for (const auto& [id, subtree] : subtrees)
      if (subtree.parent == OwningStep{parent, step}) {
        site.owned = subtree;
        site.owned->seq = byId.at(id).head;
      }
    const std::optional<StoredTree> target = opened ? row(*opened) : std::nullopt;
    site.opensATree = target && target->owner && target->owner == stored->owner;
    site.proposedTaken = proposed && byId.count(proposed->str()) > 0;
    return site;
  }
  // The real transaction's rules: nothing lands on a conflict, and the child takes its place and owner from its parent,
  // its own visibility column 'private'.
  std::variant<Subtree, SubtreeConflict> createSubtree(const TreeId& child, const OwningStep& parent,
                                                       const LegendState& legend, Seq parentSeq) override {
    if (duringSubtreeCreate) duringSubtreeCreate();
    const std::optional<StoredTree> stored = row(parent.tree);
    if (!stored) return SubtreeConflict::parentGone;
    for (const auto& [id, subtree] : subtrees)
      if (subtree.parent == parent) return SubtreeConflict::stepOwned;
    if (byId.count(child.str())) return SubtreeConflict::idTaken;
    const Subtree created{child, rootOf(parent.tree), parent, depthOf(parent.tree) + 1, 0};
    byId[child.str()] = StoredTree{GraphState{}, legend, {}, 0, stored->owner, Visibility::private_};
    subtrees[child.str()] = created;
    byId[parent.tree.str()].head = parentSeq;
    return created;
  }

private:
  FakeProgressRepository* marks_ = nullptr;
};

struct FakeOgVideoRepository : OgVideoRepository {
  std::map<std::string, StoredVideo> byId;
  void put(const std::string& treeId, const std::string& bytes, const std::string& mime) override {
    byId[treeId] = StoredVideo{bytes, mime};
  }
  std::optional<StoredVideo> get(const std::string& treeId) override {
    auto it = byId.find(treeId);
    if (it == byId.end()) return std::nullopt;
    return it->second;
  }
  bool has(const std::string& treeId) override { return byId.count(treeId) != 0; }
};

inline NodeId nid(const char* s) { return NodeId{std::string(s)}; }
inline TreeId tid(const char* s = "t") { return TreeId{std::string(s)}; }
inline UserId uid(const char* s = "u") { return UserId{std::string(s)}; }
inline Hlc at(std::uint64_t ms, const char* actor = "u") { return Hlc{ms, 0, actor}; }

inline Command createNode(const char* id) {
  return CreateNode{nid(id), id, "icon", NodeColor::sky};
}

}

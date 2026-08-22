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
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace wm::fake {

struct FakeOpLog : OpLog {
  std::map<std::string, std::vector<AppliedOp>> byTree;
  void append(const TreeId& tree, const AppliedOp& op) override { byTree[tree.str()].push_back(op); }
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
  std::vector<ProgressBroadcast> progressBroadcasts;
  std::vector<SubgraphBroadcast> subgraphBroadcasts;
  void broadcastSubgraph(const TreeId& tree, Seq seq, const Subgraph& subgraph) override {
    subgraphBroadcasts.push_back({tree.str(), seq, subgraph});
  }
  void broadcastProgress(const TreeId& tree, const UserId& user, const Progress& marks) override {
    progressBroadcasts.push_back({tree.str(), user.str(), marks});
  }
};

struct FakeTreeRepository : TreeRepository {
  std::map<std::string, StoredTree> byId;
  std::map<std::string, std::string> forkedFrom;
  std::map<std::string, std::uint64_t> updatedAt;  // epoch ms per tree, for registry ordering
  // The owner's latest progress mark per tree — the column listPublic joins in. It lives here
  // rather than being derived from a progress fake because it is a fact of the wall ROW: the real
  // query carries it on the same row as the fork count, and a repository fake models the row it
  // hands back, not the tables behind it.
  std::map<std::string, std::uint64_t> lastMarkedAt;
  std::set<std::string> deletedIds;
  // One entry per save call: how many node rows the slice carried — the sparse-persistence
  // assertions read this (a one-node edit must save one node, not the tree).
  std::vector<std::size_t> savedNodeCounts;
  std::optional<StoredTree> load(const TreeId& tree) override {
    if (deletedIds.count(tree.str())) return std::nullopt;
    auto it = byId.find(tree.str());
    if (it == byId.end()) return std::nullopt;
    return it->second;
  }
  // The same two facts the real repository reads with a two-column select — projected off the
  // stored tree here, so a fake can never disagree with load() about who may read what.
  std::optional<TreeAccess> loadAccess(const TreeId& tree) override {
    const std::optional<StoredTree> stored = load(tree);
    if (!stored) return std::nullopt;
    return TreeAccess{stored->owner, stored->visibility};
  }
  // Projected off the row the delete left behind, exactly as the real repository reads the
  // column load() filters away: only a deleted id answers, and only when it had an owner.
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
  void save(const TreeId& tree, const GraphState& state, const LegendState& legend,
            const Lww<std::string>& title, Seq head) override {
    savedNodeCounts.push_back(state.nodes.size());
    const bool fresh = byId.count(tree.str()) == 0;
    StoredTree& stored = byId[tree.str()];  // upsert semantics: merge the slice, keep the rest
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
    // The title register lands only under a dominating stamp — the rule PgTreeRepository
    // enforces in SQL on the trees row; only Postgres carries the byte-order tiebreak
    // collation, the fake mirrors the same order through Hlc's own comparison.
    if (fresh || title.stamp > stored.title.stamp) stored.title = title;
    stored.head = head;
  }
  void create(const TreeId& tree, const GraphState& state, const LegendState& legend,
              const std::string& title, const UserId& owner) override {
    // The unique index Postgres enforces: a soft-deleted row still holds its id.
    if (byId.count(tree.str())) throw DuplicateTree{};
    byId[tree.str()] = StoredTree{state, legend, {title, {}}, 0, owner};
  }
  std::vector<OwnedTree> listOwnedBy(const UserId& owner) override {
    std::vector<OwnedTree> owned;
    for (const auto& [id, stored] : byId) {
      if (deletedIds.count(id)) continue;
      if (!stored.owner || *stored.owner != owner) continue;
      TreeData data = LooseGraph(stored.state).toTreeData(TreeId{id}, stored.title.value);
      std::uint64_t ms = updatedAt.count(id) ? updatedAt.at(id) : 0;
      // The planting time rides the stored tree (the real column is read by load() too), unlike
      // updated_at, which no read ever hands back and which this fake keeps in its own map.
      owned.push_back(OwnedTree{std::move(data), stored.createdAt, ms});
    }
    return owned;
  }
  std::vector<ListedTree> listPublic() override {
    std::vector<ListedTree> listed;
    for (const auto& [id, stored] : byId) {
      if (deletedIds.count(id)) continue;
      if (!stored.owner) continue;
      if (stored.visibility != Visibility::public_) continue;  // the query's own visibility filter
      ListedTree entry;
      entry.data = LooseGraph(stored.state).toTreeData(TreeId{id}, stored.title.value);
      entry.updatedAt = updatedAt.count(id) ? updatedAt.at(id) : 0;
      entry.lastMarkedAt = lastMarkedAt.count(id) ? lastMarkedAt.at(id) : 0;
      entry.owner = *stored.owner;
      for (const auto& [forkId, from] : forkedFrom)
        if (from == id && !deletedIds.count(forkId)) entry.forks++;
      // The same rule the real query carries in its join, and the same one loadForkLineage
      // applies: a source is named only while it exists and is public.
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
  void softDelete(const TreeId& tree) override { deletedIds.insert(tree.str()); }
  void rename(const TreeId& tree, const Lww<std::string>& title) override {
    auto it = byId.find(tree.str());
    if (it == byId.end() || deletedIds.count(tree.str())) return;
    if (title.stamp > it->second.title.stamp) it->second.title = title;  // the same LWW guard as save
  }
  void setVisibility(const TreeId& tree, Visibility visibility) override {
    auto it = byId.find(tree.str());
    if (it == byId.end() || deletedIds.count(tree.str())) return;  // guarded like the real column write
    it->second.visibility = visibility;
  }
  void fork(const TreeId& newTree, const TreeId& source, const GraphState& state,
            const LegendState& legend, const std::string& title, const UserId& owner) override {
    if (byId.count(newTree.str())) throw DuplicateTree{};  // the same unique index as create
    // A fork's title starts stampless — its own baseline, like create; a later rename stamps it.
    // Born private (the column default), like every fresh tree.
    byId[newTree.str()] = StoredTree{state, legend, {title, {}}, 0, owner};
    forkedFrom[newTree.str()] = source.str();
  }
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

struct FakeProgressRepository : ProgressRepository {
  struct Entry { ProgressStatus status; Hlc at; };
  std::map<std::string, Entry> byKey;

  static std::string key(const TreeId& t, const UserId& u, const NodeId& n) {
    return t.str() + "\n" + u.str() + "\n" + n.str();
  }

  Progress load(const TreeId& tree, const UserId& user) override {
    Progress progress;
    std::string prefix = tree.str() + "\n" + user.str() + "\n";
    for (const auto& [k, entry] : byKey) {
      if (k.rfind(prefix, 0) != 0) continue;
      // The fake dates a mark by the stamp it arrived with. A real store answers with its OWN
      // receipt instant, which is the only one a surface may show — a fake has no second clock
      // to be honest with, so tests that care about the difference must use the real repository.
      progress.record(NodeId{k.substr(prefix.size())},
                      ProgressMark{entry.status, entry.at, entry.at.physicalMs});
    }
    return progress;
  }

  void setStatus(const TreeId& tree, const UserId& user, const NodeId& node,
                 ProgressStatus status, const Hlc& at, std::uint64_t receivedAtMs) override {
    (void)receivedAtMs;
    std::string k = key(tree, user, node);
    auto it = byKey.find(k);
    if (it == byKey.end() || at > it->second.at) byKey[k] = Entry{status, at};
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
      else if (entry.status == ProgressStatus::active) digest.overlay.inProgress.insert(node);
      if (entry.at.physicalMs > digest.lastMarkedAt) digest.lastMarkedAt = entry.at.physicalMs;
    }
    return overlays;
  }
};

inline NodeId nid(const char* s) { return NodeId{std::string(s)}; }
inline TreeId tid(const char* s = "t") { return TreeId{std::string(s)}; }
inline UserId uid(const char* s = "u") { return UserId{std::string(s)}; }
inline Hlc at(std::uint64_t ms, const char* actor = "u") { return Hlc{ms, 0, actor}; }

inline Command createNode(const char* id) {
  return CreateNode{nid(id), id, "icon", NodeColor::sky, {}, std::nullopt};
}

}

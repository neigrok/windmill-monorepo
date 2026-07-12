#pragma once

#include "domain/Command.h"
#include "domain/Ids.h"
#include "domain/Tree.h"
#include "ports/OpLog.h"
#include "ports/PresenceBus.h"
#include "ports/ProgressRepository.h"
#include "ports/TreeRepository.h"

#include <map>
#include <optional>
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
  std::vector<AppliedOp> broadcasts;
  void broadcastOp(const TreeId&, const AppliedOp& op) override { broadcasts.push_back(op); }
};

struct FakeTreeRepository : TreeRepository {
  std::map<std::string, StoredTree> byId;
  std::map<std::string, std::string> forkedFrom;
  std::optional<StoredTree> load(const TreeId& tree) override {
    auto it = byId.find(tree.str());
    if (it == byId.end()) return std::nullopt;
    return it->second;
  }
  void save(const TreeId& tree, const GraphState& state, const LegendState& legend,
            const std::string& title, Seq head) override {
    byId[tree.str()] = StoredTree{state, legend, title, head};
  }
  void fork(const TreeId& newTree, const TreeId& source, const GraphState& state,
            const LegendState& legend, const std::string& title) override {
    byId[newTree.str()] = StoredTree{state, legend, title, 0};
    forkedFrom[newTree.str()] = source.str();
  }
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
      NodeId node{k.substr(prefix.size())};
      if (entry.status == ProgressStatus::complete) progress.completed.insert(node);
      else if (entry.status == ProgressStatus::active) progress.inProgress.insert(node);
    }
    return progress;
  }

  void setStatus(const TreeId& tree, const UserId& user, const NodeId& node,
                 ProgressStatus status, const Hlc& at) override {
    std::string k = key(tree, user, node);
    auto it = byKey.find(k);
    if (it == byKey.end() || at > it->second.at) byKey[k] = Entry{status, at};
  }
};

inline NodeId nid(const char* s) { return NodeId{std::string(s)}; }
inline TreeId tid(const char* s = "t") { return TreeId{std::string(s)}; }
inline UserId uid(const char* s = "u") { return UserId{std::string(s)}; }
inline Hlc at(std::uint64_t ms, const char* actor = "u") { return Hlc{ms, 0, actor}; }

inline Command createNode(const char* id) {
  return CreateNode{nid(id), id, "icon", NodeColor::sky, std::nullopt, std::nullopt};
}

}

#include "platform/application/sync/SyncLive.h"

#include "platform/application/WorkerPool.h"

#include <algorithm>
#include <utility>

namespace wm::sync {

namespace {

// A sub or unsub frame's scopes: every ref a string. Anything else leaves the whole frame ignored.
bool isRefList(const Json::Value& scopeRefs) {
  return scopeRefs.isArray() && std::all_of(scopeRefs.begin(), scopeRefs.end(), [](const Json::Value& ref) { return ref.isString(); });
}

bool governedBy(const ScopeKey& key, const ScopeKey& tree) {
  return key.kind() != ScopeKind::product && key.governingTree() == tree;
}

}

void SyncLive::CachedTree::learn(const ScopeFacts& told, Seq at) {
  dead = dead || told.dead;
  if (facts && at < seq) return;
  facts = told;
  seq = at;
}

std::optional<ScopeFacts> SyncLive::CachedTree::current() const {
  if (!facts) return std::nullopt;
  return ScopeFacts{facts->owner, facts->dead || dead, facts->open};
}

SyncLive::SyncLive(const SyncCatalog& catalog, SyncStore& store, Limits limits) : catalog_(catalog), store_(store), limits_(limits) {}

void SyncLive::open(std::shared_ptr<LiveSocket> socket, std::optional<UserId> principal) {
  std::lock_guard lock(mutex_);
  const LiveSocket* key = socket.get();
  sockets_.try_emplace(key, Subscriber{std::move(socket), std::move(principal), {}});
}

void SyncLive::close(const LiveSocket& socket) {
  std::lock_guard lock(mutex_);
  const auto subscriber = sockets_.find(&socket);
  if (subscriber == sockets_.end()) return;
  for (const ScopeKey& key : std::vector(subscriber->second.scopes.begin(), subscriber->second.scopes.end())) detach(subscriber->second, key);
  sockets_.erase(subscriber);
}

void SyncLive::subscribe(const LiveSocket& socket, const Json::Value& scopeRefs) {
  requireBlockingThread();
  if (!isRefList(scopeRefs)) return;
  const std::vector<Wanted> wanted = watch(socket, scopeRefs);
  std::map<ScopeKey, std::optional<ScopeRow>> trees;
  try {
    trees = readTrees(wanted);
  } catch (...) {
    std::lock_guard lock(mutex_);
    unwatch(wanted);
    throw;
  }
  decide(socket, wanted, trees);
}

void SyncLive::unsubscribe(const LiveSocket& socket, const Json::Value& scopeRefs) {
  if (!isRefList(scopeRefs)) return;
  std::lock_guard lock(mutex_);
  const auto subscriber = sockets_.find(&socket);
  if (subscriber == sockets_.end()) return;
  for (const Json::Value& ref : scopeRefs) {
    if (const std::optional<ScopeKey> key = resolve(catalog_.registry(), ref.asString(), subscriber->second.principal)) detach(subscriber->second, *key);
  }
}

void SyncLive::publish(const CommittedChange& change) {
  std::lock_guard lock(mutex_);
  const std::vector<ScopeKey> flipped = learn(change);
  for (const ScopeKey& tree : flipped) {
    for (auto& [socket, subscriber] : sockets_) endUnreadable(subscriber, [&tree](const ScopeKey& key) { return governedBy(key, tree); });
  }
  for (const ScopeChange& changed : change.changed) sendChange(change.epoch, changed);
  for (const ScopeKey& killed : change.killed) answerDeath(killed);
}

// Resolves each ref as the socket's principal and holds the tree each tree or overlay ref reads, so a change
// published while the snapshot is read reaches the cache.
std::vector<SyncLive::Wanted> SyncLive::watch(const LiveSocket& socket, const Json::Value& scopeRefs) {
  std::lock_guard lock(mutex_);
  const auto subscriber = sockets_.find(&socket);
  if (subscriber == sockets_.end()) return {};
  std::vector<Wanted> wanted;
  for (const Json::Value& ref : scopeRefs) {
    std::optional<ScopeKey> key = resolve(catalog_.registry(), ref.asString(), subscriber->second.principal);
    if (key && key->kind() != ScopeKind::product) ++trees_[key->governingTree()].readers;
    wanted.push_back(Wanted{ref.asString(), std::move(key)});
  }
  return wanted;
}

// One snapshot of the tree each tree or overlay ref answers as.
std::map<ScopeKey, std::optional<ScopeRow>> SyncLive::readTrees(const std::vector<Wanted>& wanted) {
  std::map<ScopeKey, std::optional<ScopeRow>> trees;
  for (const Wanted& one : wanted) {
    if (one.key && one.key->kind() != ScopeKind::product) trees.emplace(one.key->governingTree(), std::nullopt);
  }
  if (trees.empty()) return trees;
  const std::unique_ptr<SyncTxn> txn = store_.begin(TxnMode::snapshot);
  for (auto& [tree, row] : trees) row = store_.scope(*txn, tree, RowLock::none);
  return trees;
}

// Folds each snapshot row into the cache unless a newer change was published, then decides every ref by D-4 as
// the socket's principal now reads: readable subscribes and sends nothing, anything else answers.
void SyncLive::decide(const LiveSocket& socket, const std::vector<Wanted>& wanted, const std::map<ScopeKey, std::optional<ScopeRow>>& trees) {
  std::lock_guard lock(mutex_);
  for (const auto& [tree, row] : trees) {
    if (row) trees_.at(tree).learn(row->facts(), row->seq);
  }
  if (const auto subscriber = sockets_.find(&socket); subscriber != sockets_.end()) {
    for (const Wanted& one : wanted) {
      if (!one.key) {
        answer(subscriber->second, "not-found", one.ref);
        continue;
      }
      const Access access = accessTo(*one.key, subscriber->second.principal);
      if (access.read) attach(subscriber->second, *one.key);
      else end(subscriber->second, *one.key, access);
    }
  }
  unwatch(wanted);
}

void SyncLive::unwatch(const std::vector<Wanted>& wanted) {
  for (const Wanted& one : wanted) {
    if (one.key && one.key->kind() != ScopeKind::product) release(one.key->governingTree());
  }
}

// §6.8's invalidation: each written tree's owner and open, each killed tree's death. Answers the trees whose open
// flipped, whose subscriptions and overlays' are decided again.
std::vector<ScopeKey> SyncLive::learn(const CommittedChange& change) {
  std::vector<ScopeKey> flipped;
  for (const ScopeChange& changed : change.changed) {
    const auto tree = trees_.find(changed.key);
    if (tree == trees_.end()) continue;
    const bool wasOpen = tree->second.facts && tree->second.facts->open;
    tree->second.learn(ScopeFacts{changed.owner, false, changed.open}, changed.seq);
    if (tree->second.facts->open != wasOpen) flipped.push_back(changed.key);
  }
  for (const ScopeKey& killed : change.killed) {
    if (const auto tree = trees_.find(killed); tree != trees_.end()) tree->second.dead = true;
  }
  return flipped;
}

// §6.8: {op: change} to every subscriber still holding read access, with its socket's `as`; one who lost it gets
// not-found and ends.
void SyncLive::sendChange(const std::string& epoch, const ScopeChange& changed) {
  const auto subscribed = subscribers_.find(changed.key);
  if (subscribed == subscribers_.end()) return;
  Json::Value frame = changeFrame(epoch, changed.key, changed.seq, changed.digest, changed.rows, limits_.liveInlineBytes);
  for (const LiveSocket* socket : std::vector(subscribed->second.begin(), subscribed->second.end())) {
    Subscriber& subscriber = sockets_.at(socket);
    const Access access = accessTo(changed.key, subscriber.principal);
    if (!access.read) {
      end(subscriber, changed.key, access);
      continue;
    }
    frame["as"] = servedAsJson(subscriber.principal);
    subscriber.socket->send(frame);
  }
}

void SyncLive::answer(const Subscriber& subscriber, const std::string& op, const std::string& scope) {
  Json::Value frame(Json::objectValue);
  frame["op"] = op;
  frame["as"] = servedAsJson(subscriber.principal);
  frame["scope"] = scope;
  subscriber.socket->send(frame);
}

// A dead scope answers as a read of it now would: gone to its tree's owner, not-found to everyone else (INV-7).
void SyncLive::answerDeath(const ScopeKey& killed) {
  const auto subscribed = subscribers_.find(killed);
  if (subscribed == subscribers_.end()) return;
  for (const LiveSocket* socket : std::vector(subscribed->second.begin(), subscribed->second.end())) {
    Subscriber& subscriber = sockets_.at(socket);
    end(subscriber, killed, accessTo(killed, subscriber.principal));
  }
}

// A product or overlay scope reads only for its own account, and then an overlay answers as its tree does. Read
// and gone never depend on a scope's own row, so only the tree's cached facts are passed.
Access SyncLive::accessTo(const ScopeKey& key, const std::optional<UserId>& principal) const {
  if (key.kind() != ScopeKind::tree && principal != key.account()) return Access{.refusal = code::notFound};
  const auto tree = key.kind() == ScopeKind::product ? trees_.end() : trees_.find(key.governingTree());
  return accessOf(key, std::nullopt, tree == trees_.end() ? std::nullopt : tree->second.current(), principal);
}

void SyncLive::endUnreadable(Subscriber& subscriber, const std::function<bool(const ScopeKey&)>& among) {
  for (const ScopeKey& key : std::vector(subscriber.scopes.begin(), subscriber.scopes.end())) {
    if (!among(key)) continue;
    const Access access = accessTo(key, subscriber.principal);
    if (!access.read) end(subscriber, key, access);
  }
}

void SyncLive::end(Subscriber& subscriber, const ScopeKey& key, const Access& access) {
  answer(subscriber, access.gone ? "gone" : "not-found", key.ref());
  detach(subscriber, key);
}

void SyncLive::attach(Subscriber& subscriber, const ScopeKey& key) {
  if (!subscriber.scopes.insert(key).second) return;
  subscribers_[key].insert(subscriber.socket.get());
  if (key.kind() != ScopeKind::product) ++trees_.at(key.governingTree()).readers;
}

void SyncLive::detach(Subscriber& subscriber, const ScopeKey& key) {
  if (subscriber.scopes.erase(key) == 0) return;
  const auto subscribed = subscribers_.find(key);
  subscribed->second.erase(subscriber.socket.get());
  if (subscribed->second.empty()) subscribers_.erase(subscribed);
  if (key.kind() != ScopeKind::product) release(key.governingTree());
}

void SyncLive::release(const ScopeKey& tree) {
  const auto cached = trees_.find(tree);
  if (--cached->second.readers == 0) trees_.erase(cached);
}

}

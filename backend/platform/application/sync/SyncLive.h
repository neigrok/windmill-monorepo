#pragma once

#include "platform/application/sync/SyncCatalog.h"
#include "platform/domain/Ids.h"
#include "platform/domain/sync/Scope.h"
#include "platform/domain/sync/Wire.h"
#include "platform/ports/ChangeFeed.h"
#include "platform/ports/SyncStore.h"

#include <json/json.h>

#include <cstddef>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace wm::sync {

// One live socket as the engine sees it (§9.5). The WebSocket adapter implements it over its connection.
class LiveSocket {
public:
  virtual ~LiveSocket() = default;
  // Queues the frame onto the connection. It never blocks and never throws: publish calls it after COMMIT.
  virtual void send(const Json::Value& frame) = 0;
};

// §6.8 and §9.5: the scopes each socket subscribes, the in-memory access cache every fan-out decides by, and the
// frames. Every method may run on any thread at the same time as the others; a socket unknown to it is ignored.
class SyncLive final : public ChangeFeed {
public:
  SyncLive(const SyncCatalog& catalog, SyncStore& store, Limits limits);

  // `principal` is nullopt for a guest.
  void open(std::shared_ptr<LiveSocket> socket, std::optional<UserId> principal);
  void close(const LiveSocket& socket);
  // {op: sub}: each readable scope is subscribed, each other one answers gone or not-found, and the client pulls.
  // It reads the store, so it runs on a blocking thread.
  void subscribe(const LiveSocket& socket, const Json::Value& scopeRefs);
  void unsubscribe(const LiveSocket& socket, const Json::Value& scopeRefs);
  // The socket's session no longer re-proves: it reads as signed out from now on, and every subscription it
  // can no longer read gets not-found and ends.
  void signOut(const LiveSocket& socket);
  // On the admitting worker, inside the scope's mutex, so it only queues frames.
  void publish(const CommittedChange& change) override;

private:
  // One open socket: who it reads as, and the scopes it subscribes.
  struct Subscriber {
    std::shared_ptr<LiveSocket> socket;
    std::optional<UserId> principal;
    std::set<ScopeKey> scopes;
  };

  // The cached facts of one tree, which its own subscriptions and its overlays' read. `readers` counts them, and
  // every sub still reading its snapshot, so a change published meanwhile is folded in rather than missed.
  struct CachedTree {
    std::optional<ScopeFacts> facts;  // as of `seq`; nullopt until a snapshot or a publish tells
    Seq seq = 0;
    bool dead = false;                // final, whatever an older snapshot says
    std::size_t readers = 0;

    void learn(const ScopeFacts& told, Seq at);
    std::optional<ScopeFacts> current() const;
  };

  // One ref of a sub frame, and the key it resolves to for the socket's principal.
  struct Wanted {
    std::string ref;
    std::optional<ScopeKey> key;
  };

  // A sub in three steps: watch the trees its refs read, read them in one snapshot without the lock, decide.
  std::vector<Wanted> watch(const LiveSocket& socket, const Json::Value& scopeRefs);
  std::map<ScopeKey, std::optional<ScopeRow>> readTrees(const std::vector<Wanted>& wanted);
  void decide(const LiveSocket& socket, const std::vector<Wanted>& wanted, const std::map<ScopeKey, std::optional<ScopeRow>>& trees);
  void unwatch(const std::vector<Wanted>& wanted);

  // What every fan-out does, in order: fold the change into the cache, end who lost access, send the changes,
  // answer the deaths.
  std::vector<ScopeKey> learn(const CommittedChange& change);
  void sendChange(const std::string& epoch, const ScopeChange& changed);
  void answerDeath(const ScopeKey& killed);

  // D-4 over the cache, for a subscription: read, and gone for the owner of a dead one.
  Access accessTo(const ScopeKey& key, const std::optional<UserId>& principal) const;
  void endUnreadable(Subscriber& subscriber, const std::function<bool(const ScopeKey&)>& among);
  void end(Subscriber& subscriber, const ScopeKey& key, const Access& access);
  void attach(Subscriber& subscriber, const ScopeKey& key);
  void detach(Subscriber& subscriber, const ScopeKey& key);
  void release(const ScopeKey& tree);

  const SyncCatalog& catalog_;
  SyncStore& store_;
  Limits limits_;
  std::mutex mutex_;
  std::map<const LiveSocket*, Subscriber> sockets_;
  std::map<ScopeKey, std::set<const LiveSocket*>> subscribers_;
  std::map<ScopeKey, CachedTree> trees_;
};

}

#pragma once

#include "products/roadmap/ports/PresenceBus.h"

#include <drogon/WebSocketConnection.h>
#include <trantor/net/EventLoop.h>

#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace wm {

// A frame for a connection, sent from `loop` after everything queued there before it. The framework sends at once from
// a connection's own loop and through that loop's queue from any other thread, so a frame sent straight from a handler
// goes out ahead of frames other threads queued while that handler ran: a writer was sent the broadcast of its own
// frame before those of earlier seqs. Queued every time, on the loop the connection lives on, a connection's frames go
// out in the order they were handed over, and no lock is held while one is sent. With no loop — a test's thread — the
// frame is sent at once.
inline void sendInOrder(trantor::EventLoop* loop, const drogon::WebSocketConnectionPtr& conn,
                        std::shared_ptr<const std::string> text) {
  if (!loop) {
    if (conn->connected()) conn->send(*text);
    return;
  }
  loop->queueInLoop([conn, text = std::move(text)] {
    if (conn->connected()) conn->send(*text);
  });
}

// What a subscription may receive of a tree: nothing, what every reader does, or all its writer does.
enum class Reach { none, reader, writer };

// Tracks which sockets subscribe to which tree and fans a room's ops — and a caller's own
// progress — out to them. Presence is not on this bus: PresenceHub keeps its own roster.
class WsPresenceBus : public PresenceBus {
public:
  // `user` is the connection's authenticated account (empty for anonymous viewers), remembered
  // so a private progress frame can be fanned out to just that user's own sessions. Called on the
  // loop the connection lives on, which is remembered too: every fan-out to it is queued there
  // (sendInOrder), so a tree's broadcasts reach each subscriber in the order the tree made them.
  void subscribe(const TreeId& tree, const drogon::WebSocketConnectionPtr& conn, const UserId& user);
  void drop(const drogon::WebSocketConnectionPtr& conn);

  // What a subscription may still receive of this tree. Every fan-out passes through it, and a
  // connection it answers `none` is dropped from the tree. Installed once at wiring, before any
  // traffic; with none installed every subscriber is a reader.
  using ReadGate = std::function<Reach(const TreeId&, const drogon::WebSocketConnectionPtr&)>;
  void setReadGate(ReadGate gate);
  // Re-run the gate now, with no edit to carry, so a revocation does not wait for the tree's
  // next broadcast.
  void resweep(const TreeId& tree);
  // The same over every tree that has a subscriber.
  void resweepAll();
  // Every connection subscribed to anything, deduplicated.
  std::vector<drogon::WebSocketConnectionPtr> connections() const;

  void broadcastSubgraph(const TreeId& tree, Seq seq, const Subgraph& subgraph) override;
  void broadcastProgress(const TreeId& tree, const UserId& user, const Progress& marks) override;

private:
  std::set<drogon::WebSocketConnectionPtr> subscribersOf(const TreeId& tree) const;
  // A connection still admitted to a tree: how much of it it may receive, and what its subscription remembered.
  struct Admitted {
    drogon::WebSocketConnectionPtr conn;
    Reach reach;
    std::string user;  // empty = anonymous
    trantor::EventLoop* loop;
  };
  // Who may still receive `tree` and how much of it, with everyone the gate refused already dropped.
  std::vector<Admitted> admitted(const TreeId& tree);

  struct Subscriber {
    std::string user;  // empty = anonymous
    trantor::EventLoop* loop;  // the loop the connection lives on, none for one subscribed outside any
  };
  mutable std::mutex mutex_;
  std::map<std::string, std::set<drogon::WebSocketConnectionPtr>> subscribers_;
  std::map<drogon::WebSocketConnectionPtr, Subscriber> connections_;
  ReadGate gate_;
};

}

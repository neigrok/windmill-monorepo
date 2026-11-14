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

// A frame's place in a connection's send order, taken before the frame is ready. A subscriber's first frame of a
// channel — the delta, the progress graft — reports a state read once the subscriber has joined and written out
// later, and every frame handed to the connection in between must follow it: so the place is taken at the join, as a
// queued send that has nothing to send yet, and `send` gives it its frame. Both happen in one handler on the connection's own loop,
// which runs nothing it has queued until that handler returns, so the frame is there when its turn comes; a place
// never given a frame sends nothing. With no loop — a test's thread — nothing can come between, and `send` sends at
// once.
class PlaceInOrder {
public:
  PlaceInOrder(trantor::EventLoop* loop, drogon::WebSocketConnectionPtr conn) : loop_(loop), conn_(std::move(conn)) {
    if (!loop_) return;
    loop_->queueInLoop([conn = conn_, frame = frame_] {
      if (!frame->empty() && conn->connected()) conn->send(*frame);
    });
  }
  void send(std::string text) {
    if (loop_) {
      *frame_ = std::move(text);
      return;
    }
    if (conn_->connected()) conn_->send(text);
  }

private:
  trantor::EventLoop* loop_;
  drogon::WebSocketConnectionPtr conn_;
  std::shared_ptr<std::string> frame_ = std::make_shared<std::string>();
};

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
  // Answers the places of the subscription's first frames, taken with the join: the delta's, then the progress
  // graft's. The caller holds the tree's strand, as every broadcast of the tree's is made under it: so the
  // broadcasts handed to this connection before the delta's place are the ones the delta's head covers, and every
  // one handed over after it follows the delta, whenever the delta is written out. An echo reaches the connection
  // only once it has joined, so every echo follows the graft; one that tells a mark made before the graft's marks
  // were read repeats what the graft holds.
  struct FirstFrames {
    PlaceInOrder delta;
    PlaceInOrder graft;
  };
  FirstFrames subscribe(const TreeId& tree, const drogon::WebSocketConnectionPtr& conn, const UserId& user);
  // The connection's subscription to this tree alone ends; what its subscription remembered stays until it closes.
  void unsubscribe(const TreeId& tree, const drogon::WebSocketConnectionPtr& conn);
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
  // `{t: "subtree", treeId, seq, step, subtree: {id, depth}}`, the same bytes to every subscriber.
  void broadcastSubtree(const TreeId& tree, Seq seq, const NodeId& step, const Subtree& subtree) override;
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

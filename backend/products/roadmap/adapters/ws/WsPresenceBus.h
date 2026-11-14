#pragma once

#include "products/roadmap/ports/PresenceBus.h"

#include <drogon/WebSocketConnection.h>
#include <trantor/net/EventLoop.h>
#include <trantor/utils/Logger.h>

#include <chrono>
#include <cstddef>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace wm {

// What the server holds for one subscriber that is not taking it. A frame handed to a connection that cannot write it
// stays in the process, and a peer that stops reading would have every later broadcast kept for it without limit. The
// connection says how many bytes it has written to its socket (bytesSent, third_party/drogon patch 0004): any byte
// written since the last frame was handed over is progress, a frame half-written included, so a tab on a slow link
// taking a delta of any size is never stalled. A subscriber is stalled when more than kStalledBytes have been handed
// to it since it last wrote a byte and it has written none for kStalledFor — a tab that is merely quiet under light
// traffic stays — or at once when more than kStalledCeilingBytes have, whatever the time. The frame that finds it so
// is not handed over, and one frame alone never stalls it, whatever its size: a first delta past the ceiling goes.
// The subscriber is then dropped: the connection is closed, which is what a tab reconnects on, and its subscribe
// delta is the cheap way to catch up.
class Outbound {
public:
  // More than a tab in the background of a quiet tree is ever behind by; the window is longer than any pause of a
  // healthy socket and short enough that a busy tree's broadcasts in it stay far under the ceiling.
  static constexpr std::size_t kStalledBytes = 1024 * 1024;
  static constexpr std::chrono::seconds kStalledFor{30};
  // The most handed to a connection that writes nothing, however fast frames come. The process holds about three
  // times that for it, measured: the framework copies a frame into the connection's buffer, which grows by doubling.
  static constexpr std::size_t kStalledCeilingBytes = 16 * 1024 * 1024;

  // What a stalled subscriber had been handed since it last wrote, and for how long it had written nothing.
  struct Stalled {
    std::size_t queuedBytes;
    std::chrono::milliseconds idle;
    bool operator==(const Stalled&) const = default;
  };

  // A frame of `bytes` is about to be handed to the connection, which has written `sent` bytes so far. Answers the
  // stall when what it was handed before this frame is already too much; the caller then closes the connection and
  // hands it nothing more.
  std::optional<Stalled> handing(std::size_t bytes, std::size_t sent, std::chrono::steady_clock::time_point now) {
    if (!began_ || sent != sent_) {
      began_ = true;
      sent_ = sent;
      wroteAt_ = now;
      queued_ = 0;
    }
    const auto idle = std::chrono::duration_cast<std::chrono::milliseconds>(now - wroteAt_);
    if (queued_ > kStalledCeilingBytes || (queued_ > kStalledBytes && idle > kStalledFor)) {
      dropped_ = true;
      return Stalled{queued_, idle};
    }
    queued_ += bytes;
    return std::nullopt;
  }
  bool dropped() const { return dropped_; }

private:
  bool began_ = false;
  bool dropped_ = false;
  std::size_t sent_ = 0;
  std::size_t queued_ = 0;
  std::chrono::steady_clock::time_point wroteAt_;
};

// Hands `text` to the connection now, on its loop: counted against `outbound` when the connection is a subscriber's,
// and the connection dropped in place of the send when it is stalled. One line tells a drop: the door, a size bucket
// of what was held and how long the connection had written nothing — nothing that names a tree, an account or a
// connection.
void handOver(const drogon::WebSocketConnectionPtr& conn, const std::shared_ptr<Outbound>& outbound, const std::string& text);

// A frame for a connection, sent from `loop` after everything queued there before it. The framework sends at once from
// a connection's own loop and through that loop's queue from any other thread, so a frame sent straight from a handler
// goes out ahead of frames other threads queued while that handler ran: a writer was sent the broadcast of its own
// frame before those of earlier seqs. Queued every time, on the loop the connection lives on, a connection's frames go
// out in the order they were handed over, and no lock is held while one is sent. With no loop — a test's thread — the
// frame is sent at once. A subscriber's frames are counted against its `outbound` (handOver); a reply to a connection
// that subscribes to nothing passes none.
inline void sendInOrder(trantor::EventLoop* loop, const drogon::WebSocketConnectionPtr& conn,
                        std::shared_ptr<const std::string> text, std::shared_ptr<Outbound> outbound = nullptr) {
  if (!loop) {
    handOver(conn, outbound, *text);
    return;
  }
  loop->queueInLoop([conn, text = std::move(text), outbound = std::move(outbound)] { handOver(conn, outbound, *text); });
}

// A frame's place in a connection's send order, taken before the frame is ready. A subscriber's first frame of a
// channel — the delta, the progress graft — reports a state read once the subscriber has joined and written out
// later, and every frame handed to the connection in between must follow it: so the place is taken at the join, as a
// queued send that has nothing to send yet, and `send` gives it its frame. Both happen in one handler on the
// connection's own loop, which runs nothing it has queued until that handler returns, so the frame is there when its
// turn comes; a place never given a frame sends nothing. With no loop — a test's thread — nothing can come between,
// and `send` sends at once.
class PlaceInOrder {
public:
  PlaceInOrder(trantor::EventLoop* loop, drogon::WebSocketConnectionPtr conn, std::shared_ptr<Outbound> outbound)
      : loop_(loop), conn_(std::move(conn)), outbound_(std::move(outbound)) {
    if (!loop_) return;
    loop_->queueInLoop([conn = conn_, frame = frame_, outbound = outbound_] {
      if (!frame->empty()) handOver(conn, outbound, *frame);
    });
  }
  void send(std::string text) {
    if (loop_) {
      *frame_ = std::move(text);
      return;
    }
    handOver(conn_, outbound_, text);
  }

private:
  trantor::EventLoop* loop_;
  drogon::WebSocketConnectionPtr conn_;
  std::shared_ptr<Outbound> outbound_;
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
    std::shared_ptr<Outbound> outbound;
  };
  // Who may still receive `tree` and how much of it, with everyone the gate refused already dropped.
  std::vector<Admitted> admitted(const TreeId& tree);

  struct Subscriber {
    std::string user;  // empty = anonymous
    trantor::EventLoop* loop;  // the loop the connection lives on, none for one subscribed outside any
    std::shared_ptr<Outbound> outbound;  // what it has been handed and not written: one for the connection, every tree
  };
  mutable std::mutex mutex_;
  std::map<std::string, std::set<drogon::WebSocketConnectionPtr>> subscribers_;
  std::map<drogon::WebSocketConnectionPtr, Subscriber> connections_;
  ReadGate gate_;
};

}

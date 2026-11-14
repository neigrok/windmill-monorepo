#pragma once

#include "products/roadmap/ports/PresenceBus.h"

#include <drogon/WebSocketConnection.h>
#include <trantor/net/EventLoop.h>
#include <trantor/utils/Logger.h>

#include <chrono>
#include <cstddef>
#include <deque>
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

// What a frame the server sends a connection is, by which the rules below weigh what the connection has not taken: a
// subscription's first frame, its delta or its progress graft; a live one, a tree's broadcast or the echo of a mark;
// the reply to a frame the connection sent; or a presence frame.
enum class FrameKind { first, live, reply, presence };

// What the server has handed one connection that the connection has not written to its socket. A frame handed to a
// connection that cannot write it stays in the process, so a peer that stops reading would have everything sent to it
// kept without limit. Every frame the server sends the connection is entered here with the bytes it takes on the wire,
// in the order handed, and the connection says how many bytes it has written (bytesSent, third_party/drogon patch
// 0004): those bytes leave what is pending, oldest frame first, so what is pending is known to the byte, and by kind.
// The framework's own control frames, a ping or a pong of a few bytes, are not entered; a written one is taken off
// what is pending, which is those few bytes early.
//
// Three rules drop a connection, each judged on what was pending before the frame being handed, so one frame alone
// never drops it, whatever its size:
//   stalled — something is pending and not one byte was written for kStalledAfter. Judged on a timer too, so a
//             connection that stops reading on a tree nobody writes is dropped as well.
//   behind  — more than kLiveBacklogBytes of live frames are pending: a reader that takes bytes but cannot keep up
//             is dropped, and its next subscribe is answered one delta in place of the backlog. A subscription's
//             first frames, replies and presence never count toward it, so a large delta, or two back to back, is
//             never behind.
//   ceiling — more than kPendingCeilingBytes are pending of any kind: a peer that subscribes again and again without
//             reading.
// The frame that finds a rule broken is not handed over, and the connection is closed: a tab reconnects on that, and
// its subscribe delta is the cheap way to catch up. Touched only on the loop the connection lives on.
class Outbound {
public:
  // Longer than a reader that is reading goes without the server writing it a byte. The kernel takes a slow
  // reader's bytes in bursts of about half a megabyte, so the gap between two writes is that over its rate: measured
  // on loopback 5 s at 100 KB/s, 26 s at 20, 52 s at 10 and 104 s at 5 KB/s, the slowest reader this never drops.
  static constexpr std::chrono::seconds kStalledAfter{120};
  static constexpr std::size_t kLiveBacklogBytes = 16 * 1024 * 1024;
  // Past twice the delta of the largest tree of plain text, 10,000 nodes each described in 16,000 characters: 156 MiB
  // measured.
  static constexpr std::size_t kPendingCeilingBytes = 320 * 1024 * 1024;

  enum class Rule { stalled, behind, ceiling };
  // The rule that dropped a connection, what was pending then and for how long it had written nothing.
  struct Dropped {
    Rule rule;
    std::size_t pendingBytes;
    std::chrono::milliseconds idle;
    bool operator==(const Dropped&) const = default;
  };

  // The connection has written `sent` bytes so far: what that covers leaves what is pending, and the rules are judged
  // on the rest. With none broken, a frame of `wireBytes` and `kind` is entered as handed.
  std::optional<Dropped> handing(std::size_t wireBytes, FrameKind kind, std::size_t sent,
                                 std::chrono::steady_clock::time_point now);
  // The same judgement with nothing handed: the timer's.
  std::optional<Dropped> judged(std::size_t sent, std::chrono::steady_clock::time_point now);
  bool dropped() const { return dropped_; }
  std::size_t pendingBytes() const { return pendingBytes_; }
  std::size_t pendingLiveBytes() const { return liveBytes_; }

private:
  // A run of pending bytes of one kind: frames of one kind handed one after another are one run.
  struct Run {
    std::size_t bytes;
    FrameKind kind;
  };
  std::deque<Run> pending_;
  std::size_t pendingBytes_ = 0;
  std::size_t liveBytes_ = 0;
  bool began_ = false;
  bool dropped_ = false;
  std::size_t sent_ = 0;
  // When the connection last wrote a byte, or was last handed a frame with nothing pending.
  std::chrono::steady_clock::time_point idleSince_;
};

// What every drop on a bus is judged by and told to: the clock, and the count that makes a wave of drops visible. A
// drop is one WARN line with its rule; more than kWaveDrops of them within kWaveWindow is one report under
// `roadmap.ws.drop_wave`, at most one a window, with the count per rule and nothing else.
class DropWatch {
public:
  using Now = std::function<std::chrono::steady_clock::time_point()>;
  static constexpr std::size_t kWaveDrops = 10;
  static constexpr std::chrono::minutes kWaveWindow{5};

  explicit DropWatch(Now now) : now_(std::move(now)) {}
  std::chrono::steady_clock::time_point now() const { return now_(); }
  void dropped(const Outbound::Dropped& drop);

private:
  const Now now_;
  std::mutex mutex_;
  std::deque<std::pair<std::chrono::steady_clock::time_point, Outbound::Rule>> recent_;
  std::optional<std::chrono::steady_clock::time_point> reported_;
};

// A connection's way out: the loop it lives on, what it has been handed, and where its drop is told.
struct Lane {
  trantor::EventLoop* loop;  // none for a connection opened outside any, as a test's is
  std::shared_ptr<DropWatch> watch;
  Outbound outbound;
};

// Hands `text` to the connection now, on its loop, entered in its lane as `kind`; a connection a rule has dropped is
// closed in place of the send, and handed nothing after. One line tells a drop: the door, the rule, a size bucket of
// what was pending and how long the connection had written nothing — nothing that names a tree, an account or a
// connection.
void handOver(const drogon::WebSocketConnectionPtr& conn, const std::shared_ptr<Lane>& lane, const std::string& text,
              FrameKind kind);
// The timer's judgement of one connection, on its loop: nothing is handed, and a connection a rule has dropped is
// closed and told as handOver tells it.
void judge(const drogon::WebSocketConnectionPtr& conn, const std::shared_ptr<Lane>& lane);

// A frame for a connection, sent from its loop after everything queued there before it. The framework sends at once
// from a connection's own loop and through that loop's queue from any other thread, so a frame sent straight from a
// handler goes out ahead of frames other threads queued while that handler ran: a writer was sent the broadcast of its
// own frame before those of earlier seqs. Queued every time, on the loop the connection lives on, a connection's
// frames go out in the order they were handed over, and no lock is held while one is sent. With no loop — a test's
// thread — the frame is sent at once.
inline void sendInOrder(const drogon::WebSocketConnectionPtr& conn, const std::shared_ptr<Lane>& lane,
                        std::shared_ptr<const std::string> text, FrameKind kind) {
  if (!lane->loop) {
    handOver(conn, lane, *text, kind);
    return;
  }
  lane->loop->queueInLoop([conn, lane, text = std::move(text), kind] { handOver(conn, lane, *text, kind); });
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
  PlaceInOrder(drogon::WebSocketConnectionPtr conn, std::shared_ptr<Lane> lane)
      : conn_(std::move(conn)), lane_(std::move(lane)) {
    if (!lane_->loop) return;
    lane_->loop->queueInLoop([conn = conn_, frame = frame_, lane = lane_] {
      if (!frame->empty()) handOver(conn, lane, *frame, FrameKind::first);
    });
  }
  void send(std::string text) {
    if (lane_->loop) {
      *frame_ = std::move(text);
      return;
    }
    handOver(conn_, lane_, text, FrameKind::first);
  }

private:
  drogon::WebSocketConnectionPtr conn_;
  std::shared_ptr<Lane> lane_;
  std::shared_ptr<std::string> frame_ = std::make_shared<std::string>();
};

// What a subscription may receive of a tree: nothing, what every reader does, or all its writer does.
enum class Reach { none, reader, writer };

// Tracks which sockets subscribe to which tree and fans a room's ops — and a caller's own
// progress — out to them. Presence is not on this bus: PresenceHub keeps its own roster. Every frame the server sends
// a tree-socket connection passes through here all the same — a fan-out, a subscription's first frames, a reply, a
// presence frame — since each is entered in the connection's lane (Outbound), which is exact only when none is missed.
class WsPresenceBus : public PresenceBus {
public:
  explicit WsPresenceBus(DropWatch::Now now = [] { return std::chrono::steady_clock::now(); })
      : watch_(std::make_shared<DropWatch>(std::move(now))) {}

  // A connection the server sends frames to from here on, until drop. Called on the loop the connection lives on,
  // which is remembered: every frame to it is handed over there.
  void open(const drogon::WebSocketConnectionPtr& conn);
  // A reply to the connection, in its send order (sendInOrder), or a presence frame, handed over as the framework
  // sends: at once on the connection's own loop, through that loop's queue from any other thread. A connection that
  // was never opened here, or has been dropped, is sent nothing.
  void send(const drogon::WebSocketConnectionPtr& conn, std::shared_ptr<const std::string> text, FrameKind kind);
  // One pass of the timer the routes arm every kJudgeEverySeconds: every open connection judged with nothing handed,
  // each on its own loop, so one that stopped writing is dropped within that much of Outbound::kStalledAfter whatever
  // its trees do.
  static constexpr double kJudgeEverySeconds = 5.0;
  void dropStalled();

  // `user` is the connection's authenticated account (empty for anonymous viewers), remembered
  // so a private progress frame can be fanned out to just that user's own sessions. Called on the
  // loop the connection lives on, as open is, which it stands in for on a connection not yet opened: every
  // fan-out to it is queued there (sendInOrder), so a tree's broadcasts reach each subscriber in the order the
  // tree made them.
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
    std::shared_ptr<Lane> lane;
  };
  // Who may still receive `tree` and how much of it, with everyone the gate refused already dropped.
  std::vector<Admitted> admitted(const TreeId& tree);

  struct Connection {
    std::string user;  // empty = anonymous, and until it subscribes
    std::shared_ptr<Lane> lane;  // one for the connection, every tree and every kind of frame
  };
  // The connection's entry, made with the current thread's loop when it has none. Caller holds mutex_.
  Connection& entryOf(const drogon::WebSocketConnectionPtr& conn);

  const std::shared_ptr<DropWatch> watch_;
  mutable std::mutex mutex_;
  std::map<std::string, std::set<drogon::WebSocketConnectionPtr>> subscribers_;
  std::map<drogon::WebSocketConnectionPtr, Connection> connections_;
  ReadGate gate_;
};

}

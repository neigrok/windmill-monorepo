#pragma once

#include "platform/application/Heartbeat.h"
#include "products/roadmap/adapters/ws/PresenceHub.h"
#include "products/roadmap/adapters/ws/WsPresenceBus.h"
#include "platform/application/AuthService.h"
#include "products/roadmap/application/ProgressService.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "platform/ports/Clock.h"
#include "products/roadmap/ports/OpLog.h"

#include <drogon/HttpRequest.h>
#include <drogon/WebSocketConnection.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <unordered_map>

namespace wm {

// Coordinates the socket layer with the rooms: subscribe → snapshot, cmd → merge +
// broadcast, presence → relay. A single mutex serializes room access — a coarse
// stand-in for the per-tree strand (§11) until rooms get real strands.
class Collab {
public:
  // `allowedOrigins` is the same set main.cpp composes for CORS (the app's own origin plus
  // WINDMILL_ALLOWED_ORIGINS), handed here rather than parsed a second time, so the socket and the
  // JSON API can never disagree about who may talk to this server from a browser.
  Collab(RoomRegistry& registry, OpLog& ops, WsPresenceBus& bus,
         ProgressService& progress, AuthService& auth, PresenceHub& presence, Clock& clock,
         std::set<std::string> allowedOrigins);

  void onOpen(const drogon::HttpRequestPtr& req, const drogon::WebSocketConnectionPtr& conn);
  void onMessage(const drogon::WebSocketConnectionPtr& conn, const std::string& text);
  void onClose(const drogon::WebSocketConnectionPtr& conn);

  // One pass of the periodic reader re-proof: re-prove every open subscription's session, then
  // re-run the read gate over every tree that has one. Two revocations reach a reader by no other
  // road, which is why this is a clock and not a reaction to an edit:
  //   - a session revoked on a tree NOBODY is editing — there is no broadcast to be gated;
  //   - presence. PresenceHub::flush fans cursors and selections straight to its own roster at
  //     20 Hz, never through the bus, so a revoked reader kept watching a peer's live cursor and
  //     the node ids they selected on a tree the bus would already have dropped them from.
  // It also keeps the database off the write path: re-proving inside a fan-out meant one lookup
  // per subscriber, serially, while holding the tree's strand — a spike every minute, linear in
  // readers. Public so a test can run exactly one pass instead of waiting for the clock.
  void reproveReaders();

private:
  void subscribe(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, const Json::Value& frame);
  // How often an open socket re-proves its session — on a write, on a subscribe, and on the
  // periodic reader pass. A revoked session keeps writing for at most this long, and keeps reading
  // for at most this plus kReproveEverySeconds: the trade against a lookup per edit and per read.
  static constexpr std::uint64_t kRevalidateEveryMs = 60000;

  bool stillAuthorized(const drogon::WebSocketConnectionPtr& conn);
  // May this connection still READ this tree? The write path re-proved its session and its
  // ownership on every frame while the read path proved nothing after the subscribe — so a
  // re-privated tree kept streaming, and a revoked session kept receiving. This is the read half,
  // stated once: the bus asks it before every fan-out, a share flip and a deletion ask it the
  // moment they land, reproveReaders asks it on a clock, and subscribe asks it before a room is
  // ever materialized.
  //
  // It is a VERDICT and never a lookup: a fan-out runs it under the tree's strand, so it may not
  // touch the database. It reads the principal as the last re-proof left it, and the tree's access
  // facts, which for the open room a broadcast implies is a map lookup. Re-proving the session is
  // the separate, slower step — stillAuthorized — which only ever narrows a principal, and runs
  // where a stall costs nobody: on subscribe's own thread, and on the sweeper's.
  bool mayRead(const drogon::WebSocketConnectionPtr& conn, const TreeId& tree);
  void subgraphFrame(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, const Json::Value& frame);
  void progress(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, const Json::Value& frame);
  bool overRate(const drogon::WebSocketConnectionPtr& conn);  // per-connection message-rate gate

  RoomRegistry& registry_;
  OpLog& ops_;
  WsPresenceBus& bus_;
  ProgressService& progress_;
  AuthService& auth_;  // resolves the wm_session cookie / bearer at the socket upgrade
  PresenceHub& presence_;
  Clock& clock_;  // wall time for the room's HLC; the room owns the clock, this feeds it now
  std::set<std::string> allowedOrigins_;  // who may upgrade a socket from a browser

  // How often the reader re-proof passes. A session revoked while its socket sits idle stops being
  // read within this plus kRevalidateEveryMs — the pass is what notices, the throttle is what it
  // costs. Both are deliberately loose: this is a background revocation, not a login check.
  static constexpr double kReproveEverySeconds = 15.0;
  // Last, so it destructs first — its destructor joins the sweeper, and that has to happen while
  // the bus, the registry and the presence roster a running pass touches are still alive.
  Heartbeat reprove_;
  std::atomic<std::uint64_t> actorSeq_{0};

  // Per-connection message-rate bucket, so one socket can't flood the write path. Keyed by
  // the connection pointer; created on open, erased on close.
  struct WsRate { double tokens; std::chrono::steady_clock::time_point seen; };
  std::mutex wsMutex_;
  std::unordered_map<const void*, WsRate> wsRate_;
};

void setCollab(std::shared_ptr<Collab> collab);
Collab* collab();

}

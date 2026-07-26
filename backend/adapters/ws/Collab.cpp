#include "adapters/ws/Collab.h"

#include "adapters/json/SubgraphJson.h"
#include "adapters/json/TreeJson.h"
#include "application/TreeRoom.h"
#include "domain/Access.h"
#include "domain/Auth.h"

#include <optional>
#include <stdexcept>

#include <trantor/utils/Logger.h>

namespace wm {

namespace {
std::shared_ptr<Collab> g_collab;
constexpr double kWsRatePerSec = 50.0;  // sustained frames/sec per connection
constexpr double kWsBurst = 100.0;      // short-burst allowance
constexpr std::uint64_t kMaxSkewMs = 5 * 60 * 1000;  // a frame stamped past now+5min is refused whole

const Principal& principalOf(const drogon::WebSocketConnectionPtr& conn) {
  return conn->getContextRef<Principal>();
}

UserId actorOf(const drogon::WebSocketConnectionPtr& conn) {
  return principalOf(conn).user;
}

void send(const drogon::WebSocketConnectionPtr& conn, const Json::Value& frame) {
  if (conn->connected()) conn->send(dump(frame));
}
}

void setCollab(std::shared_ptr<Collab> collab) { g_collab = std::move(collab); }
Collab* collab() { return g_collab.get(); }

Collab::Collab(RoomRegistry& registry, OpLog& ops, WsPresenceBus& bus,
               ProgressService& progress, AuthService& auth, PresenceHub& presence, Clock& clock)
    : registry_(registry), ops_(ops), bus_(bus), progress_(progress),
      auth_(auth), presence_(presence), clock_(clock) {}

void Collab::onOpen(const drogon::HttpRequestPtr& req, const drogon::WebSocketConnectionPtr& conn) {
  // Resolve the session at the upgrade (frames carry no cookie): an authenticated user may
  // write; anyone else joins as a read-only guest.
  std::string secret = req->getCookie("wm_session");
  if (secret.empty()) {
    std::string authorization = req->getHeader("authorization");
    if (authorization.rfind("Bearer ", 0) == 0) secret = authorization.substr(7);
  }
  std::optional<User> user = auth_.authenticate(secret);
  // Keep the session's digest — never the secret — so each write can re-prove the session is still
  // live, and a revocation reaches a connection that was opened before it.
  Principal principal =
      user ? Principal{user->id, true, sharableName(*user), auth_.digestOf(secret), clock_.nowMs()}
           : Principal{UserId{"u" + std::to_string(++actorSeq_)}, false, "", "", 0};
  conn->setContext(std::make_shared<Principal>(std::move(principal)));

  std::lock_guard<std::mutex> lock(wsMutex_);
  wsRate_[conn.get()] = WsRate{kWsBurst, std::chrono::steady_clock::now()};
}

void Collab::onClose(const drogon::WebSocketConnectionPtr& conn) {
  presence_.leave(conn);
  bus_.drop(conn);
  std::lock_guard<std::mutex> lock(wsMutex_);
  wsRate_.erase(conn.get());
}

bool Collab::overRate(const drogon::WebSocketConnectionPtr& conn) {
  const auto now = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> lock(wsMutex_);
  WsRate& rate = wsRate_[conn.get()];
  if (rate.seen == std::chrono::steady_clock::time_point{}) rate.tokens = kWsBurst;
  else rate.tokens = std::min(kWsBurst, rate.tokens + std::chrono::duration<double>(now - rate.seen).count() * kWsRatePerSec);
  rate.seen = now;
  if (rate.tokens < 1.0) return true;
  rate.tokens -= 1.0;
  return false;
}

void Collab::onMessage(const drogon::WebSocketConnectionPtr& conn, const std::string& text) {
  if (overRate(conn)) return;  // a flooding connection's frames are dropped, cheaply, before parse
  // Drogon does not wrap WS callbacks: an exception escaping here aborts the whole
  // process (trantor rethrows on its IO thread). Any malformed frame — wrong JSON types,
  // an unknown tree, over-nested payload — must degrade to a dropped message, never a crash.
  try {
    Json::Value frame = parse(text);
    if (!frame.isObject()) return;
    std::string type = frame.get("t", "").asString();
    // The client heartbeat: connection-scoped liveness, no tree lookup or auth — echo pong on the
    // same socket so an idle tab keeps the pipe warm and detects a half-open connection.
    if (type == "ping") { Json::Value pong(Json::objectValue); pong["t"] = "pong"; send(conn, pong); return; }
    std::string treeId = frame.get("treeId", "").asString();
    if (type == "subscribe") return subscribe(conn, treeId, frame);
    if (type == "subgraph") return subgraphFrame(conn, treeId, frame);
    if (type == "progress") return progress(conn, treeId, frame);
    if (type == "presence") { presence_.update(conn, TreeId{treeId}, frame); return; }
  } catch (const std::exception& error) {
    LOG_ERROR << "dropped malformed ws frame: " << error.what();
  }
}

// On subscribe, ship the client only what its version vector says it lacks — a delta computed
// against the tree's current state, carrying the server's frontier as coverage. A fresh client
// sends an empty vector, so the delta is the whole state; a returning one gets just the gap.
// Two-way anti-entropy: the client flushes its own delta back (§6), and both frontiers meet.
void Collab::subscribe(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, const Json::Value& request) {
  const Principal& principal = principalOf(conn);
  // An anonymous connection (a synthetic guest) reads as no caller — never as its guest id;
  // canRead then denies every private tree, and admits unlisted/public by id.
  std::optional<UserId> caller =
      principal.authenticated ? std::optional<UserId>(principal.user) : std::nullopt;

  VersionVector clientVector = versionVectorFromJson(request["vector"]);
  Json::Value frame;
  {
    std::lock_guard<std::mutex> lock(registry_.strandFor(TreeId{treeId}));
    try {
      TreeRoom* room = registry_.open(TreeId{treeId});
      // Gate the read BEFORE joining the bus or presence: an unreadable caller must never be
      // subscribed, or it would receive every later live broadcast. An absent tree (null) and a
      // private-denied one are rejected with the same "no such tree" — no existence leak. Only an
      // infrastructure failure falls to the catch, which answers generically and logs its detail.
      if (!room || !canRead(caller, room->owner(), room->visibility())) {
        Json::Value reject(Json::objectValue);
        reject["t"] = "reject";
        reject["treeId"] = treeId;
        reject["reason"] = "no such tree \"" + treeId + "\"";
        send(conn, reject);
        return;
      }
      // Readable: join the bus + presence under the strand, so no edit broadcast can slip
      // between the delta computed here and the subscription taking effect.
      bus_.subscribe(TreeId{treeId}, conn, principal.user);
      presence_.join(conn, TreeId{treeId});

      Subgraph delta = deltaBetween(room->exportState(), room->exportLegend(), clientVector);
      delta.treeId = TreeId{treeId};
      delta.frameId = "delta-" + std::to_string(room->head());
      delta.actor = "srv";
      // A renamed tree's title register rides the delta like any field the client lacks
      // (unset stamps — never-renamed titles — carry nothing to cover, so they stay home),
      // and the stated coverage owns the stamp so the client never flushes it back.
      if (!clientVector.covers(room->title().stamp)) delta.title = room->title();
      if (delta.coverage) delta.coverage->observe(room->title().stamp);
      frame = toJson(delta);
      frame["seq"] = static_cast<Json::Int64>(room->head());
    } catch (const std::exception& error) {
      // An infrastructure failure — never the socket's to relay: log the detail, reject generically.
      LOG_ERROR << "collab join " << treeId << " failed: " << error.what();
      Json::Value reject(Json::objectValue);
      reject["t"] = "reject";
      reject["treeId"] = treeId;
      reject["reason"] = "the server could not open this tree";
      send(conn, reject);
      return;
    }
  }
  send(conn, frame);
}

// A client-authored subgraph frame: the sole write path from a browser. The client stamped
// its own writes, so the server never re-stamps — it clamps gross clock skew, joins the frame
// verbatim, and acks. Legend/cap invariants are diagnostics now, never a refusal (§2), so the
// only rejections here are auth and ownership.
// A socket authenticates once, at the upgrade, and can then live for hours — so "sign out
// everywhere" and closing an account would not reach a connection already open, and a stolen
// session could keep writing long after it was revoked. Every WRITE re-proves its session, throttled
// to one lookup a minute so ordinary editing still costs nothing.
bool Collab::stillAuthorized(const drogon::WebSocketConnectionPtr& conn) {
  const std::shared_ptr<Principal> principal = conn->getContext<Principal>();
  if (!principal || !principal->authenticated) return false;
  if (principal->sessionDigest.empty()) return false;

  const std::uint64_t now = clock_.nowMs();
  if (now - principal->checkedAtMs < kRevalidateEveryMs) return true;

  if (!auth_.revalidate(principal->sessionDigest)) {
    principal->authenticated = false;  // revoked mid-connection: it is a guest from here on
    return false;
  }
  principal->checkedAtMs = now;
  return true;
}

void Collab::subgraphFrame(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, const Json::Value& frame) {
  const Principal& principal = principalOf(conn);
  std::string frameId = frame.get("frameId", "").asString();
  if (!stillAuthorized(conn)) {
    Json::Value reject(Json::objectValue);
    reject["t"] = "reject";
    reject["treeId"] = treeId;
    reject["frameId"] = frameId;
    reject["reason"] = "sign in to edit";
    send(conn, reject);
    return;
  }

  Subgraph incoming = subgraphFromJson(frame);
  incoming.treeId = TreeId{treeId};

  // Skew clamp: a frame stamped past now + 5min is refused whole and non-lossily — the client
  // keeps its lattice intact, folds serverNow into its clock, and retries. The title register
  // rides the same clamp — a runaway stamp must not own the name for years.
  std::uint64_t nowMs = clock_.nowMs();
  VersionVector front = frontier(incoming.graph, incoming.legend);
  if (incoming.title) front.observe(incoming.title->stamp);
  for (const auto& [actor, mark] : front.marks) {
    if (mark.physicalMs > nowMs + kMaxSkewMs) {
      Json::Value skew(Json::objectValue);
      skew["t"] = "skew";
      skew["treeId"] = treeId;
      skew["frameId"] = frameId;
      skew["serverNow"] = static_cast<Json::Int64>(nowMs);
      send(conn, skew);
      return;
    }
  }

  std::optional<Seq> seq;
  bool notOwner = false;
  bool notFound = false;
  {
    std::lock_guard<std::mutex> lock(registry_.strandFor(TreeId{treeId}));
    TreeRoom* room = registry_.open(TreeId{treeId});
    // stillAuthorized proved a real signed-in caller above, so principal.user is that user.
    // The read gate comes FIRST, exactly as applyEdit's does: a private tree the caller cannot
    // read is answered "no such tree" — byte-identical to an absent one — so a rejected write
    // never confirms the id names something. Only a readable-but-unowned tree (unlisted/public)
    // reaches the ownership message. An unowned private tree fails canRead and so can no longer
    // be written or claimed over the socket, matching applyEdit.
    if (!room || !canRead(principal.user, room->owner(), room->visibility())) {
      notFound = true;  // a write to an absent-or-unreadable tree is rejected, not a throw that closes the socket
    } else if (room->owner() && *room->owner() != principal.user) {
      notOwner = true;
    } else {
      seq = room->joinSubgraph(incoming, principal.user);
      if (!room->owner()) registry_.claim(TreeId{treeId}, principal.user);  // first writer claims it
      if (seq) registry_.persist(TreeId{treeId});  // persist before the ack, so the ack attests durability
    }
  }
  if (notFound || notOwner) {
    Json::Value reject(Json::objectValue);
    reject["t"] = "reject";
    reject["treeId"] = treeId;
    reject["frameId"] = frameId;
    reject["reason"] = notFound ? "no such tree \"" + treeId + "\"" : "this tree belongs to another account";
    send(conn, reject);
    return;
  }

  Json::Value ack(Json::objectValue);
  ack["t"] = "subgraphAck";
  ack["treeId"] = treeId;
  ack["frameId"] = frameId;
  if (seq) ack["seq"] = static_cast<Json::Int64>(*seq);
  send(conn, ack);
}

// Progress is the private per-user overlay (§6): it rides the same socket but never joins
// the shared op log. Record it (advisory prerequisite check against the loose graph, never
// rejected), then echo only to the same user's other sessions — not to collaborators.
void Collab::progress(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, const Json::Value& frame) {
  const Principal& principal = principalOf(conn);
  if (!stillAuthorized(conn)) {
    // Progress is a private per-account overlay — but a silent drop would lose a lapsed
    // session's marks invisibly. Echo the mark back in the reject so the client can requeue.
    Json::Value reject(Json::objectValue);
    reject["t"] = "reject";
    reject["treeId"] = treeId;
    reject["nodeId"] = frame.get("nodeId", "").asString();
    reject["status"] = frame.get("status", "").asString();
    reject["reason"] = "sign in to track progress";
    send(conn, reject);
    return;
  }

  NodeId node{frame.get("nodeId", "").asString()};
  std::optional<ProgressStatus> status = parseProgressStatus(frame.get("status", "").asString());
  if (node.empty() || !status) return;

  std::vector<NodeId> prerequisites;
  Hlc hlc;
  {
    std::lock_guard<std::mutex> lock(registry_.strandFor(TreeId{treeId}));
    try {
      TreeRoom* room = registry_.open(TreeId{treeId});
      // An absent (null) or private-denied tree: nothing to record against, and the socket must be
      // no existence oracle — return silently either way. Only an infra failure falls to the catch.
      if (!room || !canRead(principal.user, room->owner(), room->visibility())) return;
      prerequisites = room->prerequisitesOf(node);
      hlc = room->nextStamp(clock_.nowMs());  // progress shares the tree's clock so its LWW stays comparable
    } catch (const std::exception&) {
      return;  // an infrastructure failure — nothing to record; its detail is not the socket's to carry
    }
  }

  progress_.setStatus(prerequisites, TreeId{treeId}, principal.user, node, *status, hlc);
  // Echo to this user's own other sessions (their other tabs, a browser watching an agent's
  // MCP edits) — never to collaborators, since progress is a private per-account overlay.
  bus_.broadcastProgress(TreeId{treeId}, principal.user, node, *status);
}

}

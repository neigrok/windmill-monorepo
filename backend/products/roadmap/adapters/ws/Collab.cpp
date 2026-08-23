#include "products/roadmap/adapters/ws/Collab.h"

#include "products/roadmap/adapters/json/SubgraphJson.h"
#include "products/roadmap/adapters/json/TreeJson.h"
#include "products/roadmap/application/TreeRoom.h"
#include "products/roadmap/domain/Command.h"
#include "platform/domain/Access.h"
#include "platform/domain/Auth.h"

#include <optional>
#include <stdexcept>

#include <trantor/utils/Logger.h>

namespace wm {

namespace {
std::shared_ptr<Collab> g_collab;
constexpr double kWsRatePerSec = 50.0;  // sustained frames/sec per connection
constexpr double kWsBurst = 100.0;      // short-burst allowance
constexpr std::uint64_t kMaxSkewMs = 5 * 60 * 1000;  // a frame stamped past now+5min is refused whole
constexpr unsigned kMaxMarksPerFrame = 2000;

// parseHlc throws on a non-numeric stamp; nullopt keeps that a refusable frame, not a throw.
std::optional<Hlc> readHlc(const std::string& text) {
  try {
    return parseHlc(text);
  } catch (const std::exception&) {
    return std::nullopt;
  }
}

// Reject codes are a stable wire contract: clients branch on `code`, never on `reason`.
constexpr char kNoSuchTree[] = "no-such-tree";
constexpr char kServerError[] = "server-error";
constexpr char kSignInRequired[] = "sign-in-required";
constexpr char kTreeTooLarge[] = "tree-too-large";
// A frame refused for its content — an over-long id, a field past its cap — not for the tree's size.
constexpr char kBadFrame[] = "bad-frame";

const Principal& principalOf(const drogon::WebSocketConnectionPtr& conn) {
  return conn->getContextRef<Principal>();
}

UserId actorOf(const drogon::WebSocketConnectionPtr& conn) {
  return principalOf(conn).user;
}

void send(const drogon::WebSocketConnectionPtr& conn, const Json::Value& frame) {
  if (conn->connected()) conn->send(dump(frame));
}

Json::Value rejectFrame(const std::string& treeId, const char* code, const std::string& reason) {
  Json::Value reject(Json::objectValue);
  reject["t"] = "reject";
  reject["treeId"] = treeId;
  reject["code"] = code;
  reject["reason"] = reason;
  return reject;
}
}

void setCollab(std::shared_ptr<Collab> collab) { g_collab = std::move(collab); }
Collab* collab() { return g_collab.get(); }

Collab::Collab(RoomRegistry& registry, OpLog& ops, WsPresenceBus& bus,
               ProgressService& progress, AuthService& auth, PresenceHub& presence, Clock& clock,
               std::set<std::string> allowedOrigins)
    : registry_(registry), ops_(ops), bus_(bus), progress_(progress),
      auth_(auth), presence_(presence), clock_(clock), allowedOrigins_(std::move(allowedOrigins)),
      reprove_("ws-readers") {
  // Read authorization can be revoked under an open socket, so the bus asks before every fan-out.
  bus_.setReadGate([this](const TreeId& tree, const drogon::WebSocketConnectionPtr& conn) {
    if (mayRead(conn, tree)) return true;
    // A no is the whole revocation: leave the roster, and answer in a fresh subscribe's words.
    presence_.leave(conn, tree);
    send(conn, rejectFrame(tree.str(), kNoSuchTree, "no such tree \"" + tree.str() + "\""));
    return false;
  });
  registry_.whenAccessChanges([this](const TreeId& tree) { bus_.resweep(tree); });
  // The sweep covers what no edit or share flip reaches: an idle tree, and presence.
  reprove_.start(kReproveEverySeconds, kReproveEverySeconds, [this] { reproveReaders(); });
}

void Collab::reproveReaders() {
  // stillAuthorized can block on a database lookup: run it here, holding no strand.
  for (const auto& conn : bus_.connections()) stillAuthorized(conn);
  bus_.resweepAll();
}

void Collab::onOpen(const drogon::HttpRequestPtr& req, const drogon::WebSocketConnectionPtr& conn) {
  // A WebSocket upgrade gets no CORS preflight: a stated origin must be allow-listed, and a
  // client that states none is untouched.
  const std::string origin = req->getHeader("origin");
  if (!origin.empty() && !allowedOrigins_.count(origin)) {
    LOG_WARN << "ws upgrade refused: origin " << origin << " is not allow-listed";
    // A context first, then the close: drogon may still deliver a queued frame, and every
    // handler reads the Principal unchecked.
    conn->setContext(std::make_shared<Principal>(UserId{"u0"}, false, "", "", 0));
    conn->forceClose();
    return;
  }

  // Frames carry no cookie: resolve the session at the upgrade; anyone else is a read-only guest.
  std::string secret = req->getCookie("wm_session");
  if (secret.empty()) {
    std::string authorization = req->getHeader("authorization");
    if (authorization.rfind("Bearer ", 0) == 0) secret = authorization.substr(7);
  }
  std::optional<User> user = auth_.authenticate(secret);
  // Keep the digest, never the secret, so a write can re-prove the session. Built in place: a
  // Principal holds atomics and cannot be copied.
  if (user) {
    conn->setContext(std::make_shared<Principal>(user->id, true, sharableName(*user),
                                                 auth_.digestOf(secret), clock_.nowMs()));
  } else {
    conn->setContext(
        std::make_shared<Principal>(UserId{"u" + std::to_string(++actorSeq_)}, false, "", "", 0));
  }

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
  if (overRate(conn)) return;  // a flooding connection's frames are dropped before parse
  // Drogon does not wrap WS callbacks: an exception escaping here aborts the process.
  try {
    Json::Value frame = parse(text);
    if (!frame.isObject()) return;
    std::string type = frame.get("t", "").asString();
    // Heartbeat: connection-scoped, no tree lookup and no auth.
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

// Ship only what the client's version vector lacks, with the server's frontier as coverage.
void Collab::subscribe(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, const Json::Value& request) {
  const Principal& principal = principalOf(conn);

  // versionVectorFromJson throws past 64 bits, and an unanswered subscribe waits forever.
  VersionVector clientVector;
  try {
    clientVector = versionVectorFromJson(request["vector"]);
  } catch (const std::exception&) {
    send(conn, rejectFrame(treeId, kBadFrame, "this frame could not be read"));
    return;
  }

  Json::Value frame;
  {
    std::lock_guard<std::mutex> lock(registry_.strandFor(TreeId{treeId}));
    try {
      // Gate the read before the room is materialized and before joining the bus or presence,
      // re-proving the session first on this frame's own thread. An absent tree and a
      // private-denied one answer identically — no existence leak.
      stillAuthorized(conn);
      if (!mayRead(conn, TreeId{treeId})) {
        send(conn, rejectFrame(treeId, kNoSuchTree, "no such tree \"" + treeId + "\""));
        return;
      }
      TreeRoom* room = registry_.open(TreeId{treeId});
      if (!room) {
        send(conn, rejectFrame(treeId, kNoSuchTree, "no such tree \"" + treeId + "\""));
        return;
      }
      // Join under the strand, so no broadcast slips between the delta and the subscription.
      bus_.subscribe(TreeId{treeId}, conn, principal.user);
      presence_.join(conn, TreeId{treeId});

      Subgraph delta = deltaBetween(room->exportState(), room->exportLegend(), clientVector);
      delta.treeId = TreeId{treeId};
      delta.frameId = "delta-" + std::to_string(room->head());
      delta.actor = "srv";
      // Unset title stamps carry nothing; the stated coverage owns the stamp, so the client
      // never flushes it back.
      if (!clientVector.covers(room->title().stamp)) delta.title = room->title();
      if (delta.coverage) delta.coverage->observe(room->title().stamp);
      frame = toJson(delta);
      frame["seq"] = static_cast<Json::Int64>(room->head());
    } catch (const std::exception& error) {
      // An infrastructure failure is never the socket's to relay: log it, reject generically.
      LOG_ERROR << "collab join " << treeId << " failed: " << error.what();
      send(conn, rejectFrame(treeId, kServerError, "the server could not open this tree"));
      return;
    }
  }
  send(conn, frame);

  // Both lanes re-graft on every subscribe. Read OUTSIDE the strand — a room's lock is never
  // held across a database call.
  // Gate on `authenticated`, never on a non-empty user: a guest connection carries a real guest
  // identity, and this lane serves one account its own private marks or nothing.
  if (!principal.authenticated) return;
  Json::Value graft = toJson(progress_.progressOf(TreeId{treeId}, principal.user));
  graft["t"] = "progress";
  graft["treeId"] = treeId;
  // `graft`, not an echo: the receiver may re-baseline its coverage on it. An empty graft is
  // still sent — it states that the server holds nothing, which re-flushes the replica.
  graft["intent"] = "graft";
  send(conn, graft);
}

// A socket authenticates once and can live for hours, so every write re-proves its session,
// throttled to one lookup a minute.
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

// Connection identity and tree visibility both change under an open socket; ask both again.
bool Collab::mayRead(const drogon::WebSocketConnectionPtr& conn, const TreeId& tree) {
  const std::shared_ptr<Principal> principal = conn->getContext<Principal>();
  if (!principal) return false;
  // A principal stillAuthorized has narrowed is a guest: public and unlisted, never private.
  const std::optional<UserId> caller =
      principal->authenticated ? std::optional<UserId>(principal->user) : std::nullopt;
  // The stored access row, not a materialized room: refusing a reader never loads the lattice.
  const std::optional<TreeAccess> access = registry_.accessOf(tree);
  return access && canRead(caller, access->owner, access->visibility);
}

void Collab::subgraphFrame(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, const Json::Value& frame) {
  const Principal& principal = principalOf(conn);
  std::string frameId = frame.get("frameId", "").asString();
  if (!stillAuthorized(conn)) {
    Json::Value reject = rejectFrame(treeId, kSignInRequired, "sign in to edit");
    reject["frameId"] = frameId;
    send(conn, reject);
    return;
  }

  // A frame we cannot decode is refused by code: a throw answers nothing and strands the
  // client's in-flight entry for this frameId.
  Subgraph incoming;
  try {
    incoming = subgraphFromJson(frame);
  } catch (const std::exception&) {
    Json::Value reject = rejectFrame(treeId, kBadFrame, "this frame could not be read");
    reject["frameId"] = frameId;
    send(conn, reject);
    return;
  }
  incoming.treeId = TreeId{treeId};

  // Skew clamp: a frame stamped past now + 5min is refused whole, title register included.
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
  std::optional<Json::Value> reject;  // absent while the write is still admissible
  {
    std::lock_guard<std::mutex> lock(registry_.strandFor(TreeId{treeId}));
    // Both gates decide off the stored access row, before the room is materialized. Read gate
    // first: a private tree is answered "no such tree", byte-identical to an absent one, so a
    // rejected write never confirms the id names something. canWrite then admits the owner and
    // nobody else — an unowned tree is nobody's to write.
    const std::optional<TreeAccess> access = registry_.accessOf(TreeId{treeId});
    std::optional<WriteRefusal> refusal =
        access ? writeRefusalFor(principal.user, access->owner) : std::nullopt;
    if (!access || !canRead(principal.user, access->owner, access->visibility)) {
      reject = rejectFrame(treeId, kNoSuchTree, "no such tree \"" + treeId + "\"");  // rejected, not a throw that closes the socket
    } else if (refusal) {
      reject = rejectFrame(treeId, codeOf(*refusal), sentenceOf(*refusal));
    } else if (TreeRoom* room = registry_.open(TreeId{treeId}); !room) {
      reject = rejectFrame(treeId, kNoSuchTree, "no such tree \"" + treeId + "\"");  // deleted between the row and the load
    } else if (std::optional<Admission> admission = room->admit(incoming)) {
      // joinSubgraph never refuses: the whole-tree ceilings (domain/Command.h) are enforced here.
      reject = rejectFrame(treeId, admission->verdict == Admission::Verdict::tooLarge ? kTreeTooLarge : kBadFrame,
                           admission->reason);
    } else {
      seq = room->joinSubgraph(incoming, principal.user);
      if (seq) registry_.persist(TreeId{treeId});  // persist before the ack, so the ack attests durability
    }
  }
  if (reject) {
    (*reject)["frameId"] = frameId;
    send(conn, *reject);
    return;
  }

  Json::Value ack(Json::objectValue);
  ack["t"] = "subgraphAck";
  ack["treeId"] = treeId;
  ack["frameId"] = frameId;
  if (seq) ack["seq"] = static_cast<Json::Int64>(*seq);
  send(conn, ack);
}

// The private per-user lane: refused whole or applied whole, joins no op log, and is echoed only
// to the SAME account's other sessions — never to the tree's collaborators.
// The client mints the stamp; the server records the receipt instant beside each register.
void Collab::progress(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId,
                      const Json::Value& frame) {
  const Principal& principal = principalOf(conn);
  const std::string frameId = frame.get("frameId", "").asString();
  auto refuse = [&](const char* code, const std::string& reason) {
    Json::Value reject = rejectFrame(treeId, code, reason);
    reject["frameId"] = frameId;
    send(conn, reject);
  };

  // A lapsed session is told, never dropped; an unacked frame re-flushes on its own.
  if (!stillAuthorized(conn)) return refuse(kSignInRequired, "sign in to track progress");

  const Json::Value& marks = frame["marks"];
  if (!marks.isArray() || marks.empty()) return refuse(kBadFrame, "this frame carried no marks");
  // Bound the batch: one frame must not hand a handler thread an unbounded list to upsert.
  if (marks.size() > kMaxMarksPerFrame)
    return refuse(kTreeTooLarge, "a progress frame carries at most " + std::to_string(kMaxMarksPerFrame) + " marks");

  const std::uint64_t nowMs = clock_.nowMs();
  std::vector<ProgressWrite> writes;
  writes.reserve(marks.size());
  for (const Json::Value& mark : marks) {
    const NodeId node{mark.get("node", "").asString()};
    const std::optional<ProgressStatus> status = parseProgressStatus(mark.get("status", "").asString());
    const std::optional<Hlc> at = readHlc(mark.get("at", "").asString());
    // A mark missing any of the three cannot be merged by anyone: refuse the whole frame.
    if (node.empty() || !status || !at || !at->isSet())
      return refuse(kBadFrame, "a mark needs a node, a status and a stamp");
    // The skew clamp on this lane too: a runaway stamp must not own a register for years.
    if (at->physicalMs > nowMs + kMaxSkewMs) {
      Json::Value skew(Json::objectValue);
      skew["t"] = "skew";
      skew["treeId"] = treeId;
      skew["frameId"] = frameId;
      skew["serverNow"] = static_cast<Json::Int64>(nowMs);
      send(conn, skew);
      return;
    }
    writes.push_back(ProgressWrite{node, *status, {}, *at});
  }

  {
    std::lock_guard<std::mutex> lock(registry_.strandFor(TreeId{treeId}));
    try {
      // Absent and private-denied both answer "no such tree", decided off the stored row so the
      // mark never materializes a tree the caller cannot read.
      const std::optional<TreeAccess> access = registry_.accessOf(TreeId{treeId});
      if (!access || !canRead(principal.user, access->owner, access->visibility))
        return refuse(kNoSuchTree, "no such tree \"" + treeId + "\"");
      TreeRoom* room = registry_.open(TreeId{treeId});
      if (!room) return refuse(kNoSuchTree, "no such tree \"" + treeId + "\"");
      for (ProgressWrite& write : writes) write.prerequisites = room->prerequisitesOf(write.node);
    } catch (const std::exception&) {
      return;  // an infrastructure failure — its detail is not the socket's to carry
    }
  }

  const std::vector<ProgressOutcome> outcomes =
      progress_.setStatuses(TreeId{treeId}, principal.user, writes, nowMs);

  // The echo carries registers back exactly as recorded, in the frame shape the graft serves,
  // and reaches the sender too. Only what LANDED is announced; a frame where nothing landed is
  // still ACKED.
  Progress recorded;
  for (std::size_t i = 0; i < writes.size(); ++i)
    if (outcomes[i].applied) recorded.record(writes[i].node, ProgressMark{writes[i].status, writes[i].at, nowMs});
  bus_.broadcastProgress(TreeId{treeId}, principal.user, recorded);

  Json::Value ack(Json::objectValue);
  ack["t"] = "progressAck";
  ack["treeId"] = treeId;
  ack["frameId"] = frameId;
  send(conn, ack);
}

}

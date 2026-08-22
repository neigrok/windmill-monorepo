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
// One progress frame's ceiling. A batch is bounded for the same reason every other write on this
// process is: four handler threads must not be handed an arbitrarily long list to parse, stamp and
// upsert a row at a time. Well past any real flush — a tree's marks are bounded by its nodes.
constexpr unsigned kMaxMarksPerFrame = 2000;

// parseHlc THROWS on a stamp whose numbers are not numbers (it reaches std::stoull), and this lane
// parses text a client wrote. Returning nullopt keeps a malformed stamp a refusable frame instead
// of an exception unwinding a handler thread.
std::optional<Hlc> readHlc(const std::string& text) {
  try {
    return parseHlc(text);
  } catch (const std::exception&) {
    return std::nullopt;
  }
}

// Every reject frame carries a stable `code` beside its `reason`: the code is what a client
// branches on (an ownership verdict demotes the editor; a session suspicion re-checks the session)
// and never changes, so the sentence stays free to. A client that meets a code it does not know
// warns rather than guesses.
constexpr char kNoSuchTree[] = "no-such-tree";
constexpr char kServerError[] = "server-error";
constexpr char kSignInRequired[] = "sign-in-required";
// The graph caps, refused by code so a client can say WHY the edit will not land instead of
// parsing the sentence — and so a client that has never met this code still degrades to a warning
// with the edit left banked, not to a silent loss.
constexpr char kTreeTooLarge[] = "tree-too-large";
// A frame refused for its CONTENT, not its size — an over-long id, a field past its cap. Told
// apart from the capacity refusal because they ask different things of a client: one is "this
// tree is full", the other "this frame is malformed", and reporting the second as the first
// sends the reader looking for room they already have.
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
  // Read authorization is not a grant made once. Two things can take it away while a socket sits
  // open — the owner re-privating the tree, and the session being revoked — and both must reach a
  // subscription that already exists. The bus asks before every fan-out; the registry announces a
  // visibility change so the revocation lands at once rather than at the tree's next edit.
  bus_.setReadGate([this](const TreeId& tree, const drogon::WebSocketConnectionPtr& conn) {
    if (mayRead(conn, tree)) return true;
    // A no is the whole revocation, not just a skipped frame: leave the roster (or the peer's
    // cursor would sit there forever) and say so in the same words a fresh subscribe would hear,
    // so a refused reader learns nothing from the difference.
    presence_.leave(conn, tree);
    send(conn, rejectFrame(tree.str(), kNoSuchTree, "no such tree \"" + tree.str() + "\""));
    return false;
  });
  registry_.whenAccessChanges([this](const TreeId& tree) { bus_.resweep(tree); });
  // And a clock, for the two revocations no edit and no share flip can carry: an idle tree, and
  // presence, which never rides the bus at all.
  reprove_.start(kReproveEverySeconds, kReproveEverySeconds, [this] { reproveReaders(); });
}

void Collab::reproveReaders() {
  // Re-prove first, decide second. stillAuthorized is the step that can block — one database
  // lookup per authenticated connection per minute — and it runs here, on the sweeper's own
  // thread, holding no strand; the gate that follows is then a pure verdict.
  for (const auto& conn : bus_.connections()) stillAuthorized(conn);
  bus_.resweepAll();
}

void Collab::onOpen(const drogon::HttpRequestPtr& req, const drogon::WebSocketConnectionPtr& conn) {
  // A WebSocket upgrade is outside the CORS policy that guards every other cookie-bearing door:
  // the browser sends no preflight and reads no Access-Control header, so a hostile page's socket
  // connects and rides whatever cookie the browser attaches. What stops that today is SameSite=Lax
  // — a cookie attribute this code does not own, one loosening (an embed, a cross-subdomain
  // surface) away from cross-site hijacking of every private tree. A stated origin must be one we
  // allow. A client that states none — a script, a device, curl — is untouched: only a browser
  // sends Origin, and only a browser can be aimed at us by someone else's page.
  const std::string origin = req->getHeader("origin");
  if (!origin.empty() && !allowedOrigins_.count(origin)) {
    LOG_WARN << "ws upgrade refused: origin " << origin << " is not allow-listed";
    // Drogon hands us the connection only after it has answered 101, so the refusal is a close on
    // an accepted socket rather than a rejected handshake. Identical to the client and to the
    // attacker — no frame is ever read or served — but a packet capture shows the 101, so this is
    // not the 403 a reader might go looking for.
    // A context first, then the close: drogon may still deliver a frame queued on this connection,
    // and every handler reads the Principal without checking that one exists.
    conn->setContext(std::make_shared<Principal>(UserId{"u0"}, false, "", "", 0));
    conn->forceClose();
    return;
  }

  // Resolve the session at the upgrade (frames carry no cookie): an authenticated user may
  // write; anyone else joins as a read-only guest.
  std::string secret = req->getCookie("wm_session");
  if (secret.empty()) {
    std::string authorization = req->getHeader("authorization");
    if (authorization.rfind("Bearer ", 0) == 0) secret = authorization.substr(7);
  }
  std::optional<User> user = auth_.authenticate(secret);
  // Keep the session's digest — never the secret — so each write can re-prove the session is still
  // live, and a revocation reaches a connection that was opened before it. Built in place: a
  // Principal holds two atomics now (PresenceHub.h) and so cannot be copied into the context.
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

  // Decoding a client's vector is the one step here that can throw on CONTENT rather than on
  // shape — an HLC counter past what 64 bits hold. That throw used to escape to onMessage, which
  // logged it and answered nothing, and a subscribe that never answers is a client that waits
  // forever. A frame we cannot read is refused, in the same words as any other unreadable frame.
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
      // Gate the read BEFORE the room is materialized and before joining the bus or presence.
      // Before: an unreadable caller loaded the whole lattice into memory on its way to being
      // refused, and it stayed there. mayRead reads the stored access row instead, re-proves the
      // session, and answers an absent tree and a private-denied one identically — "no such tree",
      // no existence leak. Only an infrastructure failure falls to the catch, which answers
      // generically and logs its detail. The session is re-proved first, on this frame's own
      // thread, where the lookup costs nobody else — mayRead itself never goes to the database.
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
      send(conn, rejectFrame(treeId, kServerError, "the server could not open this tree"));
      return;
    }
  }
  send(conn, frame);

  // Both lanes re-graft on every subscribe, or a reconnect heals only half the replica: a mark
  // made on another device while this one was offline would otherwise wait for a page reload to
  // appear. Read OUTSIDE the strand — a room's lock is never held across a database call.
  //
  // The gate is `authenticated`, NOT a non-empty user: a guest connection carries a real guest
  // identity (that is what presence announces as "Guest N"), so an emptiness check would hand an
  // unauthenticated caller whatever overlay happens to sit under that id. This lane serves one
  // account its own private marks or it serves nothing.
  if (!principal.authenticated) return;
  Progress overlay = progress_.progressOf(TreeId{treeId}, principal.user);
  if (overlay.marks.empty()) return;
  Json::Value graft = toJson(overlay);
  graft["t"] = "progress";
  graft["treeId"] = treeId;
  send(conn, graft);
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

// The read half of the same rule, and the answer to two questions asked together: is this
// connection still who it said it was, and may that person still see this tree? Both change under
// an open socket — "sign out everywhere" revokes the first, the owner re-privating revokes the
// second — and neither used to be asked again after the subscribe.
bool Collab::mayRead(const drogon::WebSocketConnectionPtr& conn, const TreeId& tree) {
  const std::shared_ptr<Principal> principal = conn->getContext<Principal>();
  if (!principal) return false;
  // A principal stillAuthorized has narrowed is a guest from here on, so a revoked reader falls
  // back to what any stranger may see — public and unlisted, never private.
  const std::optional<UserId> caller =
      principal->authenticated ? std::optional<UserId>(principal->user) : std::nullopt;
  // The stored access row, not a materialized room: two facts off one row, so refusing a reader
  // never costs the whole lattice.
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

  // A frame we cannot decode — an id past every cap, an HLC counter past 64 bits — used to throw
  // clean out of here into onMessage's catch, which logged and answered nothing: the client's
  // in-flight entry for this frameId then leaked forever and its banked edits were stranded
  // silently. Refused by code instead, like every other unreadable frame.
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
  std::optional<Json::Value> reject;  // absent while the write is still admissible
  {
    std::lock_guard<std::mutex> lock(registry_.strandFor(TreeId{treeId}));
    // stillAuthorized proved a real signed-in caller above, so principal.user is that user.
    // Both gates decide off the stored access row, BEFORE the room is materialized: a write that
    // is going to be refused must not be a way to load and pin a tree the caller cannot even read.
    // The read gate comes FIRST, exactly as applyEdit's does: a private tree the caller cannot
    // read is answered "no such tree" — byte-identical to an absent one — so a rejected write
    // never confirms the id names something. Only a readable tree reaches canWrite, which admits
    // its owner and nobody else: an UNOWNED tree — the seeded demo, a crash-orphaned row — is
    // nobody's to write, and no longer anybody's to seize by writing to it. writeRefusalFor is
    // that gate and its verdict in one: which of the two truths (Access.h) this refusal states.
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
      // joinSubgraph never refuses, so every payload a frame carries — graph, legend, title —
      // could once be seated here past the very ceilings the command path enforces on every other
      // write. The whole-tree rule (domain/Command.h) decides all four, under this strand, beside
      // the skew clamp and the authz gates.
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

// Progress is the private per-user lane (GRAPH_SYNC_DESIGN.md §12): it rides the same socket as
// the shared subgraph and obeys the same laws — the client mints the stamps, the frame is refused
// whole or applied whole, and the ack is what lets the sender's coverage advance. It joins no op
// log and is echoed only to the SAME account's other sessions, because publishing it to the tree's
// collaborators is the one thing this lane must never do.
//
// The server no longer mints the stamp. A mark carries the instant the marking replica minted, so
// a mark made offline is orderable the moment it is made rather than the moment it lands — which
// is what lets an offline mark converge instead of being reconstructed by a diff. The server's
// contribution is the receipt instant it records beside each register, the only one of the two
// clocks a reader may be shown.
void Collab::progress(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId,
                      const Json::Value& frame) {
  const Principal& principal = principalOf(conn);
  const std::string frameId = frame.get("frameId", "").asString();
  auto refuse = [&](const char* code, const std::string& reason) {
    Json::Value reject = rejectFrame(treeId, code, reason);
    reject["frameId"] = frameId;
    send(conn, reject);
  };

  // A lapsed session is told, never silently dropped — but nothing is echoed back for the client
  // to requeue any more: an unacked frame stays uncovered in its lattice and re-flushes on its own.
  // The outbox is the lattice (§6), so "the client might lose this" stopped being a way to lose it.
  if (!stillAuthorized(conn)) return refuse(kSignInRequired, "sign in to track progress");

  const Json::Value& marks = frame["marks"];
  if (!marks.isArray() || marks.empty()) return refuse(kBadFrame, "this frame carried no marks");
  // One frame is bounded like every other write on this process: a caller must not be able to hand
  // four handler threads an arbitrarily long batch to parse, stamp and upsert one row at a time.
  if (marks.size() > kMaxMarksPerFrame)
    return refuse(kTreeTooLarge, "a progress frame carries at most " + std::to_string(kMaxMarksPerFrame) + " marks");

  const std::uint64_t nowMs = clock_.nowMs();
  std::vector<ProgressWrite> writes;
  writes.reserve(marks.size());
  for (const Json::Value& mark : marks) {
    const NodeId node{mark.get("node", "").asString()};
    const std::optional<ProgressStatus> status = parseProgressStatus(mark.get("status", "").asString());
    const std::optional<Hlc> at = readHlc(mark.get("at", "").asString());
    // A mark missing any of the three cannot be merged by anyone. Refusing the whole frame is the
    // only honest answer: acking it would drop the mark where nobody could see it go, and staying
    // silent would leave the sender re-flushing an uncoverable frame forever.
    if (node.empty() || !status || !at || !at->isSet())
      return refuse(kBadFrame, "a mark needs a node, a status and a stamp");
    // §3's clamp, on this lane too: a runaway stamp must not own a register for years.
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
      // An absent or private-denied tree: nothing to record against, and the socket must be no
      // existence oracle — answer "no such tree" either way, exactly as the shared lane does.
      // Decided off the stored row first, so a mark against a tree the caller cannot read never
      // materializes it.
      const std::optional<TreeAccess> access = registry_.accessOf(TreeId{treeId});
      if (!access || !canRead(principal.user, access->owner, access->visibility))
        return refuse(kNoSuchTree, "no such tree \"" + treeId + "\"");
      TreeRoom* room = registry_.open(TreeId{treeId});
      if (!room) return refuse(kNoSuchTree, "no such tree \"" + treeId + "\"");
      for (ProgressWrite& write : writes) write.prerequisites = room->prerequisitesOf(write.node);
    } catch (const std::exception&) {
      return;  // an infrastructure failure — nothing to record; its detail is not the socket's to carry
    }
  }

  progress_.setStatuses(TreeId{treeId}, principal.user, writes, nowMs);

  // The echo carries the registers back exactly as they were recorded — stamps and the server's
  // receipt instant — in the same frame shape the graft serves, so a replica joins both with one
  // codec. It reaches the sender too: that is how the marking device learns the receipt instant
  // for its own mark without asking again, and the join is a no-op since the stamp is its own.
  Progress recorded;
  for (const ProgressWrite& write : writes)
    recorded.record(write.node, ProgressMark{write.status, write.at, nowMs});
  bus_.broadcastProgress(TreeId{treeId}, principal.user, recorded);

  Json::Value ack(Json::objectValue);
  ack["t"] = "progressAck";
  ack["treeId"] = treeId;
  ack["frameId"] = frameId;
  send(conn, ack);
}

}

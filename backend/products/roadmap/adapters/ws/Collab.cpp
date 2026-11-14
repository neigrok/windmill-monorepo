#include "products/roadmap/adapters/ws/Collab.h"
#include "platform/application/WriteObservation.h"

#include "platform/adapters/http/Caller.h"

#include "products/roadmap/adapters/json/SubgraphJson.h"
#include "products/roadmap/adapters/json/TreeJson.h"
#include "products/roadmap/application/TreeRoom.h"
#include "products/roadmap/domain/Command.h"
#include "products/roadmap/domain/Access.h"
#include "products/roadmap/domain/OpenedTrees.h"
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

// A frame sent to a connection says nothing of the write in progress: while a write is served, frames go to other
// connections too — a reject to a reader a fan-out drops, to a page open on a tree a removal retires. It is queued on
// the connection's own loop, as a broadcast is (WsPresenceBus::send), and entered in what the connection has been
// handed as a reply: the ack of a write goes out after the broadcast of that write, which the handler queued before it.
void send(WsPresenceBus& bus, const drogon::WebSocketConnectionPtr& conn, const Json::Value& frame) {
  bus.send(conn, std::make_shared<const std::string>(dump(frame)), FrameKind::reply);
}

// The refusal of the frame being served, a `reject` or a `skew`: it finishes that frame's write under its code.
void refuseFrame(WsPresenceBus& bus, const drogon::WebSocketConnectionPtr& conn, const Json::Value& refusal) {
  finishCurrentWriteRefusal(refusal["t"] == "skew" ? std::string("clock-ahead") : refusal["code"].asString());
  send(bus, conn, refusal);
}

Json::Value rejectFrame(const std::string& treeId, const char* code, const std::string& reason) {
  Json::Value reject(Json::objectValue);
  reject["t"] = "reject";
  reject["treeId"] = treeId;
  reject["code"] = code;
  reject["reason"] = reason;
  return reject;
}

// A frame whose text is not one whole JSON value is refused whole, answered by whatever its readable
// head names, so the client can settle the frame it sent.
void refuseUnreadable(WsPresenceBus& bus, const drogon::WebSocketConnectionPtr& conn, const Json::Value& head) {
  Json::Value reject = rejectFrame(head.get("treeId", "").asString(), kBadFrame, "this frame could not be read");
  if (head["frameId"].isString()) reject["frameId"] = head["frameId"];
  refuseFrame(bus, conn, reject);
}
}

void setCollab(std::shared_ptr<Collab> collab) { g_collab = std::move(collab); }
void stopCollab() { if (g_collab) g_collab->stop(); }
Collab* collab() { return g_collab.get(); }

Collab::Collab(RoomRegistry& registry, TreeRepository& trees, OpLog& ops, WsPresenceBus& bus,
               ProgressService& progress, AuthService& auth, PresenceHub& presence, Clock& clock,
               std::set<std::string> allowedOrigins)
    : registry_(registry), trees_(trees), ops_(ops), bus_(bus), progress_(progress),
      auth_(auth), presence_(presence), clock_(clock), allowedOrigins_(std::move(allowedOrigins)),
      reprove_("ws-readers") {
  // Read authorization can be revoked under an open socket, so the bus asks before every fan-out.
  bus_.setReadGate([this](const TreeId& tree, const drogon::WebSocketConnectionPtr& conn) {
    const Reach reach = reachOf(conn, tree);
    if (reach != Reach::none) return reach;
    presence_.leave(conn, tree);
    send(bus_, conn, rejectFrame(tree.str(), kNoSuchTree, "no such tree \"" + tree.str() + "\""));
    return Reach::none;
  });
  registry_.whenAccessChanges([this](const TreeId& tree) { bus_.resweep(tree); });
  reprove_.start(kReproveEverySeconds, kReproveEverySeconds, [this] { reproveReaders(); });
}

void Collab::reproveReaders() {
  // stillAuthorized can block on a database lookup: run it here, holding no strand.
  for (const auto& conn : bus_.connections()) stillAuthorized(conn);
  bus_.resweepAll();
}

void Collab::onOpen(const drogon::HttpRequestPtr& req, const drogon::WebSocketConnectionPtr& conn) {
  // A WebSocket upgrade gets no CORS preflight: a stated origin must be allow-listed.
  const std::string origin = req->getHeader("origin");
  if (!origin.empty() && !allowedOrigins_.count(origin)) {
    LOG_WARN << "ws upgrade refused: origin is not allow-listed";
    // Set a context before closing: drogon may still deliver a queued frame, and handlers read it unchecked.
    conn->setContext(std::make_shared<Principal>(UserId{"u0"}, false, "", "", 0));
    conn->forceClose();
    return;
  }

  // Frames carry no cookie: resolve the session at the upgrade; anyone else is a read-only guest.
  const std::string secret = sessionSecretOf(req);
  std::optional<User> user = auth_.authenticate(secret);
  // Keep the digest, never the secret, so a write can re-prove the session.
  if (user) {
    conn->setContext(std::make_shared<Principal>(user->id, true, sharableName(*user),
                                                 auth_.digestOf(secret), clock_.nowMs()));
  } else {
    conn->setContext(
        std::make_shared<Principal>(UserId{"u" + std::to_string(++actorSeq_)}, false, "", "", 0));
  }

  bus_.open(conn);
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
  if (overRate(conn)) {
    WriteObservation observation("roadmap.ws.frame", "roadmap", "websocket");
    observation.finish("rate_limited");
    return;
  }  // a flooding connection's frames are dropped before parse
  // Drogon does not wrap WS callbacks: an exception escaping here aborts the process.
  try {
    // jsoncpp keeps what it read before a break: that head may name the frame a refusal answers, but
    // no part of a frame that does not parse whole is applied.
    const std::optional<Json::Value> whole = parseWhole(text);
    const Json::Value frame = whole ? *whole : parse(text);
    if (!frame.isObject()) return;
    std::string type = frame.get("t", "").asString();
    std::string treeId = frame.get("treeId", "").asString();
    if (type == "subgraph" || type == "progress") {
      WriteObservation observation(type == "subgraph" ? "roadmap.ws.subgraph" : "roadmap.ws.progress", "roadmap", "websocket");
      WriteContext context(observation);
      try {
        if (!whole) refuseUnreadable(bus_, conn, frame);
        else if (type == "subgraph") subgraphFrame(conn, treeId, frame);
        else progress(conn, treeId, frame);
        observation.finish();
      } catch (const std::exception& error) { observation.fail(error); throw; }
      return;
    }
    if (!whole) return refuseUnreadable(bus_, conn, frame);
    if (type == "ping") { Json::Value pong(Json::objectValue); pong["t"] = "pong"; send(bus_, conn, pong); return; }
    if (type == "subscribe") return subscribe(conn, treeId, frame);
    if (type == "presence") { presence_.update(conn, TreeId{treeId}, frame); return; }
  } catch (const std::exception& error) {
    LOG_ERROR << "a ws frame failed before it was answered";
  }
}

void Collab::subscribe(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, const Json::Value& request) {
  const Principal& principal = principalOf(conn);

  // versionVectorFromJson throws on a mark that is not a stamp, and an unanswered subscribe waits forever.
  VersionVector clientVector;
  try {
    clientVector = versionVectorFromJson(request["vector"]);
  } catch (const std::exception&) {
    send(bus_, conn, rejectFrame(treeId, kBadFrame, "this frame could not be read"));
    return;
  }

  // The delta, the head it reports and the view it was cut to are read under the strand; the places of the delta and
  // the progress graft in the connection's send order are taken there too, with the join, and each frame is written
  // out once the strand is released.
  std::optional<WsPresenceBus::FirstFrames> first;
  Subgraph delta;
  Seq head = 0;
  Reach reach = Reach::none;
  bool subtree = false;
  int depth = 0;
  std::map<NodeId, TreeId> subtrees;
  {
    std::lock_guard<std::mutex> lock(registry_.strandFor(TreeId{treeId}));
    try {
      // Gate the read before the room is materialized; absent and private-denied answer identically.
      stillAuthorized(conn);
      reach = reachOf(conn, TreeId{treeId});
      if (reach == Reach::none) {
        send(bus_, conn, rejectFrame(treeId, kNoSuchTree, "no such tree \"" + treeId + "\""));
        return;
      }
      TreeRoom* room = registry_.open(TreeId{treeId});
      if (!room) {
        send(bus_, conn, rejectFrame(treeId, kNoSuchTree, "no such tree \"" + treeId + "\""));
        return;
      }
      // Join under the strand, so no broadcast slips between the delta and the subscription, and the delta goes out
      // ahead of every broadcast made after it.
      first = bus_.subscribe(TreeId{treeId}, conn, principal.user);
      // The gate was asked before the room opened, and an owning step's delete may have hidden the tree since, telling
      // the live rooms below before this one was among them. Asked again now that the subscription has joined, a hide
      // lands either before this check, which refuses it, or after, when its announce reaches the subscription.
      const std::optional<UserId> reader =
          principal.authenticated ? std::optional<UserId>(principal.user) : std::nullopt;
      if (!room->readableBy(reader)) {
        bus_.unsubscribe(TreeId{treeId}, conn);
        send(bus_, conn, rejectFrame(treeId, kNoSuchTree, "no such tree \"" + treeId + "\""));
        return;
      }
      presence_.join(conn, TreeId{treeId});
      delta = room->deltaSince(clientVector);
      head = room->head();
      subtree = room->parent().has_value();
      depth = room->depth();
      subtrees = room->subtrees();
    } catch (const std::exception& error) {
      // An infrastructure failure is never the socket's to relay.
      reportCurrentWriteFailure(error);
      LOG_ERROR << "collab join failed";
      send(bus_, conn, rejectFrame(treeId, kServerError, "the server could not open this tree"));
      return;
    }
  }
  if (reach == Reach::reader) delta.graph = readerView(std::move(delta.graph));
  // A subtree's name is its owning step's label, read through its parent OUTSIDE the strand and sent whatever the
  // vector covers, never folded into the coverage: the stamp is the parent's. A read that fails fails the subscribe as a
  // failed join does, and the client asks again; the subtree's own title register is never sent in its place.
  if (subtree) {
    WriteObservation observation{"roadmap.tree.place", "roadmap", "websocket"};
    try {
      const std::optional<Place> place = trees_.placeOf(TreeId{treeId});
      if (place && place->titleAt.isSet()) delta.title = Lww<std::string>{place->title, place->titleAt};
      observation.skip();
    } catch (const std::exception& failure) {
      observation.fail(failure);
      send(bus_, conn, rejectFrame(treeId, kServerError, "the server could not open this tree"));
      return;
    }
  }
  delta.frameId = "delta-" + std::to_string(head);
  delta.actor = "srv";
  Json::Value frame = toJson(delta);
  frame["seq"] = static_cast<Json::Int64>(head);
  // The verdict that chose this delta's view, so an empty pointer reads as none or as withheld.
  frame["reach"] = reach == Reach::writer ? "writer" : "reader";
  // The subtree each step owns, to readers and writers alike: what heals a `subtree` frame the client missed. It is
  // told, never a register: no client writes it and no join reads it.
  for (const auto& [step, id] : subtrees) {
    Json::Value owned(Json::objectValue);
    owned["step"] = step.str();
    owned["id"] = id.str();
    owned["depth"] = depth + 1;
    frame["subtrees"].append(owned);
  }
  first->delta.send(dump(frame));

  // Read OUTSIDE the strand — a room's lock is never held across a database call.
  // Gate on `authenticated`, never on a non-empty user: a guest carries a real guest identity.
  if (!principal.authenticated) return;
  Json::Value graft = toJson(progress_.progressOf(TreeId{treeId}, principal.user));
  graft["t"] = "progress";
  graft["treeId"] = treeId;
  // `graft`, not an echo: the receiver may re-baseline its coverage on it, and an empty graft still ships.
  graft["intent"] = "graft";
  first->graft.send(dump(graft));
}

// The whole frame refused: nothing of it lands. Each branch is named with its size, read off the stored rows with no
// strand held; a read that fails leaves the sizes out and is reported, and the refusal still goes. The first branch is
// also the reject's own `subtree`, `steps` and `subtrees`.
Json::Value Collab::branchUnconfirmed(const std::string& treeId, const std::vector<UnconfirmedBranch>& unconfirmed) {
  std::set<TreeId> subtrees;
  for (const UnconfirmedBranch& branch : unconfirmed) subtrees.insert(branch.subtree);
  std::map<TreeId, BranchSize> sizes;
  WriteObservation counting{"roadmap.tree.branch", "roadmap", "websocket"};
  try {
    sizes = trees_.branchSizes(subtrees);
    counting.skip();
  } catch (const std::exception& failure) {
    counting.fail(failure);
  }
  Json::Value reject = rejectFrame(treeId, kBranchUnconfirmed,
                                   "this frame deletes a step that owns a subtree it does not name: send the subtree's "
                                   "id in branches to take it with the step");
  for (const UnconfirmedBranch& branch : unconfirmed) {
    const auto size = sizes.find(branch.subtree);
    reject["branches"].append(toJson(branch, size == sizes.end() ? std::nullopt : std::optional(size->second)));
  }
  for (const char* key : {"subtree", "steps", "subtrees"})
    if (reject["branches"][0].isMember(key)) reject[key] = reject["branches"][0][key];
  return reject;
}

// Every write re-proves the session, throttled to one lookup a minute.
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

Reach Collab::reachOf(const drogon::WebSocketConnectionPtr& conn, const TreeId& tree) {
  const std::shared_ptr<Principal> principal = conn->getContext<Principal>();
  if (!principal) return Reach::none;
  // A principal stillAuthorized has narrowed is a guest: public and unlisted, never private, and
  // never the tree's writer.
  const std::optional<UserId> caller =
      principal->authenticated ? std::optional<UserId>(principal->user) : std::nullopt;
  // The stored access row, not a materialized room: refusing a reader never loads the lattice.
  const std::optional<TreeAccess> access = registry_.accessOf(tree);
  if (!access || !canRead(caller, access->owner, access->visibility)) return Reach::none;
  return canWrite(caller, access->owner) ? Reach::writer : Reach::reader;
}

void Collab::subgraphFrame(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, const Json::Value& frame) {
  const Principal& principal = principalOf(conn);
  std::string frameId = frame.get("frameId", "").asString();
  const bool signedIn = stillAuthorized(conn);

  // Refuse by code, never by throw: a throw strands the client's in-flight entry for this frameId.
  std::optional<Subgraph> decoded;
  try {
    decoded = subgraphFromJson(frame);
  } catch (const std::exception&) {
  }
  // A frame that carries no stamp asks for no write, so it needs no write access and no session: whoever may read
  // the tree is answered as for any frame that lands nothing, and the room is not touched.
  const bool asksNoWrite = decoded && decoded->carriesNoStamp();
  if (!signedIn && !asksNoWrite) {
    Json::Value reject = rejectFrame(treeId, kSignInRequired, "sign in to edit");
    reject["frameId"] = frameId;
    refuseFrame(bus_, conn, reject);
    return;
  }
  if (!decoded) {
    Json::Value reject = rejectFrame(treeId, kBadFrame, "this frame could not be read");
    reject["frameId"] = frameId;
    refuseFrame(bus_, conn, reject);
    return;
  }
  Subgraph& incoming = *decoded;
  incoming.treeId = TreeId{treeId};

  // The skew clamp covers every stamp the frame carries, the title and guide registers included.
  std::uint64_t nowMs = clock_.nowMs();
  for (const auto& [actor, mark] : frontier(incoming).marks) {
    if (mark.physicalMs > nowMs + kMaxSkewMs) {
      Json::Value skew(Json::objectValue);
      skew["t"] = "skew";
      skew["treeId"] = treeId;
      skew["frameId"] = frameId;
      skew["serverNow"] = static_cast<Json::Int64>(nowMs);
      refuseFrame(bus_, conn, skew);
      return;
    }
  }

  std::optional<Seq> seq;
  bool heldUnsaved = false;  // the frame landed in the room, whose save failed and is being retried
  std::optional<Json::Value> reject;  // absent while the write is still admissible
  std::vector<UnconfirmedBranch> unconfirmed;  // owning steps the frame would delete without naming their subtrees
  std::vector<NodeId> refused;  // steps owning a subtree the frame sent a pointer that is not an echo of it
  {
    std::lock_guard<std::mutex> lock(registry_.strandFor(TreeId{treeId}));
    try {
      // Both gates decide off the stored access row, before the room is materialized. Read gate first:
      // a private tree answers as an absent one does, byte for byte — "no such tree" to an account,
      // the sign-in refusal to a visitor without one.
      const std::optional<UserId> caller = signedIn ? std::optional<UserId>(principal.user) : std::nullopt;
      const std::optional<TreeAccess> access = registry_.accessOf(TreeId{treeId});
      std::optional<WriteRefusal> refusal = access ? writeRefusalFor(caller, access->owner) : std::nullopt;
      if (!access || !canRead(caller, access->owner, access->visibility)) {
        reject = signedIn ? rejectFrame(treeId, kNoSuchTree, "no such tree \"" + treeId + "\"")
                          : rejectFrame(treeId, kSignInRequired, "sign in to edit");
      } else if (asksNoWrite) {
        // No write gate, no admission, no join, and no room loaded for it.
      } else if (refusal) {
        reject = rejectFrame(treeId, codeOf(*refusal), sentenceOf(*refusal));
      } else if (TreeRoom* room = registry_.open(TreeId{treeId}); !room) {
        reject = rejectFrame(treeId, kNoSuchTree, "no such tree \"" + treeId + "\"");  // deleted between the row and the load
      } else if (std::optional<Admission> admission = room->admit(incoming)) {
        // joinSubgraph never refuses: the whole-tree ceilings (domain/Command.h) are enforced here.
        reject = rejectFrame(treeId, admission->verdict == Admission::Verdict::tooLarge ? kTreeTooLarge : kBadFrame,
                             admission->reason);
      } else if (unconfirmed = room->unconfirmedBranches(incoming); !unconfirmed.empty()) {
        // Answered once the strand is released, with each branch's size.
      } else {
        // A pointer the frame would write on a step that owns a subtree is answered refused, and the join lands none.
        refused = room->refusedPointers(incoming);
        seq = room->joinSubgraph(incoming, principal.user);
        // Persist before the ack, so the ack attests durability or says what it cannot. A row gone under its live room
        // holds nothing: the room is retired, which drops its readers, and the frame answers as absent. A save that
        // fails leaves the frame in the room, already sent to every subscriber and retried by the registry: it is
        // acked with its seq, as unsaved, and needs no resend.
        const Saved saved = seq ? registry_.persist(TreeId{treeId}) : registry_.standing(TreeId{treeId});
        heldUnsaved = saved == Saved::held;
        if (saved == Saved::gone) {
          registry_.retire(TreeId{treeId});
          reject = rejectFrame(treeId, kNoSuchTree, "no such tree \"" + treeId + "\"");
        }
      }
    } catch (const std::exception& error) {
      // An infrastructure failure is never the socket's to relay, but the frame's author is answered.
      reportCurrentWriteFailure(error);
      reject = rejectFrame(treeId, kServerError, "the server could not save this edit");
    }
  }
  if (!unconfirmed.empty()) reject = branchUnconfirmed(treeId, unconfirmed);
  if (reject) {
    (*reject)["frameId"] = frameId;
    refuseFrame(bus_, conn, *reject);
    return;
  }

  Json::Value ack(Json::objectValue);
  ack["t"] = "subgraphAck";
  ack["treeId"] = treeId;
  ack["frameId"] = frameId;
  countCurrentWriteRefused(refused.size());
  if (seq) ack["seq"] = static_cast<Json::Int64>(*seq);
  else if (!refused.empty()) finishCurrentWriteRefusal(kOwnsASubtree);
  else finishCurrentWriteUnchanged();
  if (heldUnsaved) ack["unsaved"] = true;
  // Names each step alone, never the subtree it owns: the rest of the frame landed, and the step still opens its subtree.
  if (!refused.empty()) ack["refused"] = refusedPointersJson(refused);
  send(bus_, conn, ack);
}

// The private per-user lane: joins no op log, and is echoed only to the same account's other
// sessions. A frame is REFUSED whole — one bad mark, one skewed stamp or a failed read gate turns
// the whole frame back before anything is written — but it APPLIES per mark: each is an independent
// LWW register write, so a frame can land in part, and only the marks that landed are echoed.
// The client mints the stamp; the server records the receipt instant. The tree's writer's mark on a
// node that follows the tree it opens is not recorded: the ack names it under `refused`.
void Collab::progress(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId,
                      const Json::Value& frame) {
  const Principal& principal = principalOf(conn);
  const std::string frameId = frame.get("frameId", "").asString();
  auto refuse = [&](const char* code, const std::string& reason) {
    Json::Value reject = rejectFrame(treeId, code, reason);
    reject["frameId"] = frameId;
    refuseFrame(bus_, conn, reject);
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
    const std::optional<Hlc> at = parseHlc(mark.get("at", "").asString());
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
      refuseFrame(bus_, conn, skew);
      return;
    }
    writes.push_back(ProgressWrite{node, *status, {}, *at});
  }

  std::map<NodeId, TreeId> pointers;
  {
    std::lock_guard<std::mutex> lock(registry_.strandFor(TreeId{treeId}));
    try {
      const std::optional<TreeAccess> access = registry_.accessOf(TreeId{treeId});
      if (!access || !canRead(principal.user, access->owner, access->visibility))
        return refuse(kNoSuchTree, "no such tree \"" + treeId + "\"");
      TreeRoom* room = registry_.open(TreeId{treeId});
      if (!room) return refuse(kNoSuchTree, "no such tree \"" + treeId + "\"");
      for (ProgressWrite& write : writes) write.prerequisites = room->prerequisitesOf(write.node);
      pointers = room->pointersFor(principal.user);
    } catch (const std::exception& error) {
      reportCurrentWriteFailure(error);
      return;  // an infrastructure failure — its detail is not the socket's to carry
    }
  }

  // Read and written OUTSIDE the strand — a room's lock is never held across a database call.
  const ProgressReceipt receipt =
      progress_.mark(TreeId{treeId}, pointers, principal.user, writes, StampedBy::replica, nowMs);
  // Only what landed is echoed; a frame where nothing landed is still acked.
  bus_.broadcastProgress(TreeId{treeId}, principal.user, receipt.recorded);

  Json::Value refused(Json::arrayValue);
  for (std::size_t i = 0; i < writes.size(); ++i) {
    if (!receipt.outcomes[i].refused) continue;
    Json::Value mark(Json::objectValue);
    mark["node"] = writes[i].node.str();
    mark["code"] = kOpensATree;
    refused.append(mark);
  }
  Json::Value ack(Json::objectValue);
  ack["t"] = "progressAck";
  ack["treeId"] = treeId;
  ack["frameId"] = frameId;
  if (!refused.empty()) ack["refused"] = refused;
  if (receipt.cameToARefusal()) finishCurrentWriteRefusal(kOpensATree);
  send(bus_, conn, ack);
}

}

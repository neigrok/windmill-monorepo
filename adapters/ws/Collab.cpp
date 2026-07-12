#include "adapters/ws/Collab.h"

#include "adapters/json/CommandJson.h"
#include "adapters/json/TreeJson.h"
#include "application/TreeRoom.h"

#include <optional>

#include <trantor/utils/Logger.h>

namespace wm {

namespace {
std::shared_ptr<Collab> g_collab;
constexpr Seq kSnapshotEvery = 25;  // persist full state every N ops to bound tail replay
constexpr double kWsRatePerSec = 50.0;  // sustained frames/sec per connection
constexpr double kWsBurst = 100.0;      // short-burst allowance

const Principal& principalOf(const drogon::WebSocketConnectionPtr& conn) {
  return conn->getContextRef<Principal>();
}

UserId actorOf(const drogon::WebSocketConnectionPtr& conn) {
  return principalOf(conn).user;
}

// Undo is per author, per tree.
std::string undoKey(const std::string& treeId, const drogon::WebSocketConnectionPtr& conn) {
  return treeId + '\n' + actorOf(conn).str();
}

void send(const drogon::WebSocketConnectionPtr& conn, const Json::Value& frame) {
  if (conn->connected()) conn->send(dump(frame));
}
}

void setCollab(std::shared_ptr<Collab> collab) { g_collab = std::move(collab); }
Collab* collab() { return g_collab.get(); }

Collab::Collab(RoomRegistry& registry, OpLog& ops, WsPresenceBus& bus, UndoService& undos,
               ProgressService& progress, AuthService& auth, PresenceHub& presence)
    : registry_(registry), ops_(ops), bus_(bus), undos_(undos), progress_(progress),
      auth_(auth), presence_(presence) {}

void Collab::onOpen(const drogon::HttpRequestPtr& req, const drogon::WebSocketConnectionPtr& conn) {
  // Resolve the session at the upgrade (frames carry no cookie): an authenticated user may
  // write; anyone else joins as a read-only guest.
  std::string secret = req->getCookie("wm_session");
  if (secret.empty()) {
    std::string authorization = req->getHeader("authorization");
    if (authorization.rfind("Bearer ", 0) == 0) secret = authorization.substr(7);
  }
  std::optional<User> user = auth_.authenticate(secret);
  Principal principal = user ? Principal{user->id, true}
                             : Principal{UserId{"u" + std::to_string(++actorSeq_)}, false};
  conn->setContext(std::make_shared<Principal>(std::move(principal)));

  std::lock_guard<std::mutex> lock(wsMutex_);
  wsRate_[conn.get()] = WsRate{kWsBurst, std::chrono::steady_clock::now()};
}

void Collab::onClose(const drogon::WebSocketConnectionPtr& conn) {
  presence_.leave(conn);
  bus_.drop(conn);
  undos_.forgetActor(actorOf(conn).str());  // reclaim this connection's undo/redo stacks
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
    std::string treeId = frame.get("treeId", "").asString();
    if (type == "subscribe") return subscribe(conn, treeId, frame.get("lastSeq", 0).asUInt64());
    if (type == "cmd") return command(conn, treeId, frame);
    if (type == "progress") return progress(conn, treeId, frame);
    if (type == "undo") return undoRedo(conn, treeId, true);
    if (type == "redo") return undoRedo(conn, treeId, false);
    if (type == "presence") { presence_.update(conn, TreeId{treeId}, frame); return; }
  } catch (const std::exception& error) {
    LOG_ERROR << "dropped malformed ws frame: " << error.what();
  }
}

void Collab::subscribe(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, Seq lastSeq) {
  bus_.subscribe(TreeId{treeId}, conn, principalOf(conn).user);
  presence_.join(conn, TreeId{treeId});

  Seq head = 0;
  bool replay = false;
  Json::Value snapshot(Json::objectValue);
  {
    std::lock_guard<std::mutex> lock(registry_.strandFor(TreeId{treeId}));
    try {
      TreeRoom& room = registry_.open(TreeId{treeId});
      head = room.head();
      replay = lastSeq > 0 && lastSeq <= head;
      if (!replay) snapshot["data"] = toJson(room.snapshot());
    } catch (const std::exception& error) {
      Json::Value reject(Json::objectValue);
      reject["t"] = "reject";
      reject["treeId"] = treeId;
      reject["reason"] = error.what();
      send(conn, reject);
      return;
    }
  }

  if (replay) {
    // Incremental catch-up: ship only the ops the client is missing.
    for (const AppliedOp& op : ops_.since(TreeId{treeId}, lastSeq)) {
      Json::Value frame = opFrame(op);
      frame["treeId"] = treeId;
      send(conn, frame);
    }
    return;
  }

  snapshot["t"] = "snapshot";
  snapshot["treeId"] = treeId;
  snapshot["seq"] = static_cast<Json::Int64>(head);
  send(conn, snapshot);
}

void Collab::command(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, const Json::Value& frame) {
  const Principal& principal = principalOf(conn);
  if (!principal.authenticated) {
    Json::Value reject(Json::objectValue);
    reject["t"] = "reject";
    reject["treeId"] = treeId;
    reject["opId"] = frame.get("opId", "").asString();
    reject["reason"] = "sign in to edit";
    send(conn, reject);
    return;
  }

  std::optional<Command> command = commandFromJson(frame.get("kind", "").asString(), frame["payload"]);
  if (!command) return;

  std::string opId = frame.get("opId", "").asString();
  Hlc hlc{++tick_, 0, principal.user.str()};
  Incoming incoming{opId, std::move(*command), hlc, principal.user};

  std::optional<Applied> applied;
  std::optional<std::string> rejected;
  {
    std::lock_guard<std::mutex> lock(registry_.strandFor(TreeId{treeId}));
    TreeRoom& room = registry_.open(TreeId{treeId});
    if (room.owner() && *room.owner() != principal.user) {
      rejected = "this tree belongs to another account";
    } else {
      rejected = room.validate(incoming.command);  // legend invariants (§F6); graph ops always pass
      if (!rejected) {
        applied = room.submit(incoming);
        if (!room.owner()) registry_.claim(TreeId{treeId}, principal.user);  // first writer claims it
        if (applied && applied->op.seq % kSnapshotEvery == 0) registry_.persist(TreeId{treeId});
      }
    }
  }
  if (rejected) {
    Json::Value reject(Json::objectValue);
    reject["t"] = "reject";
    reject["treeId"] = treeId;
    reject["opId"] = opId;
    reject["reason"] = *rejected;
    send(conn, reject);
    return;
  }
  if (!applied) return;

  undos_.record(undoKey(treeId, conn), applied->inverse);

  Json::Value ack(Json::objectValue);
  ack["t"] = "ack";
  ack["treeId"] = treeId;
  ack["opId"] = opId;
  ack["seq"] = static_cast<Json::Int64>(applied->op.seq);
  send(conn, ack);
}

// Progress is the private per-user overlay (§6): it rides the same socket but never joins
// the shared op log. Record it (advisory prerequisite check against the loose graph, never
// rejected), then echo only to the same user's other sessions — not to collaborators.
void Collab::progress(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, const Json::Value& frame) {
  const Principal& principal = principalOf(conn);
  if (!principal.authenticated) return;  // progress is a private per-account overlay

  NodeId node{frame.get("nodeId", "").asString()};
  std::optional<ProgressStatus> status = parseProgressStatus(frame.get("status", "").asString());
  if (node.empty() || !status) return;

  std::vector<NodeId> prerequisites;
  {
    std::lock_guard<std::mutex> lock(registry_.strandFor(TreeId{treeId}));
    try {
      prerequisites = registry_.open(TreeId{treeId}).prerequisitesOf(node);
    } catch (const std::exception&) {
      return;  // no such tree — nothing to record progress against
    }
  }

  Hlc hlc{++tick_, 0, principal.user.str()};
  progress_.setStatus(prerequisites, TreeId{treeId}, principal.user, node, *status, hlc);
  // Echo to this user's own other sessions (their other tabs, a browser watching an agent's
  // MCP edits) — never to collaborators, since progress is a private per-account overlay.
  bus_.broadcastProgress(TreeId{treeId}, principal.user, node, *status);
}

// Collaborative undo/redo: replay the top inverse group as fresh ops (which broadcast
// like any edit), and stash the resulting counter-inverse on the opposite stack.
void Collab::undoRedo(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, bool isUndo) {
  if (!principalOf(conn).authenticated) return;  // only a signed-in author has a stack to replay
  std::string key = undoKey(treeId, conn);
  std::optional<std::vector<Command>> group = isUndo ? undos_.takeUndo(key) : undos_.takeRedo(key);
  if (!group) return;

  UserId actor = actorOf(conn);
  std::vector<Command> counter;
  {
    std::lock_guard<std::mutex> lock(registry_.strandFor(TreeId{treeId}));
    TreeRoom& room = registry_.open(TreeId{treeId});
    for (const Command& cmd : *group) {
      std::string opId = (isUndo ? "undo-" : "redo-") + actor.str() + "-" + std::to_string(++tick_);
      Hlc hlc{++tick_, 0, actor.str()};
      std::optional<Applied> applied = room.submit(Incoming{opId, cmd, hlc, actor});
      if (applied) counter.insert(counter.begin(), applied->inverse.begin(), applied->inverse.end());
    }
  }
  if (isUndo) undos_.pushRedo(key, std::move(counter));
  else undos_.pushUndo(key, std::move(counter));
}

}

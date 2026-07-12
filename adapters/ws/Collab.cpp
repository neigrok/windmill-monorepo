#include "adapters/ws/Collab.h"

#include "adapters/json/CommandJson.h"
#include "adapters/json/TreeJson.h"
#include "application/TreeRoom.h"

namespace wm {

namespace {
std::shared_ptr<Collab> g_collab;
constexpr Seq kSnapshotEvery = 25;  // persist full state every N ops to bound tail replay

UserId actorOf(const drogon::WebSocketConnectionPtr& conn) {
  return conn->getContextRef<UserId>();
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
               ProgressService& progress, UserId progressUser, PresenceHub& presence)
    : registry_(registry), ops_(ops), bus_(bus), undos_(undos), progress_(progress),
      progressUser_(std::move(progressUser)), presence_(presence) {}

void Collab::onOpen(const drogon::WebSocketConnectionPtr& conn) {
  conn->setContext(std::make_shared<UserId>("u" + std::to_string(++actorSeq_)));
}

void Collab::onClose(const drogon::WebSocketConnectionPtr& conn) {
  presence_.leave(conn);
  bus_.drop(conn);
}

void Collab::onMessage(const drogon::WebSocketConnectionPtr& conn, const std::string& text) {
  Json::Value frame = parse(text);
  std::string type = frame.get("t", "").asString();
  std::string treeId = frame.get("treeId", "").asString();
  if (type == "subscribe") return subscribe(conn, treeId, frame.get("lastSeq", 0).asUInt64());
  if (type == "cmd") return command(conn, treeId, frame);
  if (type == "progress") return progress(conn, treeId, frame);
  if (type == "undo") return undoRedo(conn, treeId, true);
  if (type == "redo") return undoRedo(conn, treeId, false);
  if (type == "presence") { presence_.update(conn, TreeId{treeId}, frame); return; }
}

void Collab::subscribe(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, Seq lastSeq) {
  bus_.subscribe(TreeId{treeId}, conn);
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
  std::optional<Command> command = commandFromJson(frame.get("kind", "").asString(), frame["payload"]);
  if (!command) return;

  std::string opId = frame.get("opId", "").asString();
  Hlc hlc{++tick_, 0, actorOf(conn).str()};
  Incoming incoming{opId, std::move(*command), hlc, actorOf(conn)};

  std::optional<Applied> applied;
  std::optional<std::string> rejected;
  {
    std::lock_guard<std::mutex> lock(registry_.strandFor(TreeId{treeId}));
    TreeRoom& room = registry_.open(TreeId{treeId});
    rejected = room.validate(incoming.command);  // legend invariants (§F6); graph ops always pass
    if (!rejected) {
      applied = room.submit(incoming);
      if (applied && applied->op.seq % kSnapshotEvery == 0) registry_.persist(TreeId{treeId});
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
  NodeId node{frame.get("nodeId", "").asString()};
  std::string statusText = frame.get("status", "").asString();
  std::optional<ProgressStatus> status = parseProgressStatus(statusText);
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

  Hlc hlc{++tick_, 0, actorOf(conn).str()};
  progress_.setStatus(prerequisites, TreeId{treeId}, progressUser_, node, *status, hlc);

  // Echo to the author's *other* sessions so a second tab stays in sync. In today's
  // single-user phase every session is `dev`, so every other subscriber is one of the
  // author's sessions; Phase 1 narrows this to connections sharing the author's user id.
  Json::Value echo(Json::objectValue);
  echo["t"] = "progress";
  echo["treeId"] = treeId;
  echo["nodeId"] = node.str();
  echo["status"] = statusText;
  bus_.broadcastRaw(TreeId{treeId}, dump(echo), conn);
}

// Collaborative undo/redo: replay the top inverse group as fresh ops (which broadcast
// like any edit), and stash the resulting counter-inverse on the opposite stack.
void Collab::undoRedo(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, bool isUndo) {
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

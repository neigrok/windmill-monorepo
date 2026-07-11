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

Collab::Collab(RoomRegistry& registry, OpLog& ops, WsPresenceBus& bus, UndoService& undos)
    : registry_(registry), ops_(ops), bus_(bus), undos_(undos) {}

void Collab::onOpen(const drogon::WebSocketConnectionPtr& conn) {
  conn->setContext(std::make_shared<UserId>("u" + std::to_string(++actorSeq_)));
}

void Collab::onClose(const drogon::WebSocketConnectionPtr& conn) {
  bus_.drop(conn);
}

void Collab::onMessage(const drogon::WebSocketConnectionPtr& conn, const std::string& text) {
  Json::Value frame = parse(text);
  std::string type = frame.get("t", "").asString();
  std::string treeId = frame.get("treeId", "").asString();
  if (type == "subscribe") return subscribe(conn, treeId, frame.get("lastSeq", 0).asUInt64());
  if (type == "cmd") return command(conn, treeId, frame);
  if (type == "undo") return undoRedo(conn, treeId, true);
  if (type == "redo") return undoRedo(conn, treeId, false);
  if (type == "presence") { bus_.broadcastRaw(TreeId{treeId}, text, conn); return; }
}

void Collab::subscribe(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, Seq lastSeq) {
  bus_.subscribe(TreeId{treeId}, conn);

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
  {
    std::lock_guard<std::mutex> lock(registry_.strandFor(TreeId{treeId}));
    TreeRoom& room = registry_.open(TreeId{treeId});
    applied = room.submit(incoming);
    if (applied && applied->op.seq % kSnapshotEvery == 0) registry_.persist(TreeId{treeId});
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

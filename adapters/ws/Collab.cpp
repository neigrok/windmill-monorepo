#include "adapters/ws/Collab.h"

#include "adapters/json/CommandJson.h"
#include "adapters/json/TreeJson.h"
#include "application/TreeRoom.h"

namespace wm {

namespace {
std::shared_ptr<Collab> g_collab;

UserId actorOf(const drogon::WebSocketConnectionPtr& conn) {
  return conn->getContextRef<UserId>();
}

void send(const drogon::WebSocketConnectionPtr& conn, const Json::Value& frame) {
  if (conn->connected()) conn->send(dump(frame));
}
}

void setCollab(std::shared_ptr<Collab> collab) { g_collab = std::move(collab); }
Collab* collab() { return g_collab.get(); }

Collab::Collab(RoomRegistry& registry, OpLog& ops, WsPresenceBus& bus)
    : registry_(registry), ops_(ops), bus_(bus) {}

std::mutex& Collab::strandFor(const std::string& treeId) {
  std::lock_guard<std::mutex> lock(strandsMutex_);
  std::unique_ptr<std::mutex>& strand = strands_[treeId];
  if (!strand) strand = std::make_unique<std::mutex>();
  return *strand;
}

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
  if (type == "presence") { bus_.broadcastRaw(TreeId{treeId}, text, conn); return; }
}

void Collab::subscribe(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, Seq lastSeq) {
  bus_.subscribe(TreeId{treeId}, conn);

  Seq head = 0;
  bool replay = false;
  Json::Value snapshot(Json::objectValue);
  {
    std::lock_guard<std::mutex> lock(strandFor(treeId));
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
    std::lock_guard<std::mutex> lock(strandFor(treeId));
    TreeRoom& room = registry_.open(TreeId{treeId});
    applied = room.submit(incoming);
  }
  if (!applied) return;

  Json::Value ack(Json::objectValue);
  ack["t"] = "ack";
  ack["treeId"] = treeId;
  ack["opId"] = opId;
  ack["seq"] = static_cast<Json::Int64>(applied->op.seq);
  send(conn, ack);
}

}

#include "adapters/ws/Collab.h"

#include "adapters/json/CommandJson.h"
#include "adapters/json/TreeJson.h"
#include "application/TreeRoom.h"

namespace wm {

namespace {
std::shared_ptr<Collab> g_collab;

UserId actorOf(const drogon::WebSocketConnectionPtr& conn) {
  auto stored = conn->getContextRef<UserId>();
  return stored;
}

void send(const drogon::WebSocketConnectionPtr& conn, const Json::Value& frame) {
  if (conn->connected()) conn->send(dump(frame));
}
}

void setCollab(std::shared_ptr<Collab> collab) { g_collab = std::move(collab); }
Collab* collab() { return g_collab.get(); }

Collab::Collab(RoomRegistry& registry, WsPresenceBus& bus) : registry_(registry), bus_(bus) {}

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
  if (type == "subscribe") return subscribe(conn, treeId);
  if (type == "cmd") return command(conn, treeId, frame);
  if (type == "presence") { bus_.broadcastRaw(TreeId{treeId}, text, conn); return; }
}

void Collab::subscribe(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId) {
  bus_.subscribe(TreeId{treeId}, conn);

  Json::Value snapshot(Json::objectValue);
  {
    std::lock_guard<std::mutex> lock(mutex_);
    try {
      TreeRoom& room = registry_.open(TreeId{treeId});
      snapshot["t"] = "snapshot";
      snapshot["treeId"] = treeId;
      snapshot["seq"] = static_cast<Json::Int64>(room.head());
      snapshot["data"] = toJson(room.snapshot());
    } catch (const std::exception& error) {
      Json::Value reject(Json::objectValue);
      reject["t"] = "reject";
      reject["treeId"] = treeId;
      reject["reason"] = error.what();
      send(conn, reject);
      return;
    }
  }
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
    std::lock_guard<std::mutex> lock(mutex_);
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

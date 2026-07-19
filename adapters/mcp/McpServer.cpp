#include "adapters/mcp/McpServer.h"

namespace wm {

namespace {
constexpr char kJsonRpc[] = "2.0";
constexpr char kProtocolVersion[] = "2025-06-18";  // latest we speak; we echo the client's if newer/known

std::string compact(const Json::Value& value) {
  Json::StreamWriterBuilder builder;
  builder["indentation"] = "";
  return Json::writeString(builder, value);
}

Json::Value result(const Json::Value& id, Json::Value payload) {
  Json::Value response(Json::objectValue);
  response["jsonrpc"] = kJsonRpc;
  response["id"] = id;
  response["result"] = std::move(payload);
  return response;
}

Json::Value failure(const Json::Value& id, int code, const std::string& message) {
  Json::Value error(Json::objectValue);
  error["code"] = code;
  error["message"] = message;
  Json::Value response(Json::objectValue);
  response["jsonrpc"] = kJsonRpc;
  response["id"] = id;
  response["error"] = error;
  return response;
}
}

McpServer::McpServer(ToolHost& tools, ServerInfo info) : tools_(tools), info_(std::move(info)) {}

std::optional<Json::Value> McpServer::handle(const Json::Value& message, const UserId& caller) {
  if (!message.isObject()) return wm::failure(Json::nullValue, -32600, "invalid request");

  const bool isNotification = !message.isMember("id");
  const Json::Value id = message.get("id", Json::nullValue);
  const std::string method = message.get("method", "").asString();

  if (method == "initialize") {
    Json::Value tools(Json::objectValue);
    tools["listChanged"] = false;
    Json::Value capabilities(Json::objectValue);
    capabilities["tools"] = tools;

    Json::Value serverInfo(Json::objectValue);
    serverInfo["name"] = info_.name;
    serverInfo["version"] = info_.version;

    const std::string requested = message["params"].get("protocolVersion", "").asString();
    Json::Value payload(Json::objectValue);
    payload["protocolVersion"] = requested.empty() ? kProtocolVersion : requested;
    payload["capabilities"] = capabilities;
    payload["serverInfo"] = serverInfo;
    if (!info_.instructions.empty()) payload["instructions"] = info_.instructions;
    return result(id, payload);
  }

  if (method == "ping") return result(id, Json::Value(Json::objectValue));

  if (method == "tools/list") {
    Json::Value payload(Json::objectValue);
    payload["tools"] = tools_.listTools();
    return result(id, payload);
  }

  if (method == "tools/call") {
    const Json::Value& params = message["params"];
    const std::string name = params.get("name", "").asString();
    if (name.empty()) return wm::failure(id, -32602, "tools/call requires a \"name\"");
    const Json::Value arguments =
        params.isMember("arguments") ? params["arguments"] : Json::Value(Json::objectValue);

    ToolResult outcome = tools_.callTool(name, arguments, caller);
    Json::Value payload(Json::objectValue);
    payload["content"] = outcome.content;
    payload["isError"] = outcome.isError;
    if (!outcome.structured.isNull()) payload["structuredContent"] = outcome.structured;
    return result(id, payload);
  }

  // Notifications (initialized, cancelled, …) are accepted silently; unknown *requests*
  // get a method-not-found so the caller learns the surface.
  if (isNotification) return std::nullopt;
  return wm::failure(id, -32601, "unknown method: " + method);
}

}

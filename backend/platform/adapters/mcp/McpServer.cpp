#include "platform/adapters/mcp/McpServer.h"

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

// jsoncpp does not answer asString() on an object or an array — it THROWS, and on the stdio
// transport a throw out of handle() leaves main and terminates the process: one malformed frame
// takes the whole session down, not the one call. So every leaf this engine reads is checked
// before it is read, and a bad one is answered as invalid params like any other.
std::optional<std::string> notAString(const Json::Value& parent, const char* field) {
  if (parent[field].isNull() || parent[field].isString()) return std::nullopt;
  return "\"" + std::string(field) + "\" must be a string";
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

McpServer::McpServer(ToolHost& tools, ServerInfo info, std::vector<McpResource> resources)
    : tools_(tools), info_(std::move(info)), resources_(std::move(resources)) {}

std::optional<Json::Value> McpServer::handle(const Json::Value& message, const ToolCaller& caller) {
  if (!message.isObject()) return wm::failure(Json::nullValue, -32600, "invalid request");

  const bool isNotification = !message.isMember("id");
  const Json::Value id = message.get("id", Json::nullValue);
  if (std::optional<std::string> bad = notAString(message, "method"))
    return wm::failure(id, -32600, *bad);
  const std::string method = message["method"].asString();

  // Every branch below reads `params` by key, and jsoncpp throws rather than answers when a key
  // is asked of something that is not an object — a throw here would take the whole request down.
  const Json::Value& params = message["params"];
  if (!params.isNull() && !params.isObject())
    return wm::failure(id, -32602, "\"params\" must be an object");

  if (method == "initialize") {
    Json::Value tools(Json::objectValue);
    tools["listChanged"] = false;
    Json::Value resources(Json::objectValue);
    resources["subscribe"] = false;   // the catalog is static: nothing to subscribe to,
    resources["listChanged"] = false; // and nothing that changes under a connected client
    Json::Value capabilities(Json::objectValue);
    capabilities["tools"] = tools;
    capabilities["resources"] = resources;

    Json::Value serverInfo(Json::objectValue);
    serverInfo["name"] = info_.name;
    serverInfo["version"] = info_.version;

    if (std::optional<std::string> bad = notAString(params, "protocolVersion"))
      return wm::failure(id, -32602, *bad);
    const std::string requested = params.get("protocolVersion", "").asString();
    Json::Value payload(Json::objectValue);
    payload["protocolVersion"] = requested.empty() ? kProtocolVersion : requested;
    payload["capabilities"] = capabilities;
    payload["serverInfo"] = serverInfo;
    if (!info_.instructions.empty()) payload["instructions"] = info_.instructions;
    return result(id, payload);
  }

  if (method == "ping") return result(id, Json::Value(Json::objectValue));

  // The catalog is per-request, not per-process: two clients on the same server see different
  // surfaces because they hold different grants, which is why the caller reaches this branch at all.
  if (method == "tools/list") {
    Json::Value payload(Json::objectValue);
    payload["tools"] = tools_.listTools(caller);
    return result(id, payload);
  }

  // Resources cost no tool slot, so the document an agent needs before its first call rides
  // here rather than in a tool description. The catalog is injected by the product (may be empty).
  if (method == "resources/list") {
    Json::Value listing(Json::arrayValue);
    for (const McpResource& resource : resources_) {
      Json::Value entry(Json::objectValue);
      entry["uri"] = resource.uri;
      entry["name"] = resource.name;
      entry["title"] = resource.title;
      entry["description"] = resource.description;
      entry["mimeType"] = resource.mimeType;
      listing.append(entry);
    }
    Json::Value payload(Json::objectValue);
    payload["resources"] = listing;
    return result(id, payload);
  }

  if (method == "resources/templates/list") {  // we template no uri; an empty list, not an error
    Json::Value payload(Json::objectValue);
    payload["resourceTemplates"] = Json::Value(Json::arrayValue);
    return result(id, payload);
  }

  if (method == "resources/read") {
    if (std::optional<std::string> bad = notAString(params, "uri")) return wm::failure(id, -32602, *bad);
    const std::string uri = params.get("uri", "").asString();
    for (const McpResource& resource : resources_) {
      if (resource.uri != uri) continue;
      Json::Value block(Json::objectValue);
      block["uri"] = resource.uri;
      block["mimeType"] = resource.mimeType;
      block["text"] = resource.text;
      Json::Value contents(Json::arrayValue);
      contents.append(block);
      Json::Value payload(Json::objectValue);
      payload["contents"] = contents;
      return result(id, payload);
    }
    return wm::failure(id, -32002, "no such resource: \"" + uri + "\" — call resources/list");
  }

  if (method == "tools/call") {
    if (std::optional<std::string> bad = notAString(params, "name")) return wm::failure(id, -32602, *bad);
    const std::string name = params.get("name", "").asString();
    if (name.empty()) return wm::failure(id, -32602, "tools/call requires a \"name\"");
    const Json::Value arguments =
        params.isMember("arguments") ? params["arguments"] : Json::Value(Json::objectValue);

    ToolResult outcome = tools_.callTool(name, arguments, caller);
    Json::Value payload(Json::objectValue);
    payload["content"] = outcome.content;
    payload["isError"] = outcome.isError;
    // Only a tool that declares an `outputSchema` sets `structured`; without one the block
    // would be the answer the caller already has in `content`, shipped twice.
    if (!outcome.structured.isNull()) payload["structuredContent"] = outcome.structured;
    return result(id, payload);
  }

  // Notifications (initialized, cancelled, …) are accepted silently; unknown *requests*
  // get a method-not-found so the caller learns the surface.
  if (isNotification) return std::nullopt;
  return wm::failure(id, -32601, "unknown method: " + method);
}

}

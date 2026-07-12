#include "adapters/mcp/McpHttpEndpoint.h"

#include <memory>
#include <sstream>
#include <string_view>

namespace wm {

namespace {

drogon::HttpResponsePtr jsonResponse(const Json::Value& body, drogon::HttpStatusCode code) {
  auto response = drogon::HttpResponse::newHttpJsonResponse(body);
  response->setStatusCode(code);
  return response;
}

// A transport-level failure (bad body, session problem) has no request id to answer under,
// so it rides an HTTP status with a null-id JSON-RPC error body.
drogon::HttpResponsePtr rpcError(int code, const std::string& message, drogon::HttpStatusCode http) {
  Json::Value error(Json::objectValue);
  error["code"] = code;
  error["message"] = message;
  Json::Value body(Json::objectValue);
  body["jsonrpc"] = "2.0";
  body["id"] = Json::nullValue;
  body["error"] = error;
  return jsonResponse(body, http);
}

bool originAllowed(const std::set<std::string>& allowed, const std::string& origin) {
  if (origin.empty()) return true;  // a non-browser client sends no Origin — nothing to forge
  if (allowed.count("*")) return true;
  return allowed.count(origin) > 0;
}

// Accept whatever the client labelled its body as: prefer Drogon's parse, fall back to a
// raw parse so a missing/loose Content-Type still works.
Json::Value parseBody(const drogon::HttpRequestPtr& request) {
  if (std::shared_ptr<Json::Value> parsed = request->getJsonObject()) return *parsed;
  Json::Value root;
  std::string_view raw = request->getBody();
  Json::CharReaderBuilder builder;
  std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  std::string errors;
  reader->parse(raw.data(), raw.data() + raw.size(), &root, &errors);
  return root;
}

std::string trim(const std::string& value) {
  auto begin = value.find_first_not_of(" \t");
  if (begin == std::string::npos) return "";
  auto end = value.find_last_not_of(" \t");
  return value.substr(begin, end - begin + 1);
}

}  // namespace

std::set<std::string> parseOriginList(const std::string& csv) {
  std::set<std::string> origins;
  std::stringstream stream(csv);
  std::string item;
  while (std::getline(stream, item, ',')) {
    std::string trimmed = trim(item);
    if (!trimmed.empty()) origins.insert(trimmed);
  }
  return origins;
}

McpHttpEndpoint::McpHttpEndpoint(McpServer& server, std::set<std::string> allowedOrigins)
    : server_(server), allowedOrigins_(std::move(allowedOrigins)), rng_(std::random_device{}()) {}

std::string McpHttpEndpoint::openSession() {
  std::lock_guard<std::mutex> lock(mutex_);
  std::stringstream id;
  id << std::hex << rng_() << rng_();  // 128 unguessable bits
  std::string session = id.str();
  sessions_.insert(session);
  return session;
}

void McpHttpEndpoint::handlePost(const drogon::HttpRequestPtr& request, McpHttpCallback&& callback) {
  if (!originAllowed(allowedOrigins_, request->getHeader("Origin"))) {
    callback(rpcError(-32600, "origin not allowed", drogon::k403Forbidden));
    return;
  }

  Json::Value message = parseBody(request);
  if (!message.isObject()) {
    callback(rpcError(-32700, "parse error", drogon::k400BadRequest));
    return;
  }

  const bool isInitialize = message.get("method", "").asString() == "initialize";
  std::string sessionId = request->getHeader("Mcp-Session-Id");
  if (isInitialize) {
    sessionId = openSession();
  } else {
    if (sessionId.empty()) {
      callback(rpcError(-32600, "Mcp-Session-Id header required", drogon::k400BadRequest));
      return;
    }
    std::lock_guard<std::mutex> lock(mutex_);
    if (!sessions_.count(sessionId)) {
      callback(rpcError(-32001, "unknown or expired session", drogon::k404NotFound));
      return;
    }
  }

  std::optional<Json::Value> reply = server_.handle(message);
  if (!reply) {  // a notification/response needs no answer
    auto accepted = drogon::HttpResponse::newHttpResponse();
    accepted->setStatusCode(drogon::k202Accepted);
    callback(accepted);
    return;
  }

  auto response = jsonResponse(*reply, drogon::k200OK);
  if (isInitialize) response->addHeader("Mcp-Session-Id", sessionId);
  callback(response);
}

void McpHttpEndpoint::handleGet(const drogon::HttpRequestPtr&, McpHttpCallback&& callback) {
  // No server-initiated stream is offered, so per spec GET is 405.
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k405MethodNotAllowed);
  response->addHeader("Allow", "POST, DELETE");
  callback(response);
}

void McpHttpEndpoint::handleDelete(const drogon::HttpRequestPtr& request, McpHttpCallback&& callback) {
  auto response = drogon::HttpResponse::newHttpResponse();
  {
    std::lock_guard<std::mutex> lock(mutex_);
    bool erased = sessions_.erase(request->getHeader("Mcp-Session-Id")) > 0;
    response->setStatusCode(erased ? drogon::k200OK : drogon::k404NotFound);
  }
  callback(response);
}

}

#include "platform/adapters/mcp/McpHttpEndpoint.h"

#include "platform/adapters/http/Caller.h"  // secretEqual: one constant-time compare for every shared secret
#include "platform/application/McpKeyService.h"

#include <openssl/rand.h>

#include <memory>
#include <sstream>
#include <stdexcept>
#include <string_view>
#include <vector>

namespace wm {

namespace {

using SessionClock = std::chrono::steady_clock;
constexpr auto kSessionTtl = std::chrono::minutes(30);  // idle timeout, refreshed on each use
constexpr std::size_t kMaxSessions = 10000;             // backstop bound on the session table

// A CSPRNG session id: 16 bytes of OpenSSL entropy as lowercase hex (128 unguessable bits).
std::string mintSessionId() {
  std::vector<unsigned char> bytes(16);
  if (RAND_bytes(bytes.data(), static_cast<int>(bytes.size())) != 1)
    throw std::runtime_error("session entropy unavailable");
  static constexpr char digits[] = "0123456789abcdef";
  std::string hex(bytes.size() * 2, '0');
  for (std::size_t i = 0; i < bytes.size(); ++i) {
    hex[2 * i] = digits[bytes[i] >> 4];
    hex[2 * i + 1] = digits[bytes[i] & 0x0F];
  }
  return hex;
}

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
  // Both Drogon's getJsonObject and a manual parse throw on an over-nested body; keep the
  // whole thing a null value so handlePost answers a clean parse error, never a 500/crash.
  try {
    if (std::shared_ptr<Json::Value> parsed = request->getJsonObject()) return *parsed;
    Json::Value root;
    std::string_view raw = request->getBody();
    Json::CharReaderBuilder builder;
    std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
    std::string errors;
    reader->parse(raw.data(), raw.data() + raw.size(), &root, &errors);
    return root;
  } catch (const std::exception&) {
    return Json::Value(Json::nullValue);
  }
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

McpHttpEndpoint::McpHttpEndpoint(McpServer& server, std::set<std::string> allowedOrigins, McpAuth auth)
    : server_(server), allowedOrigins_(std::move(allowedOrigins)), auth_(std::move(auth)) {}

std::optional<UserId> McpHttpEndpoint::resolveCaller(const drogon::HttpRequestPtr& request) const {
  const bool authConfigured = auth_.oauth != nullptr || auth_.mcpKeys != nullptr || !auth_.fallbackToken.empty();
  if (!authConfigured) return auth_.fallbackUser;  // no auth wired (local/stdio, tests): the default caller

  const std::string authorization = request->getHeader("authorization");
  if (authorization.rfind("Bearer ", 0) != 0) return std::nullopt;
  const std::string bearer = authorization.substr(7);
  if (bearer.empty()) return std::nullopt;

  if (auth_.oauth)
    if (std::optional<UserId> user = auth_.oauth->resolveAccessToken(bearer, auth_.resource)) return user;
  if (auth_.mcpKeys)
    if (std::optional<UserId> user = auth_.mcpKeys->resolveKey(bearer)) return user;
  if (!auth_.fallbackToken.empty() && secretEqual(bearer, auth_.fallbackToken)) return auth_.fallbackUser;
  return std::nullopt;
}

std::string McpHttpEndpoint::openSession() {
  std::lock_guard<std::mutex> lock(mutex_);
  const auto now = SessionClock::now();
  for (auto it = sessions_.begin(); it != sessions_.end();)  // reap the lapsed before minting
    it = it->second < now ? sessions_.erase(it) : std::next(it);
  if (sessions_.size() >= kMaxSessions) sessions_.clear();  // backstop: shed the table under abuse
  std::string session = mintSessionId();
  sessions_[session] = now + kSessionTtl;
  return session;
}

void McpHttpEndpoint::handlePost(const drogon::HttpRequestPtr& request, McpHttpCallback&& callback) {
  if (!originAllowed(allowedOrigins_, request->getHeader("Origin"))) {
    callback(rpcError(-32600, "origin not allowed", drogon::k403Forbidden));
    return;
  }

  std::optional<UserId> caller = resolveCaller(request);
  if (!caller) {
    // Per the MCP Authorization spec: challenge with the resource-metadata URL so the
    // client can discover the authorization server and obtain a token.
    auto challenge = rpcError(-32001, "authorization required", drogon::k401Unauthorized);
    challenge->addHeader("WWW-Authenticate", "Bearer resource_metadata=\"" + auth_.resourceMetadataUrl + "\"");
    callback(challenge);
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
    auto it = sessions_.find(sessionId);
    if (it == sessions_.end() || it->second < SessionClock::now()) {
      if (it != sessions_.end()) sessions_.erase(it);
      callback(rpcError(-32001, "unknown or expired session", drogon::k404NotFound));
      return;
    }
    it->second = SessionClock::now() + kSessionTtl;  // sliding: activity refreshes the window
  }

  std::optional<Json::Value> reply = server_.handle(message, *caller);
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

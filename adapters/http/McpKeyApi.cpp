#include "adapters/http/McpKeyApi.h"

namespace wm {

namespace {
drogon::HttpResponsePtr jsonResponse(const Json::Value& body, drogon::HttpStatusCode code = drogon::k200OK) {
  auto response = drogon::HttpResponse::newHttpJsonResponse(body);
  response->setStatusCode(code);
  return response;
}

drogon::HttpResponsePtr error(drogon::HttpStatusCode code, const std::string& message) {
  Json::Value body(Json::objectValue);
  body["error"] = message;
  return jsonResponse(body, code);
}
}

McpKeyApi::McpKeyApi(std::shared_ptr<AuthService> auth, std::shared_ptr<McpKeyService> keys)
    : auth_(std::move(auth)), service_(std::move(keys)) {}

void McpKeyApi::createKey(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  // Mint a key for the caller and return its secret — the one and only time it is ever shown.
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to create an MCP key"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  // Tolerate a missing body and a non-string name (an array/object would make asString throw a 500).
  const std::string name = (json && (*json)["name"].isString()) ? (*json)["name"].asString() : "";

  const MintedKey key = service_->mint(*caller, name);
  Json::Value body(Json::objectValue);
  body["id"] = key.id;
  body["name"] = key.name;
  body["token"] = key.token;
  body["createdMs"] = static_cast<Json::Int64>(key.createdMs);
  callback(jsonResponse(body, drogon::k201Created));
}

void McpKeyApi::listKeys(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  // The caller's keys, newest first, without the token — lastUsedMs null until a key first acts.
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to see your MCP keys"));
    return;
  }
  Json::Value list(Json::arrayValue);
  for (const McpKeyView& view : service_->list(*caller)) {
    Json::Value row(Json::objectValue);
    row["id"] = view.id;
    row["name"] = view.name;
    row["createdMs"] = static_cast<Json::Int64>(view.createdMs);
    if (view.lastUsedMs) row["lastUsedMs"] = static_cast<Json::Int64>(*view.lastUsedMs);
    else row["lastUsedMs"] = Json::nullValue;
    list.append(row);
  }
  Json::Value body(Json::objectValue);
  body["keys"] = list;
  callback(jsonResponse(body));
}

void McpKeyApi::revokeKey(const drogon::HttpRequestPtr& req, HttpCallback&& callback,
                          const std::string& id) {
  // Revoke one key by id, scoped to the owner: a foreign or unknown id is a 404.
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to revoke an MCP key"));
    return;
  }
  if (!service_->revoke(*caller, id)) {
    callback(error(drogon::k404NotFound, "no such key"));
    return;
  }
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  callback(response);
}

}

#include "adapters/http/TreeRegistryApi.h"

#include "adapters/http/Caller.h"
#include "adapters/json/TreeJson.h"

#include <optional>
#include <utility>

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

TreeRegistryApi::TreeRegistryApi(std::shared_ptr<TreeRegistry> registry, std::shared_ptr<AuthService> auth)
    : registry_(std::move(registry)), auth_(std::move(auth)) {}

void TreeRegistryApi::createTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to plant a roadmap"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (json && !json->get("fromQuest", "").asString().empty()) {
    callback(error(drogon::k501NotImplemented, "quest planting is not available yet"));  // /v1/quests unbuilt
    return;
  }
  std::string title = json ? json->get("title", "").asString() : "";
  TreeId id = registry_->create(*caller, title);
  Json::Value body(Json::objectValue);
  body["treeId"] = id.str();
  callback(jsonResponse(body));
}

void TreeRegistryApi::listTrees(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to list your trees"));
    return;
  }
  Json::Value trees(Json::arrayValue);
  for (const TreeSummary& summary : registry_->list(*caller)) trees.append(toJson(summary));
  Json::Value body(Json::objectValue);
  body["trees"] = trees;
  callback(jsonResponse(body));
}

void TreeRegistryApi::deleteTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback,
                                 const std::string& treeId) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to delete a tree"));
    return;
  }
  TreeRegistry::Removal outcome = registry_->remove(TreeId{treeId}, *caller);
  if (outcome == TreeRegistry::Removal::notFound) {
    callback(error(drogon::k404NotFound, "no such tree"));
    return;
  }
  if (outcome == TreeRegistry::Removal::notOwner) {
    callback(error(drogon::k403Forbidden, "this tree belongs to another account"));
    return;
  }
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  callback(response);
}

}

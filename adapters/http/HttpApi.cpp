#include "adapters/http/HttpApi.h"

#include "adapters/json/TreeJson.h"
#include "domain/LooseGraph.h"
#include "domain/TreeDiagnostics.h"

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

HttpApi::HttpApi(std::shared_ptr<TreeRepository> trees, std::shared_ptr<ProgressRepository> progress,
                 Hlc genesis, UserId caller)
    : trees_(std::move(trees)), progress_(std::move(progress)), genesis_(std::move(genesis)), caller_(std::move(caller)) {}

void HttpApi::getTree(const drogon::HttpRequestPtr&, HttpCallback&& callback, const std::string& treeId) {
  std::optional<StoredTree> stored = trees_->load(TreeId{treeId});
  if (!stored) {
    callback(error(drogon::k404NotFound, "no such tree"));
    return;
  }
  Json::Value body(Json::objectValue);
  body["seq"] = static_cast<Json::Int64>(stored->head);
  body["data"] = toJson(stored->data);
  callback(jsonResponse(body));
}

void HttpApi::putTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId) {
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (!json) {
    callback(error(drogon::k400BadRequest, "invalid json body"));
    return;
  }
  TreeData data = treeFromJson(*json, TreeId{treeId});
  std::optional<StoredTree> existing = trees_->load(TreeId{treeId});
  Seq head = existing ? existing->head : 0;
  trees_->save(TreeId{treeId}, data, head);

  Json::Value body(Json::objectValue);
  body["seq"] = static_cast<Json::Int64>(head);
  body["data"] = toJson(data);
  callback(jsonResponse(body));
}

void HttpApi::getProgress(const drogon::HttpRequestPtr&, HttpCallback&& callback, const std::string& treeId) {
  Progress progress = progress_->load(TreeId{treeId}, caller_);
  callback(jsonResponse(toJson(progress)));
}

void HttpApi::getDiagnostics(const drogon::HttpRequestPtr&, HttpCallback&& callback, const std::string& treeId) {
  std::optional<StoredTree> stored = trees_->load(TreeId{treeId});
  if (!stored) {
    callback(error(drogon::k404NotFound, "no such tree"));
    return;
  }
  LooseGraph graph(stored->data, genesis_);
  callback(jsonResponse(toJson(TreeDiagnostics::assess(graph))));
}

}

#include "adapters/http/HttpApi.h"

#include "adapters/json/TreeJson.h"
#include "application/ActivityFeed.h"
#include "application/TreeRoom.h"
#include "domain/LooseGraph.h"

#include <algorithm>
#include <mutex>

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

HttpApi::HttpApi(std::shared_ptr<RoomRegistry> registry, std::shared_ptr<TreeRepository> trees,
                 std::shared_ptr<ProgressRepository> progress, std::shared_ptr<OpLog> ops, Hlc genesis, UserId caller)
    : registry_(std::move(registry)), trees_(std::move(trees)), progress_(std::move(progress)),
      ops_(std::move(ops)), genesis_(std::move(genesis)), caller_(std::move(caller)) {}

void HttpApi::getTree(const drogon::HttpRequestPtr&, HttpCallback&& callback, const std::string& treeId) {
  Json::Value body(Json::objectValue);
  bool found = true;
  {
    std::lock_guard<std::mutex> lock(registry_->strandFor(TreeId{treeId}));
    try {
      TreeRoom& room = registry_->open(TreeId{treeId});
      body["seq"] = static_cast<Json::Int64>(room.head());
      body["data"] = toJson(room.snapshot());
    } catch (const std::exception&) {
      found = false;
    }
  }
  callback(found ? jsonResponse(body) : error(drogon::k404NotFound, "no such tree"));
}

void HttpApi::getDiagnostics(const drogon::HttpRequestPtr&, HttpCallback&& callback, const std::string& treeId) {
  Json::Value body;
  bool found = true;
  {
    std::lock_guard<std::mutex> lock(registry_->strandFor(TreeId{treeId}));
    try {
      TreeRoom& room = registry_->open(TreeId{treeId});
      body = toJson(room.diagnose());
    } catch (const std::exception&) {
      found = false;
    }
  }
  callback(found ? jsonResponse(body) : error(drogon::k404NotFound, "no such tree"));
}

void HttpApi::putTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId) {
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (!json) {
    callback(error(drogon::k400BadRequest, "invalid json body"));
    return;
  }
  TreeData data = treeFromJson(*json, TreeId{treeId});
  GraphState state = LooseGraph(data, genesis_).exportState();  // seed full state from the posted tree

  Seq head = 0;
  {
    std::lock_guard<std::mutex> lock(registry_->strandFor(TreeId{treeId}));
    registry_->evict(TreeId{treeId});  // drop any live room so the next open reloads this write
    std::optional<StoredTree> existing = trees_->load(TreeId{treeId});
    head = existing ? existing->head : 0;
    trees_->save(TreeId{treeId}, state, data.title, head);
  }

  Json::Value body(Json::objectValue);
  body["seq"] = static_cast<Json::Int64>(head);
  body["data"] = toJson(data);
  callback(jsonResponse(body));
}

void HttpApi::getProgress(const drogon::HttpRequestPtr&, HttpCallback&& callback, const std::string& treeId) {
  Progress progress = progress_->load(TreeId{treeId}, caller_);
  callback(jsonResponse(toJson(progress)));
}

void HttpApi::getActivity(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId) {
  Seq since = 0;
  std::size_t limit = 100;
  try {
    if (!req->getParameter("since").empty()) since = std::stoull(req->getParameter("since"));
    if (!req->getParameter("limit").empty()) limit = std::min<std::size_t>(std::stoul(req->getParameter("limit")), 500);
  } catch (const std::exception&) {
    callback(error(drogon::k400BadRequest, "since and limit must be numbers"));
    return;
  }

  TreeData current;
  bool found = true;
  {
    std::lock_guard<std::mutex> lock(registry_->strandFor(TreeId{treeId}));
    try {
      current = registry_->open(TreeId{treeId}).snapshot();
    } catch (const std::exception&) {
      found = false;
    }
  }
  if (!found) {
    callback(error(drogon::k404NotFound, "no such tree"));
    return;
  }

  std::vector<ActivityEvent> events = activityFeed(current, ops_->since(TreeId{treeId}, since), limit);

  Json::Value list(Json::arrayValue);
  for (const ActivityEvent& event : events) {
    Json::Value item(Json::objectValue);
    item["id"] = std::to_string(event.seq);
    item["seq"] = static_cast<Json::Int64>(event.seq);
    item["at"] = static_cast<Json::Int64>(event.at);
    item["actor"] = event.actor;
    item["verb"] = event.verb;
    if (!event.node.empty()) item["nodeId"] = event.node.str();
    item["label"] = event.label;
    item["kind"] = event.kind;
    item["summary"] = event.summary;
    list.append(item);
  }
  Json::Value body(Json::objectValue);
  body["events"] = list;
  callback(jsonResponse(body));
}

}

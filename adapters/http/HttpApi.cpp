#include "adapters/http/HttpApi.h"

#include "adapters/json/TreeJson.h"
#include "application/ActivityFeed.h"
#include "application/TreeRoom.h"
#include "domain/Legend.h"
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
                 std::shared_ptr<ProgressRepository> progress, std::shared_ptr<OpLog> ops, Hlc genesis,
                 std::shared_ptr<AuthService> auth)
    : registry_(std::move(registry)), trees_(std::move(trees)), progress_(std::move(progress)),
      ops_(std::move(ops)), genesis_(std::move(genesis)), auth_(std::move(auth)) {}

std::optional<UserId> HttpApi::callerOf(const drogon::HttpRequestPtr& req) const {
  std::string secret = req->getCookie("wm_session");
  if (secret.empty()) {
    std::string authorization = req->getHeader("authorization");
    if (authorization.rfind("Bearer ", 0) == 0) secret = authorization.substr(7);
  }
  std::optional<User> user = auth_->authenticate(secret);
  if (!user) return std::nullopt;
  return user->id;
}

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
  std::optional<UserId> caller = callerOf(req);
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to edit"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (!json) {
    callback(error(drogon::k400BadRequest, "invalid json body"));
    return;
  }
  TreeData data = treeFromJson(*json, TreeId{treeId});
  GraphState state = LooseGraph(data, genesis_).exportState();  // seed full state from the posted tree

  Seq head = 0;
  LegendState legend;
  bool forbidden = false;
  {
    std::lock_guard<std::mutex> lock(registry_->strandFor(TreeId{treeId}));
    std::optional<StoredTree> existing = trees_->load(TreeId{treeId});
    if (existing && existing->owner && *existing->owner != *caller) {
      forbidden = true;  // someone else's tree — refuse the overwrite
    } else {
      registry_->evict(TreeId{treeId});  // drop any live room so the next open reloads this write
      head = existing ? existing->head : 0;
      // The legend is part of the document: honour a posted one; otherwise seed the three
      // defaults for a brand-new tree, or keep the existing legend on an overwrite.
      if (!data.kinds.empty()) legend = Legend(data.kinds, genesis_).exportState();
      else if (existing) legend = existing->legend;
      else legend = Legend::seededDefaults(genesis_).exportState();
      trees_->save(TreeId{treeId}, state, legend, data.title, head);
      trees_->claim(TreeId{treeId}, *caller);  // first writer becomes the owner
    }
  }
  if (forbidden) {
    callback(error(drogon::k403Forbidden, "this tree belongs to another account"));
    return;
  }

  data.kinds = Legend(legend).kinds();  // reflect the authoritative legend back to the client
  Json::Value body(Json::objectValue);
  body["seq"] = static_cast<Json::Int64>(head);
  body["data"] = toJson(data);
  callback(jsonResponse(body));
}

void HttpApi::forkTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId) {
  std::optional<UserId> caller = callerOf(req);
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to fork"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  std::string newId = json ? json->get("id", "").asString() : "";
  if (newId.empty()) {
    callback(error(drogon::k400BadRequest, "fork requires a target id"));
    return;
  }

  // Copy the source's *current* authoritative state (live edits folded in), not just its
  // last snapshot — so the fork is a faithful duplicate the instant it is taken.
  TreeData data;
  GraphState state;
  LegendState legend;
  std::string title;
  bool found = true;
  {
    std::lock_guard<std::mutex> lock(registry_->strandFor(TreeId{treeId}));
    try {
      TreeRoom& room = registry_->open(TreeId{treeId});
      data = room.snapshot();
      state = room.exportState();
      legend = room.exportLegend();
      title = room.title();
    } catch (const std::exception&) {
      found = false;
    }
  }
  if (!found) {
    callback(error(drogon::k404NotFound, "no such tree"));
    return;
  }

  std::string forkTitle = (json && json->isMember("title")) ? json->get("title", "").asString() : title;

  bool conflict = false;
  {
    std::lock_guard<std::mutex> lock(registry_->strandFor(TreeId{newId}));
    if (trees_->load(TreeId{newId})) conflict = true;
    else trees_->fork(TreeId{newId}, TreeId{treeId}, state, legend, forkTitle, *caller);
  }
  if (conflict) {
    callback(error(drogon::k409Conflict, "a tree with that id already exists"));
    return;
  }

  data.id = TreeId{newId};
  data.title = forkTitle;
  Json::Value body(Json::objectValue);
  body["seq"] = static_cast<Json::Int64>(0);
  body["data"] = toJson(data);  // includes the copied kinds, verbatim
  callback(jsonResponse(body, drogon::k201Created));
}

void HttpApi::getProgress(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId) {
  std::optional<UserId> caller = callerOf(req);  // the overlay is private per user
  Progress progress = caller ? progress_->load(TreeId{treeId}, *caller) : Progress{};
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

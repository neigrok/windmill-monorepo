#include "products/roadmap/adapters/http/TreeRegistryApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "products/roadmap/adapters/json/TreeJson.h"
#include "platform/domain/Access.h"

#include <optional>
#include <utility>

namespace wm {

// No billing gate here: setting a tree private is free (the paid line is tending, not privacy), so
// the registry needs only the tree store and the auth boundary.
TreeRegistryApi::TreeRegistryApi(std::shared_ptr<TreeRegistry> registry, std::shared_ptr<AuthService> auth)
    : registry_(std::move(registry)), auth_(std::move(auth)) {}

void TreeRegistryApi::createTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to plant a roadmap"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  // An optional client-minted id (the anon-first claim seam) rides the body; it must match
  // the server's own mint shape exactly, or the claim is refused before any work happens.
  const std::string requestedId = json ? json->get("id", "").asString() : "";
  if (!requestedId.empty() && !wellFormedTreeId(requestedId)) {
    callback(error(drogon::k400BadRequest, "id must be t_ followed by 16 lowercase hex characters", "bad-id"));
    return;
  }
  // The body carries the starting document — title, and any initial nodes + legend kinds (the same
  // TreeData wire shape a PUT takes). A bare `{title}`/`{blank:true}` has no nodes, so it's empty.
  TreeData initial = json ? treeFromJson(*json, TreeId{}) : TreeData{};

  if (requestedId.empty()) {
    Json::Value body(Json::objectValue);
    body["treeId"] = registry_->create(*caller, initial).str();
    body["existed"] = false;
    callback(jsonResponse(body));
    return;
  }

  TreeRegistry::Creation outcome = registry_->create(*caller, TreeId{requestedId}, initial);
  if (outcome == TreeRegistry::Creation::taken) {
    callback(error(drogon::k409Conflict, "that id already names another tree", "id-taken"));
    return;
  }
  // The caller's own retired id. Told apart from `id-taken` so the claim path can honour the
  // delete (drop the device's leftovers) instead of re-planting the tree under a fresh id. Only
  // ever sent to the account that owned it, so it reveals nothing about anyone else's ids.
  if (outcome == TreeRegistry::Creation::retired) {
    callback(error(drogon::k409Conflict, "that id names a roadmap you deleted", "id-retired"));
    return;
  }
  Json::Value body(Json::objectValue);
  body["treeId"] = requestedId;
  body["existed"] = outcome == TreeRegistry::Creation::existedYours;
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

void TreeRegistryApi::patchTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback,
                                const std::string& treeId) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to edit a tree"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();

  // The share seam rides the same PATCH as rename: a {visibility} body reshares the tree,
  // a {title} body renames it. One authenticated, owner-gated edit either way.
  if (json && json->isMember("visibility")) {
    const std::string requested = (*json)["visibility"].asString();
    if (requested != "private" && requested != "unlisted" && requested != "public") {
      callback(error(drogon::k400BadRequest, "visibility must be private, unlisted, or public"));
      return;
    }
    TreeRegistry::VisibilityChange outcome =
        registry_->setVisibility(TreeId{treeId}, *caller, parseVisibility(requested));
    if (outcome == TreeRegistry::VisibilityChange::notFound) {
      callback(error(drogon::k404NotFound, "no such tree"));
      return;
    }
    if (outcome == TreeRegistry::VisibilityChange::notOwner) {
      callback(error(drogon::k403Forbidden, "this tree belongs to another account"));
      return;
    }
    auto response = drogon::HttpResponse::newHttpResponse();
    response->setStatusCode(drogon::k204NoContent);
    callback(response);
    return;
  }

  const std::string title = json ? json->get("title", "").asString() : "";
  TreeRegistry::Renaming outcome = registry_->rename(TreeId{treeId}, *caller, title);
  if (outcome == TreeRegistry::Renaming::blankTitle) {
    callback(error(drogon::k400BadRequest, "a tree always has a name"));
    return;
  }
  if (outcome == TreeRegistry::Renaming::notFound) {
    callback(error(drogon::k404NotFound, "no such tree"));
    return;
  }
  if (outcome == TreeRegistry::Renaming::notOwner) {
    callback(error(drogon::k403Forbidden, "this tree belongs to another account"));
    return;
  }
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  callback(response);
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

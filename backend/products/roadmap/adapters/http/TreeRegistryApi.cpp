#include "products/roadmap/adapters/http/TreeRegistryApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "products/roadmap/adapters/json/TreeJson.h"
#include "products/roadmap/domain/Command.h"
#include "products/roadmap/domain/Access.h"

#include <cstddef>
#include <optional>
#include <utility>
#include <variant>

namespace wm {

namespace {
// A refused write answers with the shared sentence and its code, so a client branches on the
// code and a reader is never told an unowned tree is somebody else's.
drogon::HttpResponsePtr forbidden(WriteRefusal refusal) {
  return error(drogon::k403Forbidden, sentenceOf(refusal), codeOf(refusal));
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
  // jsoncpp throws on a keyed read of an array or a scalar, so a non-object root is refused first.
  if (json && !json->isObject()) {
    callback(error(drogon::k400BadRequest, "invalid json body"));
    return;
  }
  // An optional client-minted id rides the body; it must match the server's own mint shape.
  const std::string requestedId = json ? json->get("id", "").asString() : "";
  if (!requestedId.empty() && !wellFormedTreeId(requestedId)) {
    callback(error(drogon::k400BadRequest, "id must be t_ followed by 16 lowercase hex characters", "bad-id"));
    return;
  }
  // The body carries the starting document: title, and any initial nodes + legend kinds.
  std::optional<TreeData> parsed = json ? treeFromJson(*json, TreeId{}) : TreeData{};
  if (!parsed) {
    callback(error(drogon::k400BadRequest, "invalid json body"));
    return;
  }
  TreeData initial = *std::move(parsed);
  // The same caps the command path enforces, before a byte is persisted.
  if (std::optional<Admission> refusal = admit(initial)) {
    const bool tooLarge = refusal->verdict == Admission::Verdict::tooLarge;
    callback(error(tooLarge ? drogon::k413RequestEntityTooLarge : drogon::k400BadRequest, refusal->reason));
    return;
  }

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
  // The caller's own retired id, told apart from `id-taken`. Only ever sent to the account that
  // owned it.
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
  // A body that is there but is not one JSON object is refused, never read as an empty rename.
  if ((json && !json->isObject()) || (!json && !req->body().empty())) {
    callback(error(drogon::k400BadRequest, "invalid json body"));
    return;
  }
  std::size_t registers = 0;
  for (const char* field : {"visibility", "guide", "title"}) registers += json && json->isMember(field);
  if (registers > 1) {
    callback(error(drogon::k400BadRequest, "a PATCH sets one register per call: send visibility, guide or title alone"));
    return;
  }

  // A {visibility} body reshares the tree, a {guide} body sets its guide, a {title} body renames it.
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
    if (outcome == TreeRegistry::VisibilityChange::notYours) {
      callback(forbidden(WriteRefusal::notYours));
      return;
    }
    if (outcome == TreeRegistry::VisibilityChange::nobodysTree) {
      callback(forbidden(WriteRefusal::nobodysTree));
      return;
    }
    auto response = drogon::HttpResponse::newHttpResponse();
    response->setStatusCode(drogon::k204NoContent);
    callback(response);
    return;
  }

  if (json && json->isMember("guide")) {
    if (!(*json)["guide"].isString()) {
      callback(error(drogon::k400BadRequest, "guide must be a string"));
      return;
    }
    const std::variant<TreeRegistry::GuideChange, Admission> outcome =
        registry_->setGuide(TreeId{treeId}, *caller, (*json)["guide"].asString());
    if (const Admission* refusal = std::get_if<Admission>(&outcome)) {
      callback(error(drogon::k400BadRequest, refusal->reason));
      return;
    }
    const TreeRegistry::GuideChange change = std::get<TreeRegistry::GuideChange>(outcome);
    if (change == TreeRegistry::GuideChange::notFound) {
      callback(error(drogon::k404NotFound, "no such tree"));
      return;
    }
    if (change == TreeRegistry::GuideChange::notYours) {
      callback(forbidden(WriteRefusal::notYours));
      return;
    }
    if (change == TreeRegistry::GuideChange::nobodysTree) {
      callback(forbidden(WriteRefusal::nobodysTree));
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
  if (outcome == TreeRegistry::Renaming::malformedTitle) {
    callback(error(drogon::k400BadRequest, "the title is not valid UTF-8"));
    return;
  }
  if (outcome == TreeRegistry::Renaming::nulInTitle) {
    callback(error(drogon::k400BadRequest, "the title contains a NUL character"));
    return;
  }
  if (outcome == TreeRegistry::Renaming::notFound) {
    callback(error(drogon::k404NotFound, "no such tree"));
    return;
  }
  if (outcome == TreeRegistry::Renaming::notYours) {
    callback(forbidden(WriteRefusal::notYours));
    return;
  }
  if (outcome == TreeRegistry::Renaming::nobodysTree) {
    callback(forbidden(WriteRefusal::nobodysTree));
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
  if (outcome == TreeRegistry::Removal::notYours) {
    callback(forbidden(WriteRefusal::notYours));
    return;
  }
  if (outcome == TreeRegistry::Removal::nobodysTree) {
    callback(forbidden(WriteRefusal::nobodysTree));
    return;
  }
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  callback(response);
}

}

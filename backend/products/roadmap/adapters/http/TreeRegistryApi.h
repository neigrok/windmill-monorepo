#pragma once

#include "platform/application/AuthService.h"
#include "products/roadmap/application/TreeRegistry.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// The per-user tree registry over REST, credentialed by the wm_session cookie.
class TreeRegistryApi {
public:
  TreeRegistryApi(std::shared_ptr<TreeRegistry> registry, std::shared_ptr<AuthService> auth);

  void createTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback);                      // POST   /v1/trees
  void listTrees(const drogon::HttpRequestPtr& req, HttpCallback&& callback);                       // GET    /v1/trees
  void patchTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);   // PATCH  /v1/trees/:id — one of {visibility}, {guide} or {title}
  void deleteTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);  // DELETE /v1/trees/:id — 200 with what went with it

private:
  std::shared_ptr<TreeRegistry> registry_;
  std::shared_ptr<AuthService> auth_;
};

}

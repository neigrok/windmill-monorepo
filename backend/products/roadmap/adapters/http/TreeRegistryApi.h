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

// The per-user tree registry over REST: list the roadmaps you own, rename one, delete one.
// Credentialed by the wm_session cookie — the read/write halves of the switcher's YOURS list.
class TreeRegistryApi {
public:
  TreeRegistryApi(std::shared_ptr<TreeRegistry> registry, std::shared_ptr<AuthService> auth);

  void createTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback);                      // POST   /v1/trees
  void listTrees(const drogon::HttpRequestPtr& req, HttpCallback&& callback);                       // GET    /v1/trees
  void patchTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);   // PATCH  /v1/trees/:id — {title} and/or {visibility}
  void deleteTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);  // DELETE /v1/trees/:id

private:

  std::shared_ptr<TreeRegistry> registry_;
  std::shared_ptr<AuthService> auth_;
};

}

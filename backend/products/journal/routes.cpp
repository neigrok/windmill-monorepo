#include "products/journal/routes.h"

#include "products/journal/adapters/http/JournalApi.h"

#include <drogon/drogon.h>

#include <memory>
#include <string>
#include <utility>

namespace wm::journal {

// The journal product's whole HTTP surface, mounted behind one named seam — the same shape
// roadmap's registerRoutes has. main.cpp builds the collaborators, bundles them into
// JournalDeps, and calls this beside the roadmap mount.
void registerRoutes(drogon::HttpAppFramework& app, const JournalDeps& deps) {
  auto api = std::make_shared<JournalApi>(deps.pageService, deps.authService);

  app.registerHandler(
      "/v1/journal/page/{date}",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& date) {
        api->getPage(req, std::move(cb), date);
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/journal/page/{date}",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& date) {
        api->putPage(req, std::move(cb), date);
      },
      {drogon::Put});
  app.registerHandler(
      "/v1/journal/pages",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        api->listPages(req, std::move(cb));
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/journal/export",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        api->exportAll(req, std::move(cb));
      },
      {drogon::Get});
}

}

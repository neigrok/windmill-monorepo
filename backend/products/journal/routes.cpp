#include "products/journal/routes.h"

#include "products/journal/adapters/http/EchoApi.h"
#include "products/journal/adapters/http/JournalApi.h"
#include "products/journal/adapters/http/NudgeApi.h"

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

  // The nudge control surface. The two settings verbs ride the ordinary session; pause and
  // unsubscribe carry no credential but the secret from someone's own mail and answer 204 either
  // way, so neither can be asked whose nudges exist — and both are POST-only, out of reach of the
  // scanners that GET every URL in a mail. The admin sweep is the operator's rehearsal door,
  // closed unless the deploy set a token.
  auto nudgeApi = std::make_shared<NudgeApi>(deps.nudges, deps.nudgeSweep, deps.authService,
                                             deps.tokens, deps.clock, deps.nudgeAdminToken);
  app.registerHandler(
      "/v1/journal/nudge",
      [nudgeApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        nudgeApi->getSettings(req, std::move(cb));
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/journal/nudge",
      [nudgeApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        nudgeApi->patchSettings(req, std::move(cb));
      },
      {drogon::Patch});
  app.registerHandler(
      "/v1/journal/nudge/pause",
      [nudgeApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        nudgeApi->pause(req, std::move(cb));
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/journal/nudge/unsubscribe",
      [nudgeApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        nudgeApi->unsubscribe(req, std::move(cb));
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/admin/journal/nudge/sweep",
      [nudgeApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        nudgeApi->adminSweep(req, std::move(cb));
      },
      {drogon::Post});

  // The echo read surface (Windmill One). Entitlement-free by design: only the nightly sweep ever
  // computes echoes, and it computes none for a non-subscriber, so their list is simply empty —
  // "absent, not locked" needs no gate here. The admin sweep is the operator's rehearsal of one
  // nightly pass, closed unless the deploy set a token.
  auto echoApi = std::make_shared<EchoApi>(deps.echoes, deps.echoSweep, deps.authService,
                                           deps.echoAdminToken);
  app.registerHandler(
      "/v1/journal/echoes",
      [echoApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        echoApi->listEchoes(req, std::move(cb));
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/journal/echoes/{date}/dismiss",
      [echoApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& date) {
        echoApi->dismiss(req, std::move(cb), date);
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/admin/journal/echo/sweep",
      [echoApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        echoApi->adminSweep(req, std::move(cb));
      },
      {drogon::Post});
}

}

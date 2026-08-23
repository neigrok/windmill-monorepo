#include "products/journal/routes.h"

#include "products/journal/adapters/http/EchoApi.h"
#include "products/journal/adapters/http/JournalApi.h"
#include "products/journal/adapters/http/NudgeApi.h"
#include "products/journal/adapters/http/VoiceApi.h"

#include <drogon/drogon.h>

#include <memory>
#include <string>
#include <utility>

namespace wm::journal {

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

  // The settings verbs ride the ordinary session. Pause and unsubscribe carry only the secret from
  // someone's own mail, answer 204 either way so neither reveals whose nudges exist, and are
  // POST-only. The admin sweep is closed unless the deploy set a token.
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

  // The sweep derives for everyone and the entitlement is asked here. The admin sweep is closed
  // unless the deploy set a token.
  auto echoApi = std::make_shared<EchoApi>(deps.echoes, deps.echoSweep, deps.echoExplainer,
                                           deps.authService, deps.entitlements,
                                           deps.echoAdminToken);
  app.registerHandler(
      "/v1/journal/echoes",
      [echoApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        echoApi->listEchoes(req, std::move(cb));
      },
      {drogon::Get});
  // Three dismissal doors: one page's echoes, one pairing, or the offer alone.
  //
  // Order is load-bearing: the offer door must be registered before the pair door, because drogon
  // matches in registration order and `{matchDay}` binds the literal "offer". Do not sort this block.
  app.registerHandler(
      "/v1/journal/echoes/{triggerDay}/offer/dismiss",
      [echoApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                const std::string& triggerDay) {
        echoApi->dismissOffer(req, std::move(cb), triggerDay);
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/journal/echoes/{triggerDay}/dismiss",
      [echoApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                const std::string& triggerDay) {
        echoApi->dismissPage(req, std::move(cb), triggerDay);
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/journal/echoes/{triggerDay}/{matchDay}/dismiss",
      [echoApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                const std::string& triggerDay, const std::string& matchDay) {
        echoApi->dismiss(req, std::move(cb), triggerDay, matchDay);
      },
      {drogon::Post});
  // The two quality signals, both owner-only and both 204 however many times they are pressed. Each
  // ends in a distinct literal, so neither is swallowed by the pair dismissal above.
  app.registerHandler(
      "/v1/journal/echoes/{triggerDay}/{matchDay}/useful",
      [echoApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                const std::string& triggerDay, const std::string& matchDay) {
        echoApi->markUseful(req, std::move(cb), triggerDay, matchDay);
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/journal/echoes/{triggerDay}/{matchDay}/opened",
      [echoApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                const std::string& triggerDay, const std::string& matchDay) {
        echoApi->opened(req, std::move(cb), triggerDay, matchDay);
      },
      {drogon::Post});
  // Takes the admin token and a signed-in owner, and explains that account's page. Writes nothing.
  app.registerHandler(
      "/v1/admin/journal/echo/explain/{day}",
      [echoApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& day) {
        echoApi->explainPage(req, std::move(cb), day);
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/admin/journal/echo/sweep",
      [echoApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        echoApi->adminSweep(req, std::move(cb));
      },
      {drogon::Post});

  // The entitlement is checked before any audio is touched; no vendor wired means a 503.
  auto voiceApi = std::make_shared<VoiceApi>(deps.transcriber, deps.entitlements, deps.authService);
  app.registerHandler(
      "/v1/journal/transcribe",
      [voiceApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        voiceApi->transcribe(req, std::move(cb));
      },
      {drogon::Post});
}

}

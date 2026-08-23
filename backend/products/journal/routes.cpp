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

// The journal product's whole HTTP surface, mounted behind one named seam.
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
  // scanners that GET every URL in a mail. The admin sweep is closed unless the deploy set a token.
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

  // The echo read surface (Windmill One). The sweep derives for everyone and the ENTITLEMENT IS
  // ASKED HERE: the honest-cut state has to show a non-subscriber that echoes exist, how many, and
  // the real opening words of the nearest one. The admin sweep is closed unless the deploy set a
  // token.
  auto echoApi = std::make_shared<EchoApi>(deps.echoes, deps.echoSweep, deps.echoExplainer,
                                           deps.authService, deps.entitlements,
                                           deps.echoAdminToken);
  app.registerHandler(
      "/v1/journal/echoes",
      [echoApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        echoApi->listEchoes(req, std::move(cb));
      },
      {drogon::Get});
  // Three dismissal doors. "Not useful" sits on the panel and retires a whole page's echoes; naming
  // both days retires one pairing; both land on the same content-hash key, so neither can be undone
  // by inserting a sentence. "Not now" retires only the OFFER, keeps every echo, and keys on the day.
  //
  // ORDER IS LOAD-BEARING: the offer door must be registered BEFORE the pair door, because drogon
  // matches these patterns in registration order and `{matchDay}` binds the literal "offer".
  // Swapped, /echoes/2026-07-01/offer/dismiss lands in the pair handler. Do not sort this block.
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
  // The two quality signals, both owner-only and both 204 however many times they are pressed.
  // Three segments each ending in a distinct literal, so neither can be swallowed by the pair
  // dismissal above however this block is ordered. "useful" is the reader saying so; "opened" is
  // the walk back to the older page, a weaker label and its own kind because of it.
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
  // The tuning door. Under /v1/admin because it takes the admin token and answers with the
  // pipeline's own internals, but it asks for a signed-in owner too and explains THAT account's
  // page. It writes nothing, so running it never settles a page the live path still owes.
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

  // Voice (Windmill One): talk, get text. The entitlement is checked before any audio is touched,
  // and no vendor wired means a plain 503.
  auto voiceApi = std::make_shared<VoiceApi>(deps.transcriber, deps.entitlements, deps.authService);
  app.registerHandler(
      "/v1/journal/transcribe",
      [voiceApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        voiceApi->transcribe(req, std::move(cb));
      },
      {drogon::Post});
}

}

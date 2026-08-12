#include "products/gym/routes.h"

#include "products/gym/adapters/http/CoachApi.h"
#include "products/gym/adapters/http/GymApi.h"

#include <drogon/drogon.h>

#include <memory>
#include <string>
#include <utility>

namespace wm::gym {

// The gym product's whole HTTP surface, mounted behind one named seam — the same shape roadmap's
// and journal's registerRoutes have. main.cpp builds the collaborators, bundles them into GymDeps,
// and calls this beside the other two mounts. Every path below is owner-scoped but the last one,
// which is the coach share's read and is the only unauthenticated route in the product.
void registerRoutes(drogon::HttpAppFramework& app, const GymDeps& deps) {
  auto api = std::make_shared<GymApi>(deps.logService, deps.authService, deps.appBaseUrl);

  app.registerHandler(
      "/v1/gym/exercises",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        api->listExercises(req, std::move(cb));
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/gym/exercises",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        api->createExercise(req, std::move(cb));
      },
      {drogon::Post});
  // The rename is a PATCH and not a PUT because ONE field of a movement is a lifter's to change:
  // a PUT would promise the whole row, and the pattern, equipment and step of a seed belong to the
  // catalog rather than to any one account.
  app.registerHandler(
      "/v1/gym/exercises/{id}",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->renameExercise(req, std::move(cb), id);
      },
      {drogon::Patch});
  // A movement's record — the page that replaced the statistics room. It hangs off the movement's
  // own path because that is what it is about, and it is the one read in gym that answers a whole
  // screen: the tiles, the chart, the ladder and the days in one call.
  app.registerHandler(
      "/v1/gym/exercises/{id}/record",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->exerciseRecord(req, std::move(cb), id);
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/gym/sessions",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        api->startSession(req, std::move(cb));
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/gym/sessions/{id}/sets",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->appendSet(req, std::move(cb), id);
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/gym/sessions/{id}/finish",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->finishSession(req, std::move(cb), id);
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/gym/sessions",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        api->listSessions(req, std::move(cb));
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/gym/sessions/{id}",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->getSession(req, std::move(cb), id);
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/gym/sessions/{id}/review",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->reviewSession(req, std::move(cb), id);
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/gym/sessions/{id}",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->discardSession(req, std::move(cb), id);
      },
      {drogon::Delete});
  app.registerHandler(
      "/v1/gym/last",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        api->lastTime(req, std::move(cb));
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/gym/routines",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        api->listRoutines(req, std::move(cb));
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/gym/routines",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        api->createRoutine(req, std::move(cb));
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/gym/routines/{id}",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->getRoutine(req, std::move(cb), id);
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/gym/routines/{id}",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->replaceRoutine(req, std::move(cb), id);
      },
      {drogon::Put});
  app.registerHandler(
      "/v1/gym/routines/{id}",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->deleteRoutine(req, std::move(cb), id);
      },
      {drogon::Delete});
  app.registerHandler(
      "/v1/gym/stats",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        api->stats(req, std::move(cb));
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/gym/export",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        api->exportSets(req, std::move(cb));
      },
      {drogon::Get});
  // The coach share's two owner-scoped doors. They hang off the session's path because that is what
  // a share is about — one workout — and neither of them touches the session's own row.
  app.registerHandler(
      "/v1/gym/sessions/{id}/share",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->shareSession(req, std::move(cb), id);
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/gym/sessions/{id}/share",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->revokeShare(req, std::move(cb), id);
      },
      {drogon::Delete});
  // And the one door with no caller behind it. It deliberately does NOT live under
  // /v1/gym/sessions: a token is not a session id, and nothing sitting under the prefix where every
  // other path is owner-scoped should be readable by a stranger.
  app.registerHandler(
      "/v1/gym/shared/{token}",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& token) {
        api->sharedSession(req, std::move(cb), token);
      },
      {drogon::Get});

  // The panel, and the only conditional mount in the product. No vendor key means no coach: the path
  // does not exist, `POST` to it 404s like any other unrouted path, and the web hides the panel on
  // that answer. A route that existed only to say "not available" would be a promise this deployment
  // cannot keep, printed under somebody's workout.
  if (!deps.coachService || !deps.coachService->configured()) return;
  auto coach = std::make_shared<CoachApi>(deps.coachService, deps.authService);
  app.registerHandler(
      "/v1/gym/sessions/{id}/coach",
      [coach](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        coach->ask(req, std::move(cb), id);
      },
      {drogon::Post});
}

}

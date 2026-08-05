#include "products/gym/routes.h"

#include "products/gym/adapters/http/GymApi.h"

#include <drogon/drogon.h>

#include <memory>
#include <string>
#include <utility>

namespace wm::gym {

// The gym product's whole HTTP surface, mounted behind one named seam — the same shape roadmap's
// and journal's registerRoutes have. main.cpp builds the collaborators, bundles them into GymDeps,
// and calls this beside the other two mounts.
void registerRoutes(drogon::HttpAppFramework& app, const GymDeps& deps) {
  auto api = std::make_shared<GymApi>(deps.logService, deps.authService);

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
}

}

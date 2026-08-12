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
  // The picker's meta line for every movement this lifter has trained. It hangs off the catalog's
  // own path because it is the catalog it annotates, and `last` can never be mistaken for a movement
  // id: the id shape refuses anything under eight characters (domain/Training.cpp), so no lifter can
  // ever mint one, and no seed is called that. The singular of this read is `/v1/gym/last?exercise=`
  // — same rule, one movement, the whole block instead of its last line.
  app.registerHandler(
      "/v1/gym/exercises/last",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        api->lastSets(req, std::move(cb));
      },
      {drogon::Get});
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
  // Fix a set, and delete one. They hang off the set's own path under the workout that holds it,
  // because the workout is half the address: a set id alone would let a stale id be walked into a
  // session the caller is not looking at, and the store scopes on the pair.
  //
  // ── NO AGENT MAY EDIT OR DELETE A LOGGED SET, AND THESE TWO ROUTES THEREFORE HAVE NO MCP TOOL ──
  // Not under `gym:write`, not under `gym:delete`, not at any level a future grant invents. This is
  // a design rule and it is load-bearing, not a gap in the catalog somebody forgot to fill: the tool
  // layer is the ONLY place gym can tell an agent from a hand, and rewriting what somebody lifted is
  // the one verb reserved for the hand. The coach says so out loud rather than failing quietly —
  // *"That one is yours to change. I can read what you lifted; I can't edit it."* A wave that
  // "completes the catalog" here deletes that sentence from the product. `GymToolsTest` pins the
  // absence so it cannot be added by accident.
  app.registerHandler(
      "/v1/gym/sessions/{id}/sets/{setId}",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id,
            const std::string& setId) { api->fixSet(req, std::move(cb), id, setId); },
      {drogon::Patch});
  app.registerHandler(
      "/v1/gym/sessions/{id}/sets/{setId}",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id,
            const std::string& setId) { api->deleteSet(req, std::move(cb), id, setId); },
      {drogon::Delete});
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
  // ── THE PROPOSAL LEDGER, AND WHY APPLY IS ONLY EVER HERE ──
  // An agent reads this log, and when it wants to change a day of the program it mints a proposal
  // (`propose_routine_change`, `propose_routine_removal`) and nothing moves. These two writes are
  // what move it, and NO MCP TOOL REACHES THEM — not under `gym:write`, not under `gym:delete`, not
  // at any level a future grant invents. That is the same rule the two set writes above live under
  // and it is load-bearing in the same way: the tool layer is the only place gym can tell an agent
  // from a hand, and Apply is not a capability, it is a human act. `PUT /v1/gym/routines/{id}` above
  // stays the hand's other door and is unreachable from `GymTools` for the same reason.
  // `GymToolsTest` pins the absence so it cannot be added by accident.
  app.registerHandler(
      "/v1/gym/proposals",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        api->listProposals(req, std::move(cb));
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/gym/proposals/{id}",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->getProposal(req, std::move(cb), id);
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/gym/proposals/{id}/apply",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->applyProposal(req, std::move(cb), id);
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/gym/proposals/{id}/dismiss",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->dismissProposal(req, std::move(cb), id);
      },
      {drogon::Post});
  // §I's settings section. It is a PUT and not a PATCH for the reason the routine's replace is one:
  // the screen renders the whole document from one value it already holds, so it always has the
  // whole document to send back — and a partial write would have to make "omitted" and "cleared"
  // different things on `restSeconds`, the one field whose absence already means something (no
  // timer). There is no DELETE: the way back is the defaults, sent as a document like any other.
  app.registerHandler(
      "/v1/gym/preferences",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        api->preferences(req, std::move(cb));
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/gym/preferences",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        api->savePreferences(req, std::move(cb));
      },
      {drogon::Put});
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

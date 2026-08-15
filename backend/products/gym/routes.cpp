#include "products/gym/routes.h"

#include "products/gym/adapters/http/AskApi.h"
#include "products/gym/adapters/http/CatalogApi.h"
#include "products/gym/adapters/http/PreferencesApi.h"
#include "products/gym/adapters/http/ProgramApi.h"
#include "products/gym/adapters/http/ThreadsApi.h"
#include "products/gym/adapters/http/TrainingApi.h"

#include <drogon/drogon.h>

#include <memory>
#include <string>
#include <utility>

namespace wm::gym {

// The gym product's whole HTTP surface, mounted behind one named seam — the same shape roadmap's
// and journal's registerRoutes have. main.cpp builds the collaborators, bundles them into GymDeps,
// and calls this beside the other two mounts. The handlers live on five adapters that mirror the
// five aggregate ports — TrainingApi (the log, its reads, the share), CatalogApi, ProgramApi,
// PreferencesApi, ThreadsApi — and this file is the ONE place the paths are named, so a route's
// method, its path and the reason it hangs where it does are read in one column. Every path below is
// owner-scoped but the coach share's read, which is the only unauthenticated route in the product.
void registerRoutes(drogon::HttpAppFramework& app, const GymDeps& deps) {
  auto training =
      std::make_shared<TrainingApi>(deps.trainingService, deps.authService, deps.appBaseUrl);
  auto catalog =
      std::make_shared<CatalogApi>(deps.catalogService, deps.trainingService, deps.authService);
  auto program = std::make_shared<ProgramApi>(deps.programService, deps.authService);
  auto preferences = std::make_shared<PreferencesApi>(deps.preferencesService, deps.authService);
  auto threads = std::make_shared<ThreadsApi>(deps.threadService, deps.authService);

  app.registerHandler(
      "/v1/gym/exercises",
      [catalog](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        catalog->listExercises(req, std::move(cb));
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/gym/exercises",
      [catalog](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        catalog->createExercise(req, std::move(cb));
      },
      {drogon::Post});
  // The picker's meta line for every movement this lifter has trained. It hangs off the catalog's
  // own path because it is the catalog it annotates, and `last` can never be mistaken for a movement
  // id: the id shape refuses anything under eight characters (domain/Training.cpp), so no lifter can
  // ever mint one, and no seed is called that. The singular of this read is `/v1/gym/last?exercise=`
  // — same rule, one movement, the whole block instead of its last line.
  app.registerHandler(
      "/v1/gym/exercises/last",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        training->lastSets(req, std::move(cb));
      },
      {drogon::Get});
  // The rename is a PATCH and not a PUT because ONE field of a movement is a lifter's to change:
  // a PUT would promise the whole row, and the pattern, equipment and step of a seed belong to the
  // catalog rather than to any one account.
  app.registerHandler(
      "/v1/gym/exercises/{id}",
      [catalog](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        catalog->renameExercise(req, std::move(cb), id);
      },
      {drogon::Patch});
  // A movement's record — the page that replaced the statistics room. It hangs off the movement's
  // own path because that is what it is about, and it is the one read in gym that answers a whole
  // screen: the tiles, the chart, the ladder and the days in one call.
  app.registerHandler(
      "/v1/gym/exercises/{id}/record",
      [catalog](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        catalog->exerciseRecord(req, std::move(cb), id);
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/gym/sessions",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        training->startSession(req, std::move(cb));
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/gym/sessions/{id}/sets",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        training->appendSet(req, std::move(cb), id);
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
  // the one verb reserved for the hand. Ask says so out loud rather than failing quietly —
  // *"That one is yours to change. I can read what you lifted; I can't edit it."* A wave that
  // "completes the catalog" here deletes that sentence from the product. `GymToolsTest` pins the
  // absence so it cannot be added by accident.
  app.registerHandler(
      "/v1/gym/sessions/{id}/sets/{setId}",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id,
            const std::string& setId) { training->fixSet(req, std::move(cb), id, setId); },
      {drogon::Patch});
  app.registerHandler(
      "/v1/gym/sessions/{id}/sets/{setId}",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id,
            const std::string& setId) { training->deleteSet(req, std::move(cb), id, setId); },
      {drogon::Delete});
  app.registerHandler(
      "/v1/gym/sessions/{id}/finish",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        training->finishSession(req, std::move(cb), id);
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/gym/sessions",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        training->listSessions(req, std::move(cb));
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/gym/sessions/{id}",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        training->getSession(req, std::move(cb), id);
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/gym/sessions/{id}/review",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        training->reviewSession(req, std::move(cb), id);
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/gym/sessions/{id}",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        training->discardSession(req, std::move(cb), id);
      },
      {drogon::Delete});
  app.registerHandler(
      "/v1/gym/last",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        training->lastTime(req, std::move(cb));
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/gym/routines",
      [program](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        program->listRoutines(req, std::move(cb));
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/gym/routines",
      [program](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        program->createRoutine(req, std::move(cb));
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/gym/routines/{id}",
      [program](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        program->getRoutine(req, std::move(cb), id);
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/gym/routines/{id}",
      [program](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        program->replaceRoutine(req, std::move(cb), id);
      },
      {drogon::Put});
  app.registerHandler(
      "/v1/gym/routines/{id}",
      [program](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        program->deleteRoutine(req, std::move(cb), id);
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
      [program](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        program->listProposals(req, std::move(cb));
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/gym/proposals/{id}",
      [program](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        program->getProposal(req, std::move(cb), id);
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/gym/proposals/{id}/apply",
      [program](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        program->applyProposal(req, std::move(cb), id);
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/gym/proposals/{id}/dismiss",
      [program](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        program->dismissProposal(req, std::move(cb), id);
      },
      {drogon::Post});
  // §I's settings section. It is a PUT and not a PATCH for the reason the routine's replace is one:
  // the screen renders the whole document from one value it already holds, so it always has the
  // whole document to send back — and a partial write would have to make "omitted" and "cleared"
  // different things on `restSeconds`, the one field whose absence already means something (no
  // timer). There is no DELETE: the way back is the defaults, sent as a document like any other.
  app.registerHandler(
      "/v1/gym/preferences",
      [preferences](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        preferences->preferences(req, std::move(cb));
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/gym/preferences",
      [preferences](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        preferences->savePreferences(req, std::move(cb));
      },
      {drogon::Put});
  app.registerHandler(
      "/v1/gym/stats",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        training->stats(req, std::move(cb));
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/gym/export",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        training->exportSets(req, std::move(cb));
      },
      {drogon::Get});
  // The second file, and it hangs off the same path because it is the same promise: everything this
  // account holds, in a format nothing but a spreadsheet is needed to read. Two files rather than
  // one because a CSV row is one shape and a set and a sentence are not.
  app.registerHandler(
      "/v1/gym/export/threads",
      [threads](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        threads->exportThreads(req, std::move(cb));
      },
      {drogon::Get});
  // ASK'S THREADS (§O), MOUNTED UNCONDITIONALLY — unlike `POST /v1/gym/ask` below, which exists only
  // where a vendor key does. A conversation a lifter had is their data and not a feature of the model
  // that answered it, so a deployment that loses its key keeps every one of these three doors and
  // simply cannot be asked anything new.
  app.registerHandler(
      "/v1/gym/threads",
      [threads](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        threads->listThreads(req, std::move(cb));
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/gym/threads/{id}",
      [threads](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        threads->getThread(req, std::move(cb), id);
      },
      {drogon::Get});
  // Delete deletes the CONVERSATION and not the consequence: the proposals it minted keep their rows
  // and their place in the routine's history, and lose only the link back to a conversation that is
  // gone.
  app.registerHandler(
      "/v1/gym/threads/{id}",
      [threads](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        threads->deleteThread(req, std::move(cb), id);
      },
      {drogon::Delete});
  // The coach share's two owner-scoped doors. They hang off the session's path because that is what
  // a share is about — one workout — and neither of them touches the session's own row.
  app.registerHandler(
      "/v1/gym/sessions/{id}/share",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        training->shareSession(req, std::move(cb), id);
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/gym/sessions/{id}/share",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        training->revokeShare(req, std::move(cb), id);
      },
      {drogon::Delete});
  // And the one door with no caller behind it. It deliberately does NOT live under
  // /v1/gym/sessions: a token is not a session id, and nothing sitting under the prefix where every
  // other path is owner-scoped should be readable by a stranger.
  app.registerHandler(
      "/v1/gym/shared/{token}",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& token) {
        training->sharedSession(req, std::move(cb), token);
      },
      {drogon::Get});

  // Ask, and the only conditional mount in the product. No vendor key means no Ask: the path does not
  // exist, `POST` to it 404s like any other unrouted path, and every client hides the door on that
  // answer. A route that existed only to say "not available" would be a promise this deployment
  // cannot keep, printed inside somebody's log.
  //
  // It hangs off the PRODUCT and not off a session, which is the whole of what W7 widened: Ask reads
  // the log, so pinning it to one workout belonged to the shape W7 widened and not to this one.
  if (!deps.askService || !deps.askService->configured()) return;
  auto ask = std::make_shared<AskApi>(deps.askService, deps.authService);
  app.registerHandler(
      "/v1/gym/ask",
      [ask](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { ask->ask(req, std::move(cb)); },
      {drogon::Post});
}

}

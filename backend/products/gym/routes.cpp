#include "products/gym/routes.h"

#include "products/gym/adapters/http/AskApi.h"
#include "products/gym/adapters/http/BodyweightApi.h"
#include "products/gym/adapters/http/CatalogApi.h"
#include "products/gym/adapters/http/NotesApi.h"
#include "products/gym/adapters/http/PreferencesApi.h"
#include "products/gym/adapters/http/ProgramApi.h"
#include "products/gym/adapters/http/ThreadsApi.h"
#include "products/gym/adapters/http/TrainingApi.h"

#include "platform/adapters/http/WriteRoutes.h"

#include <drogon/drogon.h>

#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace wm::gym {

// The gym product's whole HTTP surface, mounted behind one named seam — the same shape roadmap's
// and journal's registerRoutes have. main.cpp builds the collaborators, bundles them into GymDeps,
// and calls this beside the other two mounts. The handlers live on seven adapters that mirror the
// seven aggregate ports — TrainingApi (the log, its reads, the share), CatalogApi, ProgramApi,
// PreferencesApi, ThreadsApi, NotesApi, BodyweightApi — and this file is the ONE place the paths are named, so a route's
// method, its path and the reason it hangs where it does are read in one column. Every path below is
// owner-scoped but the workout share's read, which is the only unauthenticated route in the product.
void registerRoutes(drogon::HttpAppFramework& app, const GymDeps& deps) {
  WriteRoutes routes(app, "gym");
  auto training =
      std::make_shared<TrainingApi>(deps.trainingService, deps.authService, deps.appBaseUrl);
  auto catalog =
      std::make_shared<CatalogApi>(deps.catalogService, deps.trainingService, deps.authService);
  auto program = std::make_shared<ProgramApi>(deps.programService, deps.authService);
  auto preferences = std::make_shared<PreferencesApi>(deps.preferencesService, deps.authService);
  auto threads = std::make_shared<ThreadsApi>(deps.threadService, deps.authService, deps.askService);
  if (deps.onShutdown) deps.onShutdown([threads] { threads->stop(); });
  auto notes = std::make_shared<NotesApi>(deps.notesService, deps.authService);
  auto bodyweight = std::make_shared<BodyweightApi>(deps.bodyweightService, deps.authService);

  // THE RETIRED WRITE PATHS. Android 0.5.0 to 0.10.0 still send these; every client after them
  // writes through /v1/sync. Each answers 410 `client-update-required` before auth, with nothing
  // behind it, and is counted like any write, so its WARN lines show who still calls it. Those builds
  // keep a queued write on 410 and destroy it on 404, so these paths never fall back to 404.
  for (const auto& [method, path] : std::vector<std::pair<drogon::HttpMethod, std::string>>{
           {drogon::Post, "/v1/gym/exercises"},
           {drogon::Patch, "/v1/gym/exercises/{id}"},
           {drogon::Post, "/v1/gym/sessions"},
           {drogon::Delete, "/v1/gym/sessions/{id}"},
           {drogon::Post, "/v1/gym/sessions/{id}/sets"},
           {drogon::Patch, "/v1/gym/sessions/{id}/sets/{setId}"},
           {drogon::Delete, "/v1/gym/sessions/{id}/sets/{setId}"},
           {drogon::Post, "/v1/gym/sessions/{id}/finish"},
           {drogon::Post, "/v1/gym/sessions/{id}/corrections"},
           {drogon::Post, "/v1/gym/routines"},
           {drogon::Put, "/v1/gym/routines/{id}"},
           {drogon::Delete, "/v1/gym/routines/{id}"},
           {drogon::Post, "/v1/gym/proposals/{id}/apply"},
           {drogon::Post, "/v1/gym/proposals/{id}/dismiss"},
           {drogon::Put, "/v1/gym/preferences"},
           {drogon::Put, "/v1/gym/notes"},
           {drogon::Put, "/v1/gym/notes/{id}"},
           {drogon::Delete, "/v1/gym/notes/{id}"},
           {drogon::Put, "/v1/gym/bodyweight/{dateLocal}"},
           {drogon::Delete, "/v1/gym/bodyweight/{dateLocal}"}})
    routes.retire(method, path);

  routes.registerHandler(
      "/v1/gym/exercises",
      [catalog](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        catalog->listExercises(req, std::move(cb));
      },
      {drogon::Get});
  // The picker's meta line for every movement this lifter has trained. It hangs off the catalog's
  // own path because it is the catalog it annotates, and `last` can never be mistaken for a movement
  // id: the id shape refuses anything under eight characters (domain/Training.cpp), so no lifter can
  // ever mint one, and no seed is called that. The singular of this read is `/v1/gym/last?exercise=`
  // — same rule, one movement, the whole block instead of its last line.
  routes.registerHandler(
      "/v1/gym/exercises/last",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        training->lastSets(req, std::move(cb));
      },
      {drogon::Get});
  // A movement's record — the page that replaced the statistics room. It hangs off the movement's
  // own path because that is what it is about, and it is the one read in gym that answers a whole
  // screen: the tiles, the chart, the ladder and the days in one call.
  routes.registerHandler(
      "/v1/gym/exercises/{id}/record",
      [catalog](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        catalog->exerciseRecord(req, std::move(cb), id);
      },
      {drogon::Get});
  // A past workout written whole. A static path, so it is matched before the `{id}` routes beside it.
  routes.registerHandler(
      "/v1/gym/sessions/import",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        training->importSession(req, std::move(cb));
      },
      {drogon::Post});
  routes.registerHandler(
      "/v1/gym/sessions",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        training->listSessions(req, std::move(cb));
      },
      {drogon::Get});
  routes.registerHandler(
      "/v1/gym/sessions/{id}",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        training->getSession(req, std::move(cb), id);
      },
      {drogon::Get});
  routes.registerHandler(
      "/v1/gym/sessions/{id}/review",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        training->reviewSession(req, std::move(cb), id);
      },
      {drogon::Get});
  routes.registerHandler(
      "/v1/gym/last",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        training->lastTime(req, std::move(cb));
      },
      {drogon::Get});
  routes.registerHandler(
      "/v1/gym/routines",
      [program](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        program->listRoutines(req, std::move(cb));
      },
      {drogon::Get});
  routes.registerHandler(
      "/v1/gym/routines/{id}",
      [program](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        program->getRoutine(req, std::move(cb), id);
      },
      {drogon::Get});
  // ── THE PROPOSAL LEDGER ──
  // An agent reads this log, and when it wants to change a day of the program it mints a proposal
  // (`propose_routine_change`, `propose_routine_removal`) and nothing moves. The lifter applies or
  // dismisses it on a phone, through /v1/sync, and NO MCP TOOL REACHES EITHER — not under
  // `gym:write`, not under `gym:delete`, not at any level a future grant invents: the tool layer is
  // the only place gym can tell an agent from a hand, and Apply is not a capability, it is a human
  // act. `GymToolsTest` pins the absence so it cannot be added by accident.
  routes.registerHandler(
      "/v1/gym/proposals",
      [program](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        program->listProposals(req, std::move(cb));
      },
      {drogon::Get});
  routes.registerHandler(
      "/v1/gym/proposals/{id}",
      [program](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        program->getProposal(req, std::move(cb), id);
      },
      {drogon::Get});
  // §I's settings section, read whole: the defaults where nothing is stored. A phone writes it through
  // /v1/sync.
  routes.registerHandler(
      "/v1/gym/preferences",
      [preferences](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        preferences->preferences(req, std::move(cb));
      },
      {drogon::Get});
  // THE NOTES a lifter writes for Coach (§3.9), on a phone through /v1/sync: their own resource and
  // never a field on the preferences document. The list's order is precedence. Coach and connected
  // agents read Notes; save_note appends insights without changing existing notes.
  routes.registerHandler(
      "/v1/gym/notes",
      [notes](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        notes->listNotes(req, std::move(cb));
      },
      {drogon::Get});
  // BODYWEIGHT: one row per LOCAL calendar day; kilograms only on the wire. Read by every connected
  // agent through `list_bodyweight`; written on a phone through /v1/sync and by nothing else — no
  // tool at any grant level, for the reason no tool edits a logged set.
  routes.registerHandler(
      "/v1/gym/bodyweight",
      [bodyweight](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        bodyweight->listEntries(req, std::move(cb));
      },
      {drogon::Get});
  routes.registerHandler(
      "/v1/gym/stats",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        training->stats(req, std::move(cb));
      },
      {drogon::Get});
  // ASK'S THREADS (§O), MOUNTED UNCONDITIONALLY — unlike `POST /v1/gym/ask` below, which exists only
  // where a vendor key does. A conversation a lifter had is their data and not a feature of the model
  // that answered it, so a deployment that loses its key keeps these history and media doors and
  // simply cannot be asked anything new.
  routes.registerHandler("/v1/gym/threads/{thread}/attachments/{id}",
      [threads](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& thread, const std::string& id) {
        threads->putImage(req, std::move(cb), thread, id);
      }, {drogon::Put});
  routes.registerHandler("/v1/gym/threads/{thread}/attachments/{id}",
      [threads](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& thread, const std::string& id) {
        threads->getImage(req, std::move(cb), thread, id);
      }, {drogon::Get});
  routes.registerHandler("/v1/gym/threads/{thread}/generations/{request}/stop",
      [threads](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& thread, const std::string& request) {
        threads->stopGeneration(req, std::move(cb), thread, request);
      }, {drogon::Post});
  routes.registerHandler(
      "/v1/gym/threads",
      [threads](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        threads->listThreads(req, std::move(cb));
      },
      {drogon::Get});
  routes.registerHandler(
      "/v1/gym/threads/{id}",
      [threads](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        threads->getThread(req, std::move(cb), id);
      },
      {drogon::Get});
  // Delete deletes the CONVERSATION and not the consequence: the proposals it minted keep their rows
  // and their place in the routine's history, and lose only the link back to a conversation that is
  // gone.
  routes.registerHandler(
      "/v1/gym/threads/{id}",
      [threads](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        threads->deleteThread(req, std::move(cb), id);
      },
      {drogon::Delete});
  // The workout share's two owner-scoped doors. They hang off the session's path because that is what
  // a share is about — one workout — and neither of them touches the session's own row.
  routes.registerHandler(
      "/v1/gym/sessions/{id}/share",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        training->shareSession(req, std::move(cb), id);
      },
      {drogon::Post});
  routes.registerHandler(
      "/v1/gym/sessions/{id}/share",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        training->revokeShare(req, std::move(cb), id);
      },
      {drogon::Delete});
  // And the one door with no caller behind it. It deliberately does NOT live under
  // /v1/gym/sessions: a token is not a session id, and nothing sitting under the prefix where every
  // other path is owner-scoped should be readable by a stranger.
  routes.registerHandler(
      "/v1/gym/shared/{token}",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& token) {
        training->sharedSession(req, std::move(cb), token);
      },
      {drogon::Get});

  routes.registerHandler("/v1/gym/history",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        training->history(req, std::move(cb));
      }, {drogon::Get});
  routes.registerHandler("/v1/gym/log-shares",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        training->createLogShare(req, std::move(cb));
      }, {drogon::Post});
  routes.registerHandler("/v1/gym/log-shares",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        training->listLogShares(req, std::move(cb));
      }, {drogon::Get});
  routes.registerHandler("/v1/gym/log-shares/{id}",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        training->revokeLogShare(req, std::move(cb), id);
      }, {drogon::Delete});
  routes.registerHandler("/v1/gym/shared-logs/{token}",
      [training](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& token) {
        training->sharedHistory(req, std::move(cb), token);
      }, {drogon::Get});

  // Ask, and the only conditional mount in the product. No vendor key means no Ask: the path does not
  // exist, `POST` to it 404s like any other unrouted path, and every client hides the door on that
  // answer. A route that existed only to say "not available" would be a promise this deployment
  // cannot keep, printed inside somebody's log.
  //
  // It hangs off the PRODUCT and not off a session, which is the whole of what W7 widened: Ask reads
  // the log, so pinning it to one workout belonged to the shape W7 widened and not to this one.
  if (!deps.askService || !deps.askService->configured()) return;
  auto ask = std::make_shared<AskApi>(deps.askService, deps.authService);
  routes.registerHandler(
      "/v1/gym/ask",
      [ask](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { ask->ask(req, std::move(cb)); },
      {drogon::Post});
}

}

#pragma once

#include "platform/application/AuthService.h"
#include "products/gym/application/LogService.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm::gym {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// The training log over REST. Every handler that reads the log resolves the caller first and 401s
// before touching storage, and every one of those reads and writes is scoped to that caller —
// absent is byte-identical to forbidden on all of them.
//
// `sharedSession` is the ONE exception and the only unauthenticated route in gym: the token in the
// path is the whole credential. It is not a hole in the rule above — it reaches a row in a separate
// table that the owner minted on purpose, it carries nothing about the account, and revoked,
// expired and never-existed answer the same 404 byte for byte so a token cannot be probed for
// existence. Every other route is exactly as owner-scoped as it was before sharing existed.
//
// The status ladder is the whole contract with the client's flush queue, which branches on the
// status and the machine word beside it (ARCHITECTURE §6): 400 is the client's and terminal — an
// unreadable body, an instant outside the wire's bounds, a set or a routine entry naming no known
// movement; 404 is the fact that a session, a routine or a movement named IN THE PATH is absent,
// which is byte-identical to it being another account's — `/v1/gym/last?exercise=` keeps its 400
// `unknown-exercise` because the movement is an argument to a read about the log there, not the
// thing the path asks for; 409 is the family about something already spent or already running — a
// session, set, routine or movement id that is taken, the start that would have joined a live
// workout, and the discard of a workout still being logged into; 500 is the server's and retryable —
// a storage failure rides past the handlers' `catch (InvalidTraining&)` to the house exception
// handler on purpose, because a queue told "your set is malformed" by a five-second lock wait drops
// it forever.
//
// Nineteen refusals carry a machine word under `code`, because their repairs differ and prose is
// not a contract: session-id-taken · session-already-open · session-finished · session-open ·
// set-id-taken · set-deleted · routine-id-taken · exercise-id-taken · unknown-exercise ·
// set-not-found · fix-unreadable · preferences-unreadable · unknown-unit · bar-weight ·
// plate-weight · too-many-plates · rest-target · proposal-superseded · proposal-settled.
// Everything else has exactly one cause and the sentence is the whole of it.
//
// The proposal pair is the newest and each is a different move for the client: `proposal-superseded`
// means the routine moved after the diff was computed, so the card is settled and the lifter reads
// the routine as it now stands — there is nothing to retry. `proposal-settled` means the other
// decision was already taken (an Apply on a dismissed proposal, or the reverse) and the screen has
// gone stale. Asking for the decision that WAS taken is not a refusal at all: it replays 200 with
// the stored proposal, so a double tap on a slow connection cannot report a failure.
//
// `set-id-taken` and `set-deleted` are the pair to keep apart, and they are the reason a code is not
// a courtesy: the first is repaired by minting a fresh id and sending the set again, and doing that
// to the second would log a deleted set back into the workout under a new number.
//
// The correction's two and the settings write's six keep a tighter rule than the rest of this file:
// EVERY refusal those routes can make carries a code. The reason differs for each. A correction
// rides the phones' offline queue like every other write, and a queue branches — `set-not-found` is
// terminal (the row is gone, drop the pending edit), `fix-unreadable` is terminal and a bug in the
// client; neither is a sentence anything should ever match on. A settings write carries five
// independent values at once, so a single "could not read that" would leave the screen unable to say
// WHICH row a lifter has to go back and fix.
class GymApi {
public:
  GymApi(std::shared_ptr<LogService> log, std::shared_ptr<AuthService> auth,
         std::string appBaseUrl);

  void listExercises(const drogon::HttpRequestPtr& req, HttpCallback&& cb);   // GET  /v1/gym/exercises
  // The picker's meta, beside the catalog and not on it. `/v1/gym/last?exercise=` is one movement's
  // whole block; this is every movement's last line, which is the same rule and the answer a list
  // can draw.
  void lastSets(const drogon::HttpRequestPtr& req, HttpCallback&& cb);        // GET  /v1/gym/exercises/last
  void createExercise(const drogon::HttpRequestPtr& req, HttpCallback&& cb);  // POST /v1/gym/exercises
  void renameExercise(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                      const std::string& id);                                 // PATCH /v1/gym/exercises/{id}
  void exerciseRecord(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                      const std::string& id);                                 // GET  /v1/gym/exercises/{id}/record
  void startSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb);    // POST /v1/gym/sessions
  void appendSet(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                 const std::string& id);                                      // POST /v1/gym/sessions/{id}/sets
  // §G18's sheet, and the two writes NO AGENT MAY REACH — routes.cpp says why beside the mounts.
  void fixSet(const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id,
              const std::string& setId);                                      // PATCH  /v1/gym/sessions/{id}/sets/{setId}
  void deleteSet(const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id,
                 const std::string& setId);                                   // DELETE /v1/gym/sessions/{id}/sets/{setId}
  void finishSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                     const std::string& id);                                  // POST /v1/gym/sessions/{id}/finish
  void listSessions(const drogon::HttpRequestPtr& req, HttpCallback&& cb);    // GET  /v1/gym/sessions?before=&limit=
  void getSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                  const std::string& id);                                     // GET  /v1/gym/sessions/{id}
  void reviewSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                     const std::string& id);                                  // GET  /v1/gym/sessions/{id}/review
  void discardSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                      const std::string& id);                                 // DELETE /v1/gym/sessions/{id}
  void lastTime(const drogon::HttpRequestPtr& req, HttpCallback&& cb);        // GET  /v1/gym/last?exercise=
  void listRoutines(const drogon::HttpRequestPtr& req, HttpCallback&& cb);    // GET  /v1/gym/routines
  void createRoutine(const drogon::HttpRequestPtr& req, HttpCallback&& cb);   // POST /v1/gym/routines
  void getRoutine(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                  const std::string& id);                                     // GET  /v1/gym/routines/{id}
  void replaceRoutine(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                      const std::string& id);                                 // PUT  /v1/gym/routines/{id}
  void deleteRoutine(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                     const std::string& id);                                  // DELETE /v1/gym/routines/{id}
  // The proposal ledger's four owner-scoped doors, and the last two are THE TAP — the only writers
  // of `applied` and `dismissed` anywhere in this product. No MCP tool reaches them at any grant
  // level, because Apply is not a capability, it is a human act (routes.cpp says it beside the
  // mounts, and GymToolsTest pins the absence).
  void listProposals(const drogon::HttpRequestPtr& req, HttpCallback&& cb);   // GET  /v1/gym/proposals?routineId=&state=pending
  void getProposal(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                   const std::string& id);                                    // GET  /v1/gym/proposals/{id}
  void applyProposal(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                     const std::string& id);                                  // POST /v1/gym/proposals/{id}/apply
  void dismissProposal(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                       const std::string& id);                                // POST /v1/gym/proposals/{id}/dismiss
  // §I's five rows. The read never 404s — a lifter with no row is served the defaults — and the
  // write is the whole document, so the two carry the same shape in both directions.
  void preferences(const drogon::HttpRequestPtr& req, HttpCallback&& cb);     // GET  /v1/gym/preferences
  void savePreferences(const drogon::HttpRequestPtr& req, HttpCallback&& cb); // PUT  /v1/gym/preferences
  void stats(const drogon::HttpRequestPtr& req, HttpCallback&& cb);           // GET  /v1/gym/stats
  void exportSets(const drogon::HttpRequestPtr& req, HttpCallback&& cb);      // GET  /v1/gym/export
  void exportThreads(const drogon::HttpRequestPtr& req, HttpCallback&& cb);   // GET  /v1/gym/export/threads
  // ASK'S THREADS (§O), AND THEY LIVE ON THE LOG'S API AND NOT ON ASK'S. A deployment with no vendor
  // key registers no `POST /v1/gym/ask` at all — and the conversations a lifter already had are
  // still theirs to read, to export and to delete. A thread is somebody's own words, not a feature
  // of the model that answered them.
  void listThreads(const drogon::HttpRequestPtr& req, HttpCallback&& cb);     // GET  /v1/gym/threads
  void getThread(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                 const std::string& id);                                      // GET  /v1/gym/threads/{id}
  void deleteThread(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                    const std::string& id);                                   // DELETE /v1/gym/threads/{id}
  void shareSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                    const std::string& id);                                   // POST /v1/gym/sessions/{id}/share
  void revokeShare(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                   const std::string& id);                                    // DELETE /v1/gym/sessions/{id}/share
  void sharedSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                     const std::string& token);                               // GET  /v1/gym/shared/{token}

private:
  std::shared_ptr<LogService> log_;
  std::string appBaseUrl_;   // where the browser app is served — a share's link, and nothing else
  std::shared_ptr<AuthService> auth_;
};

}

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
// Eleven refusals carry a machine word under `code`, because their repairs differ and prose is not a
// contract: session-id-taken · session-already-open · session-finished · session-open ·
// set-id-taken · set-deleted · routine-id-taken · exercise-id-taken · unknown-exercise ·
// set-not-found · fix-unreadable. Everything else has exactly one cause and the sentence is the
// whole of it.
//
// `set-id-taken` and `set-deleted` are the pair to keep apart, and they are the reason a code is not
// a courtesy: the first is repaired by minting a fresh id and sending the set again, and doing that
// to the second would log a deleted set back into the workout under a new number.
//
// The last two are the correction's, and EVERY refusal those two routes can make carries one, which
// is a tighter rule than the rest of this file keeps. The reason is who calls them: a correction
// rides the phones' offline queue like every other write, and a queue branches — `set-not-found` is
// terminal (the row is gone, drop the pending edit), `fix-unreadable` is terminal and a bug in the
// client. Neither is a sentence anything should ever match on.
class GymApi {
public:
  GymApi(std::shared_ptr<LogService> log, std::shared_ptr<AuthService> auth,
         std::string appBaseUrl);

  void listExercises(const drogon::HttpRequestPtr& req, HttpCallback&& cb);   // GET  /v1/gym/exercises
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
  void stats(const drogon::HttpRequestPtr& req, HttpCallback&& cb);           // GET  /v1/gym/stats
  void exportSets(const drogon::HttpRequestPtr& req, HttpCallback&& cb);      // GET  /v1/gym/export
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

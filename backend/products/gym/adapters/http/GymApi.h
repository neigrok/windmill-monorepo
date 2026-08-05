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

// The training log over REST. Every handler resolves the caller first and 401s before touching
// storage, and every read/write is scoped to that caller — no route is public, absent is
// byte-identical to forbidden.
//
// The status ladder is the whole contract with the client's flush queue, which branches on the
// status and the machine word beside it (ARCHITECTURE §6): 400 is the client's and terminal — an
// unreadable body, an instant outside the wire's bounds, a set or a routine entry naming no known
// movement; 404 is the fact that a session or a routine is absent, which is byte-identical to it
// being another account's; 409 is the family about something already spent or already running — a
// session, set, routine or movement id that is taken, the start that would have joined a live
// workout, and the discard of a workout still being logged into; 500 is the server's and retryable —
// a storage failure rides past the handlers' `catch (InvalidTraining&)` to the house exception
// handler on purpose, because a queue told "your set is malformed" by a five-second lock wait drops
// it forever.
//
// Eight refusals carry a machine word under `code`, because their repairs differ and prose is not a
// contract: session-id-taken · session-already-open · session-finished · session-open ·
// set-id-taken · routine-id-taken · exercise-id-taken · unknown-exercise. Everything else has
// exactly one cause and the sentence is the whole of it.
class GymApi {
public:
  GymApi(std::shared_ptr<LogService> log, std::shared_ptr<AuthService> auth);

  void listExercises(const drogon::HttpRequestPtr& req, HttpCallback&& cb);   // GET  /v1/gym/exercises
  void createExercise(const drogon::HttpRequestPtr& req, HttpCallback&& cb);  // POST /v1/gym/exercises
  void startSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb);    // POST /v1/gym/sessions
  void appendSet(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                 const std::string& id);                                      // POST /v1/gym/sessions/{id}/sets
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

private:
  std::shared_ptr<LogService> log_;
  std::shared_ptr<AuthService> auth_;
};

}

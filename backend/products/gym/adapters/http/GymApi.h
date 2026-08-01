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
// The status ladder is the whole contract with the client's flush queue, which branches on status
// and nothing else (ARCHITECTURE §6): 400 is the client's and terminal — an unreadable body, an
// instant outside the wire's bounds, a set naming no known movement; 409 is the one gym-specific
// refusal, appending to a finished session; 500 is the server's and retryable — a storage failure
// rides past the handlers' `catch (InvalidTraining&)` to the house exception handler on purpose,
// because a queue told "your set is malformed" by a five-second lock wait drops it forever.
class GymApi {
public:
  GymApi(std::shared_ptr<LogService> log, std::shared_ptr<AuthService> auth);

  void listExercises(const drogon::HttpRequestPtr& req, HttpCallback&& cb);   // GET  /v1/gym/exercises
  void startSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb);    // POST /v1/gym/sessions
  void appendSet(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                 const std::string& id);                                      // POST /v1/gym/sessions/{id}/sets
  void finishSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                     const std::string& id);                                  // POST /v1/gym/sessions/{id}/finish
  void listSessions(const drogon::HttpRequestPtr& req, HttpCallback&& cb);    // GET  /v1/gym/sessions?before=&limit=
  void getSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                  const std::string& id);                                     // GET  /v1/gym/sessions/{id}

private:
  std::shared_ptr<LogService> log_;
  std::shared_ptr<AuthService> auth_;
};

}

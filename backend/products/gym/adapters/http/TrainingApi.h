#pragma once

#include "platform/application/AuthService.h"
#include "products/gym/application/TrainingService.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm::gym {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// The training log over REST. Every handler resolves the caller first and 401s before touching
// storage, and every read and write is scoped to that caller: absent is byte-identical to forbidden.
//
// `sharedSession` is the only unauthenticated route in gym: the token in the path is the whole
// credential. It carries nothing about the account, and revoked, expired and never-existed answer
// the same 404 byte for byte so a token cannot be probed for existence.
//
// The status ladder holds for all five gym HTTP adapters: 400 is the client's and terminal (an
// unreadable body, an instant outside the wire's bounds, a set or routine entry naming no known
// movement); 404 is a session, routine or movement named IN THE PATH being absent, byte-identical to
// it being another account's — `/v1/gym/last?exercise=` keeps its 400 `unknown-exercise` because the
// movement is an argument there; 409 is the family about something already spent or already running;
// 500 is the server's and retryable — a storage failure rides past the handlers'
// `catch (InvalidTraining&)` to the house exception handler.
//
// The refusals carrying a machine word under `code`: session-id-taken · session-already-open ·
// session-finished · session-open · set-id-taken · set-deleted · routine-id-taken ·
// exercise-id-taken · unknown-exercise · set-not-found · fix-unreadable · preferences-unreadable ·
// unknown-unit · rest-target · proposal-superseded · proposal-settled. Everything else has exactly
// one cause and the sentence is the whole of it.
//
// `set-id-taken` is repaired by minting a fresh id and sending the set again; doing that to
// `set-deleted` would log a deleted set back into the workout under a new number.
class TrainingApi {
public:
  TrainingApi(std::shared_ptr<TrainingService> training, std::shared_ptr<AuthService> auth,
              std::string appBaseUrl);

  void startSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb);    // POST /v1/gym/sessions
  void appendSet(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                 const std::string& id);                                      // POST /v1/gym/sessions/{id}/sets
  // The two writes no agent may reach.
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
  void lastSets(const drogon::HttpRequestPtr& req, HttpCallback&& cb);        // GET  /v1/gym/exercises/last
  void stats(const drogon::HttpRequestPtr& req, HttpCallback&& cb);           // GET  /v1/gym/stats
  void exportSets(const drogon::HttpRequestPtr& req, HttpCallback&& cb);      // GET  /v1/gym/export
  void shareSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                    const std::string& id);                                   // POST /v1/gym/sessions/{id}/share
  void revokeShare(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                   const std::string& id);                                    // DELETE /v1/gym/sessions/{id}/share
  void sharedSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                     const std::string& token);                               // GET  /v1/gym/shared/{token}

private:
  std::shared_ptr<TrainingService> training_;
  std::string appBaseUrl_;   // where the browser app is served — a share's link, and nothing else
  std::shared_ptr<AuthService> auth_;
};

}

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

// Every handler resolves the caller and 401s before touching storage; every read and write is scoped
// to that caller, and absent is byte-identical to forbidden. `sharedSession` is the only
// unauthenticated route: the path token is the whole credential, and revoked, expired and
// never-existed answer the same 404 byte for byte.
//
// The status ladder across the gym HTTP adapters: 400 is the client's and terminal; 404 is a session,
// routine or movement named in the path being absent or another account's; 409 is something already
// spent or already running; 500 is the server's and retryable.
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
  std::string appBaseUrl_;   // where the browser app is served
  std::shared_ptr<AuthService> auth_;
};

}

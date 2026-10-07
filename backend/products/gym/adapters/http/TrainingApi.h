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
// spent; 503 is the engine's and retryable; 500 is the server's and retryable.
class TrainingApi {
public:
  TrainingApi(std::shared_ptr<TrainingService> training, std::shared_ptr<GymWriteDoor> door,
              std::shared_ptr<AuthService> auth,
              std::string appBaseUrl);

  void importSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb);   // POST /v1/gym/sessions/import
  void listSessions(const drogon::HttpRequestPtr& req, HttpCallback&& cb);    // GET  /v1/gym/sessions?before=&limit=
  void getSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                  const std::string& id);                                     // GET  /v1/gym/sessions/{id}
  void reviewSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                     const std::string& id);                                  // GET  /v1/gym/sessions/{id}/review
  void lastTime(const drogon::HttpRequestPtr& req, HttpCallback&& cb);        // GET  /v1/gym/last?exercise=
  void lastSets(const drogon::HttpRequestPtr& req, HttpCallback&& cb);        // GET  /v1/gym/exercises/last
  void history(const drogon::HttpRequestPtr& req, HttpCallback&& cb);
  void createLogShare(const drogon::HttpRequestPtr& req, HttpCallback&& cb);
  void listLogShares(const drogon::HttpRequestPtr& req, HttpCallback&& cb);
  void revokeLogShare(const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id);
  void sharedHistory(const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& token);
  void stats(const drogon::HttpRequestPtr& req, HttpCallback&& cb);           // GET  /v1/gym/stats
  void shareSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                    const std::string& id);                                   // POST /v1/gym/sessions/{id}/share
  void revokeShare(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                   const std::string& id);                                    // DELETE /v1/gym/sessions/{id}/share
  void sharedSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                     const std::string& token);                               // GET  /v1/gym/shared/{token}

private:
  std::shared_ptr<TrainingService> training_;
  std::shared_ptr<GymWriteDoor> door_;
  std::string appBaseUrl_;   // where the browser app is served
  std::shared_ptr<AuthService> auth_;
};

}

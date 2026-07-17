#pragma once

#include "application/AuthService.h"
#include "application/ForkService.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// The REST surface for auth (guidelines/auth.md §7). One door in, one link out, a session
// cookie on the way back. The session rides in an HttpOnly `wm_session` cookie; a Bearer
// token is also honoured for API and test callers. Every reply uses the doc's exact copy.
class AuthApi {
public:
  AuthApi(std::shared_ptr<AuthService> auth, std::shared_ptr<ForkService> fork, bool secureCookies,
          std::string cookieDomain);

  void requestLink(const drogon::HttpRequestPtr& req, HttpCallback&& callback);  // POST   /v1/auth/magic-link
  void verify(const drogon::HttpRequestPtr& req, HttpCallback&& callback);       // POST   /v1/auth/verify
  void me(const drogon::HttpRequestPtr& req, HttpCallback&& callback);           // GET    /v1/me
  void logout(const drogon::HttpRequestPtr& req, HttpCallback&& callback);       // POST   /v1/auth/logout
  void patchMe(const drogon::HttpRequestPtr& req, HttpCallback&& callback);      // PATCH  /v1/me
  void deleteMe(const drogon::HttpRequestPtr& req, HttpCallback&& callback);     // DELETE /v1/me
  void listSessions(const drogon::HttpRequestPtr& req, HttpCallback&& callback); // GET    /v1/sessions
  void revokeSession(const drogon::HttpRequestPtr& req, HttpCallback&& callback, // DELETE /v1/sessions/{id}
                     const std::string& sessionId);
  void signOutEverywhere(const drogon::HttpRequestPtr& req, HttpCallback&& callback);  // DELETE /v1/sessions

private:
  std::shared_ptr<AuthService> auth_;
  std::shared_ptr<ForkService> fork_;
  bool secureCookies_;
  std::string cookieDomain_;
};

}

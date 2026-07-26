#pragma once

#include "platform/adapters/google/GoogleOAuthClient.h"
#include "platform/application/AuthService.h"
#include "products/roadmap/application/ForkService.h"

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
// Google sign-in is a second door onto the same `wm_session`: two top-level redirects that
// mint the identical cookie, so an account reached via Google or a magic link is one account.
class AuthApi {
public:
  AuthApi(std::shared_ptr<AuthService> auth, std::shared_ptr<ForkService> fork, bool secureCookies,
          std::string cookieDomain, std::shared_ptr<GoogleOAuthClient> google = nullptr,
          std::string appUrl = "");

  void requestLink(const drogon::HttpRequestPtr& req, HttpCallback&& callback);  // POST   /v1/auth/magic-link
  void verify(const drogon::HttpRequestPtr& req, HttpCallback&& callback);       // POST   /v1/auth/verify
  void googleStart(const drogon::HttpRequestPtr& req, HttpCallback&& callback);    // GET  /v1/auth/google/start
  void googleCallback(const drogon::HttpRequestPtr& req, HttpCallback&& callback); // GET  /v1/auth/google/callback
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
  std::shared_ptr<GoogleOAuthClient> google_;  // null when Google sign-in is unconfigured
  std::string appUrl_;                         // where the Google callback lands the browser
};

}

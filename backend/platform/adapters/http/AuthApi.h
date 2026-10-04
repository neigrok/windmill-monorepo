#pragma once

#include "platform/adapters/oidc/AppleOAuthClient.h"
#include "platform/adapters/oidc/GoogleOAuthClient.h"
#include "platform/application/AuthService.h"
#include "platform/ports/SignupFork.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <set>
#include <string>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// The REST surface for auth. The app door asks the same mint for a 6-digit code (`door: "app"` on
// /magic-link) and types it back at /verify-code. Google and Apple are further doors onto the same
// `wm_session`; Apple accepts an authorization code, or a verified identity token through its gated native door.
// The session rides in an HttpOnly `wm_session` cookie; a Bearer token is also honoured.
class AuthApi {
public:
  AuthApi(std::shared_ptr<AuthService> auth, std::shared_ptr<SignupFork> signupFork, bool secureCookies,
          SessionCookieScopes cookieScopes, std::shared_ptr<GoogleOAuthClient> google = nullptr,
          std::string appUrl = "", std::shared_ptr<AppleOAuthClient> apple = nullptr,
          std::shared_ptr<AppleIdentityVerifier> appleNative = nullptr,
          std::set<std::string> allowedOrigins = {});

  void requestLink(const drogon::HttpRequestPtr& req, HttpCallback&& callback);  // POST   /v1/auth/magic-link
  void verify(const drogon::HttpRequestPtr& req, HttpCallback&& callback);       // POST   /v1/auth/verify
  void verifyCode(const drogon::HttpRequestPtr& req, HttpCallback&& callback);   // POST   /v1/auth/verify-code
  void googleStart(const drogon::HttpRequestPtr& req, HttpCallback&& callback);    // GET  /v1/auth/google/start
  void googleCallback(const drogon::HttpRequestPtr& req, HttpCallback&& callback); // GET  /v1/auth/google/callback
  void apple(const drogon::HttpRequestPtr& req, HttpCallback&& callback);        // POST   /v1/auth/apple
  void appleNative(const drogon::HttpRequestPtr& req, HttpCallback&& callback);  // POST   /v1/auth/apple/native
  void appleCreate(const drogon::HttpRequestPtr& req, HttpCallback&& callback);
  void removeApple(const drogon::HttpRequestPtr& req, HttpCallback&& callback);
  void link(const drogon::HttpRequestPtr& req, HttpCallback&& callback);         // POST   /v1/auth/link
  void me(const drogon::HttpRequestPtr& req, HttpCallback&& callback);           // GET    /v1/me
  void logout(const drogon::HttpRequestPtr& req, HttpCallback&& callback);       // POST   /v1/auth/logout
  void patchMe(const drogon::HttpRequestPtr& req, HttpCallback&& callback);      // PATCH  /v1/me
  void deleteMe(const drogon::HttpRequestPtr& req, HttpCallback&& callback);     // DELETE /v1/me
  void listSessions(const drogon::HttpRequestPtr& req, HttpCallback&& callback); // GET    /v1/sessions
  void revokeSession(const drogon::HttpRequestPtr& req, HttpCallback&& callback, // DELETE /v1/sessions/{id}
                     const std::string& sessionId);
  void signOutEverywhere(const drogon::HttpRequestPtr& req, HttpCallback&& callback);  // DELETE /v1/sessions

private:
  bool allowAppleMutation(const drogon::HttpRequestPtr& req, HttpCallback& callback, bool jsonBody = true);
  void respondSignedIn(const AuthService::SignedIn& signedIn, const std::string& forkSource,
                       HttpCallback& callback, bool bearerSession, bool appleAttached = false);

  std::shared_ptr<AuthService> auth_;
  std::shared_ptr<SignupFork> signupFork_;  // null on a deploy with no forkable product — both fork steps no-op
  bool secureCookies_;
  SessionCookieScopes cookieScopes_;
  std::shared_ptr<GoogleOAuthClient> google_;  // null when Google sign-in is unconfigured
  std::string appUrl_;                         // where the Google callback lands the browser
  std::shared_ptr<AppleOAuthClient> apple_;    // null when Apple sign-in is unconfigured
  std::shared_ptr<AppleIdentityVerifier> appleNative_;
  std::set<std::string> allowedOrigins_;
};

}

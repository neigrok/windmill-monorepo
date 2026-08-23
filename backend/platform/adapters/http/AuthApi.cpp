#include "platform/adapters/http/AuthApi.h"

#include "platform/adapters/http/JsonReply.h"
#include "platform/adapters/http/RateLimiter.h"  // clientIp

#include <drogon/Cookie.h>

#include <openssl/rand.h>

#include <ctime>

namespace wm {

namespace {
// The session secret behind a request: the HttpOnly cookie, or a Bearer token.
std::string sessionSecret(const drogon::HttpRequestPtr& req) {
  std::string secret = req->getCookie("wm_session");
  if (secret.empty()) {
    const std::string authorization = req->getHeader("authorization");
    if (authorization.rfind("Bearer ", 0) == 0) secret = authorization.substr(7);
  }
  return secret;
}

SessionContext contextOf(const drogon::HttpRequestPtr& req) {
  return SessionContext{req->getHeader("user-agent"), clientIp(req)};
}

Json::Value userJson(const User& user) {
  Json::Value out(Json::objectValue);
  out["id"] = user.id.str();
  out["email"] = user.email.value;
  out["name"] = user.name;
  return out;
}

void setSessionCookie(const drogon::HttpResponsePtr& response, const std::string& secret, bool secure,
                      const std::string& domain) {
  drogon::Cookie cookie("wm_session", secret);
  cookie.setHttpOnly(true);
  cookie.setPath("/");
  cookie.setSameSite(drogon::Cookie::SameSite::kLax);
  if (secure) cookie.setSecure(true);
  if (!domain.empty()) cookie.setDomain(domain);
  cookie.setMaxAge(7776000);  // 90 days
  response->addCookie(std::move(cookie));
}

void clearSessionCookie(const drogon::HttpResponsePtr& response, bool secure, const std::string& domain) {
  drogon::Cookie cookie("wm_session", "");
  cookie.setHttpOnly(true);
  cookie.setPath("/");
  cookie.setSameSite(drogon::Cookie::SameSite::kLax);
  if (secure) cookie.setSecure(true);
  if (!domain.empty()) cookie.setDomain(domain);
  cookie.setMaxAge(0);
  response->addCookie(std::move(cookie));
}

// Expires ONLY wm_oauth_state — never wm_session, so a bounced callback can't log a signed-in user out.
void expireStateCookie(const drogon::HttpResponsePtr& response, const std::string& domain) {
  drogon::Cookie cookie("wm_oauth_state", "");
  cookie.setPath("/");
  if (!domain.empty()) cookie.setDomain(domain);
  cookie.setMaxAge(0);
  response->addCookie(std::move(cookie));
}

// The OAuth `state` CSRF nonce, echoed in the authorize URL and stashed in a cookie; empty on an entropy failure.
std::string randomState() {
  unsigned char buf[16];
  if (RAND_bytes(buf, sizeof(buf)) != 1) return "";
  static const char* hex = "0123456789abcdef";
  std::string out;
  out.reserve(sizeof(buf) * 2);
  for (unsigned char b : buf) {
    out.push_back(hex[b >> 4]);
    out.push_back(hex[b & 0x0F]);
  }
  return out;
}

std::string isoUtc(UnixMs ms) {
  const std::time_t secs = static_cast<std::time_t>(ms / 1000);
  std::tm tm{};
  gmtime_r(&secs, &tm);
  char buffer[32];
  std::strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &tm);
  return buffer;
}
}

AuthApi::AuthApi(std::shared_ptr<AuthService> auth, std::shared_ptr<SignupFork> signupFork, bool secureCookies,
                 std::string cookieDomain, std::shared_ptr<GoogleOAuthClient> google, std::string appUrl,
                 std::shared_ptr<AppleOAuthClient> apple)
    : auth_(std::move(auth)), signupFork_(std::move(signupFork)), secureCookies_(secureCookies),
      cookieDomain_(std::move(cookieDomain)), google_(std::move(google)), appUrl_(std::move(appUrl)),
      apple_(std::move(apple)) {}

void AuthApi::requestLink(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  std::string email = json ? json->get("email", "").asString() : "";
  if (email.empty()) {
    Json::Value body(Json::objectValue);
    body["error"] = "That address looks unfinished — check the ending.";
    body["code"] = "invalid_email";
    callback(jsonResponse(body, drogon::k400BadRequest));
    return;
  }

  std::string forkOf = json ? json->get("forkOf", "").asString() : "";
  if (forkOf.size() > 64) forkOf.clear();  // an id, not a payload — drop junk quietly

  // door "app" mails the row's 6-digit code instead of the link; anything else mails the link.
  const std::string door = json ? json->get("door", "").asString() : "";

  // A source we can't read stays undescribed: the mail falls back to the plain template.
  std::optional<ForkDescription> forkDescription;
  if (!forkOf.empty() && signupFork_) forkDescription = signupFork_->describe(forkOf);

  // The send is async: the verdict rides back through the callback, freeing the handler thread.
  auth_->requestLink(email, forkOf, forkDescription, door,
                     [callback = std::move(callback)](AuthService::RequestResult result) {
    if (result == AuthService::RequestResult::sent) {
      Json::Value body(Json::objectValue);
      body["status"] = "sent";
      callback(jsonResponse(body));
      return;
    }
    if (result == AuthService::RequestResult::invalidEmail) {
      Json::Value body(Json::objectValue);
      body["error"] = "That address looks unfinished — check the ending.";
      body["code"] = "invalid_email";
      callback(jsonResponse(body, drogon::k400BadRequest));
      return;
    }
    if (result == AuthService::RequestResult::rateLimited) {
      Json::Value body(Json::objectValue);
      body["error"] = "That's a few links in a row. Check your spam folder first — or try again in 10 minutes.";
      body["code"] = "rate_limited";
      callback(jsonResponse(body, drogon::k429TooManyRequests));
      return;
    }
    Json::Value body(Json::objectValue);
    body["error"] = "Can't reach windmill.works";
    body["detail"] = "Nothing you've written is lost.";
    body["code"] = "unreachable";
    callback(jsonResponse(body, drogon::k502BadGateway));
  });
}

void AuthApi::verify(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  std::string token = json ? json->get("token", "").asString() : "";
  if (token.empty()) {
    Json::Value body(Json::objectValue);
    body["error"] = "Missing token";
    body["code"] = "bad_request";
    callback(jsonResponse(body, drogon::k400BadRequest));
    return;
  }

  AuthService::Completion completion = auth_->completeLink(token, contextOf(req));
  if (completion.verdict != LinkVerdict::valid) {
    Json::Value body(Json::objectValue);
    body["error"] = "That link has expired";
    body["detail"] = "Links work once and last 15 minutes.";
    body["code"] = "expired";
    callback(jsonResponse(body, drogon::k410Gone));
    return;
  }
  respondSignedIn(*completion.signedIn, completion.forkSource, callback);
}

void AuthApi::verifyCode(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  const std::string email = json ? json->get("email", "").asString() : "";
  const std::string code = json ? json->get("code", "").asString() : "";
  if (email.empty() || code.empty()) {
    Json::Value body(Json::objectValue);
    body["error"] = "Missing code";
    body["code"] = "bad_request";
    callback(jsonResponse(body, drogon::k400BadRequest));
    return;
  }

  AuthService::CodeCompletion completion = auth_->completeCode(email, code, contextOf(req));
  if (completion.verdict != CodeVerdict::valid) {
    // Every failure answers one identical brick, so this endpoint is never an oracle for which
    // addresses hold pending codes or accounts.
    Json::Value body(Json::objectValue);
    body["error"] = "That code has expired";
    body["detail"] = "Codes work once and last 15 minutes.";
    body["code"] = "expired";
    callback(jsonResponse(body, drogon::k410Gone));
    return;
  }
  respondSignedIn(*completion.signedIn, completion.forkSource, callback);
}

void AuthApi::respondSignedIn(const AuthService::SignedIn& signedIn, const std::string& forkSource,
                              HttpCallback& callback) {
  Json::Value body(Json::objectValue);
  body["user"] = userJson(signedIn.user);

  // A failed plant degrades to a plain sign-in — the fork never blocks the door — and the port owns the logging.
  if (!forkSource.empty() && signupFork_) {
    if (std::optional<std::string> planted = signupFork_->plant(forkSource, signedIn.user.id))
      body["forkedTree"] = *planted;
  }

  // The session secret rides only in the cookie here, never the body.
  auto response = jsonResponse(body);
  setSessionCookie(response, signedIn.sessionSecret, secureCookies_, cookieDomain_);
  callback(response);
}

// Google door one: mint a CSRF state, stash it in a short-lived HttpOnly cookie, 302 to consent.
void AuthApi::googleStart(const drogon::HttpRequestPtr&, HttpCallback&& callback) {
  const std::string state = (google_ && google_->configured()) ? randomState() : "";
  if (state.empty()) {  // unconfigured, or an entropy failure — bounce rather than start a broken flow
    callback(drogon::HttpResponse::newRedirectionResponse(appUrl_ + "/#/"));
    return;
  }
  auto response = drogon::HttpResponse::newRedirectionResponse(google_->authorizeUrl(state));

  drogon::Cookie stateCookie("wm_oauth_state", state);
  stateCookie.setHttpOnly(true);
  stateCookie.setPath("/");
  stateCookie.setSameSite(drogon::Cookie::SameSite::kLax);  // Lax rides the top-level callback nav back
  if (secureCookies_) stateCookie.setSecure(true);
  if (!cookieDomain_.empty()) stateCookie.setDomain(cookieDomain_);
  stateCookie.setMaxAge(600);  // 10 minutes to complete the consent
  response->addCookie(std::move(stateCookie));
  callback(response);
}

// Google door two: validate the state against the cookie, exchange the code, mint a session.
// Any failure lands unauthenticated — the user simply isn't signed in and can retry.
void AuthApi::googleCallback(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  // A bounce expires only the OAuth state cookie — never wm_session.
  auto bounce = [this](const std::string& hash) {
    auto response = drogon::HttpResponse::newRedirectionResponse(appUrl_ + hash);
    expireStateCookie(response, cookieDomain_);
    return response;
  };

  if (!google_ || !google_->configured()) {
    callback(drogon::HttpResponse::newRedirectionResponse(appUrl_ + "/#/"));
    return;
  }
  const std::string code = req->getParameter("code");
  const std::string state = req->getParameter("state");
  const std::string cookieState = req->getCookie("wm_oauth_state");
  if (code.empty() || state.empty() || cookieState.empty() || state != cookieState) {
    callback(bounce("/#/?signin=google_failed"));
    return;
  }

  const SessionContext ctx = contextOf(req);
  google_->exchangeCode(
      code, [auth = auth_, secure = secureCookies_, domain = cookieDomain_, appUrl = appUrl_,
             callback = std::move(callback), ctx](std::optional<ProviderIdentity> identity) mutable {
        const std::optional<AuthService::ProviderSignIn> signIn =
            identity ? auth->completeProvider(*identity, ctx) : std::nullopt;
        if (!signIn) {
          auto response = drogon::HttpResponse::newRedirectionResponse(appUrl + "/#/?signin=google_failed");
          expireStateCookie(response, domain);
          callback(response);
          return;
        }
        auto response = drogon::HttpResponse::newRedirectionResponse(appUrl + "/#/");
        setSessionCookie(response, signIn->signedIn.sessionSecret, secure, domain);
        expireStateCookie(response, domain);
        callback(response);
      });
}

// Apple's native door: the app posts { authorizationCode, name? } and the session comes back as JSON
// for the Keychain (the cookie is set too). The caller's session is read BEFORE the exchange: a
// provider sign-in taken while already signed in ATTACHES the door to that account, never resolves one.
void AuthApi::apple(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  if (!apple_ || !apple_->configured()) {
    callback(error(drogon::k404NotFound, "apple sign-in is not configured"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  const std::string code = json ? json->get("authorizationCode", "").asString() : "";
  if (code.empty()) {
    callback(error(drogon::k400BadRequest, "missing authorization code"));
    return;
  }
  // Apple sends the name only on the first authorization ever: it seeds a NEW account and is
  // never allowed to overwrite the name on an existing one.
  std::string name = json ? json->get("name", "").asString() : "";
  if (name.size() > 200) name.clear();

  const SessionContext ctx = contextOf(req);
  const std::optional<User> caller = auth_->authenticate(sessionSecret(req), ctx);

  apple_->exchangeCode(
      code, [auth = auth_, secure = secureCookies_, domain = cookieDomain_, name, caller, ctx,
             callback = std::move(callback)](std::optional<ProviderIdentity> identity) mutable {
        if (!identity) {
          callback(error(drogon::k401Unauthorized, "apple sign-in could not be completed"));
          return;
        }
        identity->name = name;

        if (caller) {
          const AuthService::AttachOutcome outcome = auth->attachIdentity(caller->id, *identity);
          if (outcome == AuthService::AttachOutcome::takenByAnother) {
            callback(error(drogon::k409Conflict, "that Apple ID already opens another account",
                           "identity-taken"));
            return;
          }
          if (outcome == AuthService::AttachOutcome::refused) {
            callback(error(drogon::k401Unauthorized, "apple sign-in could not be completed"));
            return;
          }
          Json::Value body(Json::objectValue);
          body["user"] = userJson(*caller);
          body["attached"] = true;
          callback(jsonResponse(body));
          return;
        }

        const std::optional<AuthService::ProviderSignIn> signIn = auth->completeProvider(*identity, ctx);
        if (!signIn) {
          callback(error(drogon::k401Unauthorized, "apple sign-in could not be completed"));
          return;
        }
        Json::Value body(Json::objectValue);
        body["user"] = userJson(signIn->signedIn.user);
        body["session"] = signIn->signedIn.sessionSecret;  // the app's Bearer credential
        body["created"] = signIn->created;
        // A relay address can never find the account this human has on the web; the client owns the decision.
        body["privateEmail"] = signIn->privateEmail;
        auto response = jsonResponse(body);
        setSessionCookie(response, signIn->signedIn.sessionSecret, secure, domain);
        callback(response);
      });
}

// The link door: the caller's account folds into the one this magic link names, carrying its
// provider doors with it. Refused unless the caller's account is empty.
void AuthApi::link(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  const SessionContext ctx = contextOf(req);
  const std::optional<User> caller = auth_->authenticate(sessionSecret(req), ctx);
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to link this account"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  const std::string token = json ? json->get("token", "").asString() : "";
  if (token.empty()) {
    callback(error(drogon::k400BadRequest, "missing token"));
    return;
  }

  const AuthService::LinkResult result = auth_->linkAccount(caller->id, token, ctx);
  if (result.outcome == AuthService::LinkOutcome::badLink) {
    Json::Value body(Json::objectValue);
    body["error"] = "That link has expired";
    body["detail"] = "Links work once and last 15 minutes.";
    body["code"] = "expired";
    callback(jsonResponse(body, drogon::k410Gone));
    return;
  }
  if (result.outcome == AuthService::LinkOutcome::notEmpty) {
    callback(error(drogon::k409Conflict, "this account already holds data of its own",
                   "account-not-empty"));
    return;
  }
  if (result.outcome == AuthService::LinkOutcome::sameAccount) {
    Json::Value body(Json::objectValue);
    body["user"] = userJson(*caller);
    body["linked"] = false;  // already one account; the link was spent proving it
    callback(jsonResponse(body));
    return;
  }

  const AuthService::SignedIn& signedIn = *result.signedIn;
  Json::Value body(Json::objectValue);
  body["user"] = userJson(signedIn.user);
  body["session"] = signedIn.sessionSecret;  // the caller's own row is gone, and its session with it
  body["linked"] = true;
  auto response = jsonResponse(body);
  setSessionCookie(response, signedIn.sessionSecret, secureCookies_, cookieDomain_);
  callback(response);
}

void AuthApi::me(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  std::optional<User> user = auth_->authenticate(sessionSecret(req), contextOf(req));
  if (!user) {
    callback(jsonResponse(Json::Value(Json::objectValue), drogon::k401Unauthorized));
    return;
  }
  Json::Value body(Json::objectValue);
  body["user"] = userJson(*user);
  callback(jsonResponse(body));
}

void AuthApi::logout(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  auth_->signOut(sessionSecret(req));

  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  clearSessionCookie(response, secureCookies_, cookieDomain_);
  callback(response);
}

void AuthApi::patchMe(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  const std::string secret = sessionSecret(req);
  std::optional<User> caller = auth_->authenticate(secret, contextOf(req));
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to edit your profile"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  const std::string name = json ? json->get("name", "").asString() : "";

  std::optional<User> updated = auth_->updateName(caller->id, name);
  if (!updated) {
    callback(error(drogon::k400BadRequest, "That name's blank, or too long — 80 characters at most."));
    return;
  }
  Json::Value body(Json::objectValue);
  body["user"] = userJson(*updated);
  callback(jsonResponse(body));
}

void AuthApi::deleteMe(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  // Soft-close with a 30-day grace; every session and grant is signed out.
  const std::string secret = sessionSecret(req);
  std::optional<User> caller = auth_->authenticate(secret, contextOf(req));
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to close your account"));
    return;
  }
  const UnixMs closesMs = auth_->closeAccount(caller->id);

  Json::Value body(Json::objectValue);
  body["closesMs"] = static_cast<Json::Int64>(closesMs);
  body["closingOn"] = isoUtc(closesMs);
  auto response = jsonResponse(body);
  clearSessionCookie(response, secureCookies_, cookieDomain_);  // this device's session is gone too
  callback(response);
}

void AuthApi::listSessions(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  const std::string secret = sessionSecret(req);
  std::optional<User> caller = auth_->authenticate(secret, contextOf(req));
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to see your devices"));
    return;
  }
  Json::Value list(Json::arrayValue);
  for (const SessionView& view : auth_->listSessions(caller->id, secret)) {
    Json::Value row(Json::objectValue);
    row["id"] = view.id;
    row["userAgent"] = view.userAgent;
    row["lastSeenMs"] = static_cast<Json::Int64>(view.lastSeenMs);
    row["createdMs"] = static_cast<Json::Int64>(view.createdMs);
    row["ip"] = view.ip;
    row["current"] = view.current;
    list.append(row);
  }
  Json::Value body(Json::objectValue);
  body["sessions"] = list;
  callback(jsonResponse(body));
}

void AuthApi::revokeSession(const drogon::HttpRequestPtr& req, HttpCallback&& callback,
                            const std::string& sessionId) {
  // Revoking the current session also clears this cookie.
  const std::string secret = sessionSecret(req);
  std::optional<User> caller = auth_->authenticate(secret, contextOf(req));
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to revoke a device"));
    return;
  }
  const AuthService::RevokeOutcome outcome = auth_->revokeSession(caller->id, sessionId, secret);
  if (outcome == AuthService::RevokeOutcome::notFound) {
    callback(error(drogon::k404NotFound, "no such session"));
    return;
  }
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  if (outcome == AuthService::RevokeOutcome::revokedCurrent)
    clearSessionCookie(response, secureCookies_, cookieDomain_);
  callback(response);
}

void AuthApi::signOutEverywhere(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  // Every other device; the caller's own session is left alive.
  const std::string secret = sessionSecret(req);
  std::optional<User> caller = auth_->authenticate(secret, contextOf(req));
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to sign out your other devices"));
    return;
  }
  auth_->signOutEverywhere(caller->id, secret);

  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  callback(response);
}

}

#include "platform/adapters/http/AuthApi.h"

#include "platform/adapters/http/JsonReply.h"
#include "platform/adapters/http/RateLimiter.h"  // clientIp

#include <drogon/Cookie.h>

#include <openssl/rand.h>

#include <ctime>

namespace wm {

namespace {
// The session secret behind a request: the HttpOnly cookie, or a Bearer token for API/test
// callers. One reader shared by every account endpoint (me, logout, patch, delete, sessions).
std::string sessionSecret(const drogon::HttpRequestPtr& req) {
  std::string secret = req->getCookie("wm_session");
  if (secret.empty()) {
    const std::string authorization = req->getHeader("authorization");
    if (authorization.rfind("Bearer ", 0) == 0) secret = authorization.substr(7);
  }
  return secret;
}

// What the request says about the device, threaded onto the session for the §5 list.
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

// Set the wm_session cookie — the single place its attributes live, shared by the magic-link
// verify and the Google callback so the two doors mint a byte-identical session cookie.
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

// Expire the wm_session cookie, matching the flags it was set with — used on logout, on a
// close, and when a caller revokes the very session they are calling from.
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

// Expire the short-lived OAuth `state` cookie once a Google round trip ends (success or failure).
// It touches ONLY wm_oauth_state — never wm_session — so a bounced callback can't log a signed-in
// user out (a forced-logout CSRF: a failed /callback must not clear the session it never minted).
void expireStateCookie(const drogon::HttpResponsePtr& response, const std::string& domain) {
  drogon::Cookie cookie("wm_oauth_state", "");
  cookie.setPath("/");
  if (!domain.empty()) cookie.setDomain(domain);
  cookie.setMaxAge(0);
  response->addCookie(std::move(cookie));
}

// An unguessable OAuth `state` nonce (CSRF): echoed in the authorize URL and stashed in an HttpOnly
// cookie, the callback accepts the code only when the two match. Empty on the (near-impossible)
// entropy failure, which the caller treats as "can't start the flow".
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

// A UnixMs as an ISO 8601 UTC instant (the §4 close date the client formats for its chip).
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
  // One door in: parse the address, defer the verdict to the service, translate to the doc's copy.
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
  if (forkOf.size() > 64) forkOf.clear();  // a tree id, not a payload — drop junk quietly

  // A fork mail must name the tree it plants, so resolve the source's face here — the auth
  // pipeline stays product-free, asking the injected port rather than any tree type. A deploy with
  // no forkable product injects nothing, and a source we can't read stays undescribed: the mail
  // falls back to the plain template rather than promise a tree it can't name.
  std::optional<AuthService::ForkDescription> forkedTree;
  if (!forkOf.empty() && signupFork_) forkedTree = signupFork_->describe(forkOf);

  // The send is async, so the verdict rides back through the callback — fired inline for
  // invalid / rate-limited, or off the sender's loop once the Resend call settles. The
  // handler thread is freed the instant this returns; the drogon callback carries the reply.
  auth_->requestLink(email, forkOf, forkedTree,
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
    body["detail"] = "Your trees are safe on this device.";
    body["code"] = "unreachable";
    callback(jsonResponse(body, drogon::k502BadGateway));
  });
}

void AuthApi::verify(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  // The link comes back once: resolve it, and on success mint the session cookie.
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

  const AuthService::SignedIn& signedIn = *completion.signedIn;
  Json::Value body(Json::objectValue);
  body["user"] = userJson(signedIn.user);

  // A pending fork rides the link: plant it into the fresh session through the injected port.
  // Failure degrades to a plain sign-in — the fork never blocks the door — and the port owns the
  // logging (the link is already spent, so a dropped fork is unrecoverable and must leave a trace).
  // A deploy with no forkable product injects nothing, so the branch simply falls through.
  if (!completion.forkSource.empty() && signupFork_) {
    if (std::optional<std::string> planted = signupFork_->plant(completion.forkSource, signedIn.user.id))
      body["forkedTree"] = *planted;
  }

  auto response = jsonResponse(body);
  setSessionCookie(response, signedIn.sessionSecret, secureCookies_, cookieDomain_);
  callback(response);
}

// Google sign-in, door one: mint a CSRF state, stash it in a short-lived HttpOnly cookie, and 302
// the browser to Google's consent. Unconfigured (no client id/secret) → bounce to the app, so a
// stray click before the secrets land is a harmless no-op rather than an error page.
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

// Google sign-in, door two: validate the state against the cookie, exchange the code for a verified
// identity, then run the SAME session-mint tail as a magic link (revival + account-linking-by-email)
// and land the browser back in the app with a wm_session cookie. Any failure lands unauthenticated —
// the user simply isn't signed in and can retry — never an error page.
void AuthApi::googleCallback(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  // A bounce only ever expires the OAuth state cookie — it must NEVER clear wm_session, so a failed
  // or forged callback can't force-log-out a signed-in user.
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

// Apple sign-in, the native door: the app has already run ASAuthorizationController and posts
// { authorizationCode, name? }. There is no redirect and no state cookie — the app is the user
// agent, and the session comes back as JSON for the Keychain rather than as a Set-Cookie the app
// would have to keep a jar for (the cookie is still set, so a browser caller works unchanged).
//
// The caller's session is read BEFORE the exchange, because holding one changes what this route
// means: a provider sign-in taken while already signed in ATTACHES the door to that account and
// never resolves one, which is what stops "sign in by link, then tap Apple" from forking the
// account the user is looking at.
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
  // Apple hands the app a name exactly once, on the first authorization ever, so it arrives here or
  // never. It seeds a NEW account and is never allowed to overwrite the name on an existing one.
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
        // The two facts together are the link door's condition, and the client owns the decision:
        // a relay address can never find the account this human has on the web.
        body["privateEmail"] = signIn->privateEmail;
        auto response = jsonResponse(body);
        setSessionCookie(response, signIn->signedIn.sessionSecret, secure, domain);
        callback(response);
      });
}

// The link door: the caller's account folds into the one this magic link names, carrying its
// provider doors with it. Refused unless the caller's account is empty — the merge is a delete of
// nothing, never a reconciliation, which is why no account merger exists to go wrong.
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
  // The session rides in the cookie or a Bearer header; resolve it to a user or refuse.
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
  // Retire the session server-side, then clear the cookie on the way out.
  auth_->signOut(sessionSecret(req));

  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  clearSessionCookie(response, secureCookies_, cookieDomain_);
  callback(response);
}

void AuthApi::patchMe(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  // Settings §5 profile: the only editable identity field is the name.
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
  // Settings §4 close: soft-close with a 30-day grace, every session and grant signed out.
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
  // Settings §5 sessions: the caller's live sessions, their own flagged current.
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
  // Settings §5: revoke one device. Revoking the current one also clears this cookie.
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
  // Settings §5: every other device, the caller's own left alive (so its cookie stands).
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

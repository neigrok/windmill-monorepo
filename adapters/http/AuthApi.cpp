#include "adapters/http/AuthApi.h"

#include "adapters/http/RateLimiter.h"  // clientIp

#include <drogon/Cookie.h>

#include <ctime>

namespace wm {

namespace {
drogon::HttpResponsePtr jsonResponse(const Json::Value& body, drogon::HttpStatusCode code = drogon::k200OK) {
  auto response = drogon::HttpResponse::newHttpJsonResponse(body);
  response->setStatusCode(code);
  return response;
}

drogon::HttpResponsePtr error(drogon::HttpStatusCode code, const std::string& message) {
  Json::Value body(Json::objectValue);
  body["error"] = message;
  return jsonResponse(body, code);
}

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

AuthApi::AuthApi(std::shared_ptr<AuthService> auth, std::shared_ptr<ForkService> fork, bool secureCookies,
                 std::string cookieDomain)
    : auth_(std::move(auth)), fork_(std::move(fork)), secureCookies_(secureCookies),
      cookieDomain_(std::move(cookieDomain)) {}

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
  // pipeline stays tree-free. A source we can't read stays undescribed: the mail falls back
  // to the plain template rather than promise a tree it can't name.
  std::optional<AuthService::ForkDescription> forkedTree;
  if (!forkOf.empty()) {
    if (std::optional<ForkService::Description> source = fork_->describe(TreeId{forkOf}))
      forkedTree = AuthService::ForkDescription{source->title, source->steps};
  }

  AuthService::RequestResult result;
  try {
    result = auth_->requestLink(email, forkOf, forkedTree);
  } catch (const std::exception&) {
    Json::Value body(Json::objectValue);
    body["error"] = "Can't reach windmill.works";
    body["detail"] = "Your trees are safe on this device.";
    body["code"] = "unreachable";
    callback(jsonResponse(body, drogon::k502BadGateway));
    return;
  }

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
  Json::Value body(Json::objectValue);
  body["error"] = "That's a few links in a row. Check your spam folder first — or try again in 10 minutes.";
  body["code"] = "rate_limited";
  callback(jsonResponse(body, drogon::k429TooManyRequests));
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

  // A pending fork rides the link: execute it into the fresh session. Failure degrades to
  // a plain sign-in — the fork never blocks the door — but the link is already spent, so a
  // dropped fork is unrecoverable and must at least leave a trace in the log.
  if (!completion.forkSource.empty()) {
    try {
      ForkService::Result forked = fork_->fork(TreeId{completion.forkSource}, "", "", signedIn.user.id);
      if (forked.outcome == ForkService::Outcome::forked) body["forkedTree"] = forked.data.id.str();
      else LOG_WARN << "pending fork of " << completion.forkSource << " dropped: source missing or id taken";
    } catch (const std::exception& e) {
      LOG_ERROR << "pending fork of " << completion.forkSource << " failed: " << e.what();
    }
  }

  auto response = jsonResponse(body);

  drogon::Cookie cookie("wm_session", signedIn.sessionSecret);
  cookie.setHttpOnly(true);
  cookie.setPath("/");
  cookie.setSameSite(drogon::Cookie::SameSite::kLax);
  if (secureCookies_) cookie.setSecure(true);
  if (!cookieDomain_.empty()) cookie.setDomain(cookieDomain_);
  cookie.setMaxAge(7776000);  // 90 days
  response->addCookie(std::move(cookie));
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

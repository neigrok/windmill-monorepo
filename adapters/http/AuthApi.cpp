#include "adapters/http/AuthApi.h"

#include <drogon/Cookie.h>

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
}

AuthApi::AuthApi(std::shared_ptr<AuthService> auth, bool secureCookies, std::string cookieDomain)
    : auth_(std::move(auth)), secureCookies_(secureCookies), cookieDomain_(std::move(cookieDomain)) {}

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

  AuthService::RequestResult result;
  try {
    result = auth_->requestLink(email);
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

  AuthService::Completion completion = auth_->completeLink(token);
  if (completion.verdict != LinkVerdict::valid) {
    Json::Value body(Json::objectValue);
    body["error"] = "That link has expired";
    body["detail"] = "Links work once and last 15 minutes.";
    body["code"] = "expired";
    callback(jsonResponse(body, drogon::k410Gone));
    return;
  }

  const AuthService::SignedIn& signedIn = *completion.signedIn;
  Json::Value userJson(Json::objectValue);
  userJson["id"] = signedIn.user.id.str();
  userJson["email"] = signedIn.user.email.value;
  userJson["name"] = signedIn.user.name;

  Json::Value body(Json::objectValue);
  body["user"] = userJson;
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
  std::string secret = req->getCookie("wm_session");
  if (secret.empty()) {
    std::string authorization = req->getHeader("authorization");
    if (authorization.rfind("Bearer ", 0) == 0) secret = authorization.substr(7);
  }

  std::optional<User> user = auth_->authenticate(secret);
  if (!user) {
    callback(jsonResponse(Json::Value(Json::objectValue), drogon::k401Unauthorized));
    return;
  }

  Json::Value userJson(Json::objectValue);
  userJson["id"] = user->id.str();
  userJson["email"] = user->email.value;
  userJson["name"] = user->name;
  Json::Value body(Json::objectValue);
  body["user"] = userJson;
  callback(jsonResponse(body));
}

void AuthApi::logout(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  // Retire the session server-side, then clear the cookie on the way out.
  std::string secret = req->getCookie("wm_session");
  if (secret.empty()) {
    std::string authorization = req->getHeader("authorization");
    if (authorization.rfind("Bearer ", 0) == 0) secret = authorization.substr(7);
  }
  auth_->signOut(secret);

  drogon::Cookie cookie("wm_session", "");
  cookie.setHttpOnly(true);
  cookie.setPath("/");
  cookie.setSameSite(drogon::Cookie::SameSite::kLax);
  if (secureCookies_) cookie.setSecure(true);
  if (!cookieDomain_.empty()) cookie.setDomain(cookieDomain_);
  cookie.setMaxAge(0);

  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  response->addCookie(std::move(cookie));
  callback(response);
}

}

#include "adapters/http/OAuthApi.h"

#include <drogon/utils/Utilities.h>

namespace wm {

namespace {
drogon::HttpResponsePtr jsonResponse(const Json::Value& body, drogon::HttpStatusCode code = drogon::k200OK) {
  auto response = drogon::HttpResponse::newHttpJsonResponse(body);
  response->setStatusCode(code);
  return response;
}

// An OAuth error object (RFC 6749 §5.2 shape): {"error", "error_description"}.
drogon::HttpResponsePtr oauthError(const std::string& error, const std::string& description,
                                   drogon::HttpStatusCode code) {
  Json::Value body(Json::objectValue);
  body["error"] = error;
  if (!description.empty()) body["error_description"] = description;
  return jsonResponse(body, code);
}

std::string enc(const std::string& value) { return drogon::utils::urlEncode(value); }

Json::Value strArray(const std::vector<std::string>& items) {
  Json::Value out(Json::arrayValue);
  for (const std::string& item : items) out.append(item);
  return out;
}

drogon::HttpResponsePtr redirect(const std::string& url) {
  return drogon::HttpResponse::newRedirectionResponse(url);
}
}

OAuthApi::OAuthApi(std::shared_ptr<OAuthService> oauth, std::shared_ptr<AuthService> auth,
                   std::string issuerUrl, std::string appBaseUrl, std::string consentPath)
    : oauth_(std::move(oauth)), auth_(std::move(auth)), issuerUrl_(std::move(issuerUrl)),
      appBaseUrl_(std::move(appBaseUrl)), consentPath_(std::move(consentPath)) {}

std::optional<UserId> OAuthApi::callerOf(const drogon::HttpRequestPtr& req) const {
  std::string secret = req->getCookie("wm_session");
  if (secret.empty()) {
    std::string authorization = req->getHeader("authorization");
    if (authorization.rfind("Bearer ", 0) == 0) secret = authorization.substr(7);
  }
  std::optional<User> user = auth_->authenticate(secret);
  if (!user) return std::nullopt;
  return user->id;
}

void OAuthApi::metadata(const drogon::HttpRequestPtr&, HttpCallback&& cb) {
  Json::Value m(Json::objectValue);
  m["issuer"] = issuerUrl_;
  m["authorization_endpoint"] = issuerUrl_ + "/oauth/authorize";
  m["token_endpoint"] = issuerUrl_ + "/oauth/token";
  m["registration_endpoint"] = issuerUrl_ + "/oauth/register";
  m["response_types_supported"] = strArray({"code"});
  m["grant_types_supported"] = strArray({"authorization_code", "refresh_token"});
  m["code_challenge_methods_supported"] = strArray({"S256"});
  m["token_endpoint_auth_methods_supported"] = strArray({"none"});
  cb(jsonResponse(m));
}

void OAuthApi::registerClient(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::shared_ptr<Json::Value> body = req->getJsonObject();
  if (!body) {
    cb(oauthError("invalid_client_metadata", "expected a JSON body", drogon::k400BadRequest));
    return;
  }
  std::vector<std::string> redirectUris;
  for (const Json::Value& uri : (*body)["redirect_uris"])
    if (uri.isString()) redirectUris.push_back(uri.asString());

  std::optional<OAuthClient> client =
      oauth_->registerClient(std::move(redirectUris), body->get("client_name", "").asString());
  if (!client) {
    cb(oauthError("invalid_redirect_uri", "redirect_uris must be non-empty and https or loopback",
                  drogon::k400BadRequest));
    return;
  }

  Json::Value out(Json::objectValue);
  out["client_id"] = client->clientId;
  out["client_name"] = client->name;
  out["redirect_uris"] = strArray(client->redirectUris);
  out["token_endpoint_auth_method"] = "none";
  out["grant_types"] = strArray({"authorization_code", "refresh_token"});
  out["response_types"] = strArray({"code"});
  cb(jsonResponse(out, drogon::k201Created));
}

void OAuthApi::clientInfo(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  // The consent screen fetches the registered client by id so it shows a verified name and
  // redirect, never values a crafted consent link supplied.
  std::optional<OAuthClient> client = oauth_->describeClient(req->getParameter("client_id"));
  if (!client) {
    cb(oauthError("invalid_client", "unknown client", drogon::k404NotFound));
    return;
  }
  Json::Value out(Json::objectValue);
  out["client_id"] = client->clientId;
  out["client_name"] = client->name;
  out["redirect_uris"] = strArray(client->redirectUris);
  cb(jsonResponse(out));
}

void OAuthApi::authorize(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  const std::string clientId = req->getParameter("client_id");
  const std::string redirectUri = req->getParameter("redirect_uri");
  const std::string codeChallenge = req->getParameter("code_challenge");
  const std::string method = req->getParameter("code_challenge_method");
  const std::string responseType = req->getParameter("response_type");
  const std::string resource = req->getParameter("resource");
  const std::string scope = req->getParameter("scope");
  const std::string state = req->getParameter("state");

  const OAuthService::AuthorizeCheck check =
      oauth_->checkAuthorize(clientId, redirectUri, codeChallenge, method);
  if (check.error == OAuthService::AuthorizeError::unknownClient ||
      check.error == OAuthService::AuthorizeError::badRedirect) {
    // The redirect is untrusted, so the error cannot ride it — surface it here.
    auto response = drogon::HttpResponse::newHttpResponse();
    response->setStatusCode(drogon::k400BadRequest);
    response->setBody("invalid client_id or redirect_uri");
    cb(response);
    return;
  }
  if (responseType != "code") {
    cb(redirect(redirectUri + "?error=unsupported_response_type&state=" + enc(state)));
    return;
  }
  if (check.error == OAuthService::AuthorizeError::unsupportedChallenge) {
    cb(redirect(redirectUri + "?error=invalid_request&error_description=" +
                enc("PKCE S256 required") + "&state=" + enc(state)));
    return;
  }

  // Validated: hand the browser to the frontend consent screen with the request. The
  // decision endpoint re-validates client + redirect, so passing them through is safe.
  const std::string url = appBaseUrl_ + consentPath_ + "?client_id=" + enc(clientId) +
                          "&redirect_uri=" + enc(redirectUri) + "&code_challenge=" + enc(codeChallenge) +
                          "&code_challenge_method=S256&resource=" + enc(resource) + "&scope=" + enc(scope) +
                          "&state=" + enc(state);
  cb(redirect(url));
}

void OAuthApi::decision(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req);
  if (!caller) {
    cb(oauthError("login_required", "sign in to authorize", drogon::k401Unauthorized));
    return;
  }
  std::shared_ptr<Json::Value> body = req->getJsonObject();
  if (!body) {
    cb(oauthError("invalid_request", "expected a JSON body", drogon::k400BadRequest));
    return;
  }
  const std::string clientId = body->get("client_id", "").asString();
  const std::string redirectUri = body->get("redirect_uri", "").asString();
  const std::string codeChallenge = body->get("code_challenge", "").asString();
  const std::string resource = body->get("resource", "").asString();
  const std::string scope = body->get("scope", "").asString();
  const std::string state = body->get("state", "").asString();
  const bool approve = body->get("approve", false).asBool();

  if (oauth_->checkAuthorize(clientId, redirectUri, codeChallenge, "S256").error !=
      OAuthService::AuthorizeError::ok) {
    cb(oauthError("invalid_request", "authorization request is no longer valid", drogon::k400BadRequest));
    return;
  }

  Json::Value out(Json::objectValue);
  if (!approve) {
    out["redirect"] = redirectUri + "?error=access_denied&state=" + enc(state);
  } else {
    const std::string code = oauth_->issueCode(clientId, redirectUri, codeChallenge, resource, scope, *caller);
    out["redirect"] = redirectUri + "?code=" + enc(code) + "&state=" + enc(state);
  }
  cb(jsonResponse(out));
}

void OAuthApi::token(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  const std::string grantType = req->getParameter("grant_type");
  const std::string clientId = req->getParameter("client_id");

  OAuthService::TokenResult result;
  if (grantType == "authorization_code") {
    result = oauth_->exchangeCode(req->getParameter("code"), clientId, req->getParameter("redirect_uri"),
                                  req->getParameter("code_verifier"), req->getParameter("resource"));
  } else if (grantType == "refresh_token") {
    result = oauth_->refresh(req->getParameter("refresh_token"), clientId);
  } else {
    cb(oauthError("unsupported_grant_type", "", drogon::k400BadRequest));
    return;
  }

  if (result.error != OAuthService::GrantError::ok || !result.tokens) {
    cb(oauthError("invalid_grant", "", drogon::k400BadRequest));
    return;
  }

  Json::Value out(Json::objectValue);
  out["access_token"] = result.tokens->accessToken;
  out["token_type"] = "Bearer";
  out["expires_in"] = static_cast<Json::Int64>(result.tokens->accessLifetimeMs / 1000);
  out["refresh_token"] = result.tokens->refreshToken;
  auto response = jsonResponse(out);
  response->addHeader("Cache-Control", "no-store");  // token responses are never cached
  cb(response);
}

void OAuthApi::listGrants(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  // Settings §2 connected tools: the caller's grants, separate from their browser sessions.
  std::optional<UserId> caller = callerOf(req);
  if (!caller) {
    cb(oauthError("login_required", "sign in to see your connected tools", drogon::k401Unauthorized));
    return;
  }
  Json::Value list(Json::arrayValue);
  for (const GrantView& grant : oauth_->listGrants(*caller)) {
    Json::Value row(Json::objectValue);
    row["clientId"] = grant.clientId;
    row["name"] = grant.clientName;
    row["grantedMs"] = static_cast<Json::Int64>(grant.grantedMs);
    row["lastUsedMs"] = static_cast<Json::Int64>(grant.lastUsedMs);
    list.append(row);
  }
  Json::Value body(Json::objectValue);
  body["grants"] = list;
  cb(jsonResponse(body));
}

void OAuthApi::disconnectGrant(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                               const std::string& clientId) {
  // Settings §2 disconnect: drop this tool's access immediately; its content is untouched.
  std::optional<UserId> caller = callerOf(req);
  if (!caller) {
    cb(oauthError("login_required", "sign in to disconnect a tool", drogon::k401Unauthorized));
    return;
  }
  oauth_->disconnect(*caller, clientId);  // idempotent — a stale clientId is still a clean 204
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  cb(response);
}

}

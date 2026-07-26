#pragma once

#include "platform/application/AuthService.h"
#include "platform/application/OAuthService.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <optional>
#include <string>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// The OAuth 2.1 authorization server that fronts the MCP resource server (MCP Authorization
// spec). It lives on the API host — reusing the magic-link session for the human consent
// step — and hands the consent screen off to a frontend route, which posts the decision
// back here. Discovery, dynamic client registration, and the token endpoint round it out.
class OAuthApi {
public:
  OAuthApi(std::shared_ptr<OAuthService> oauth, std::shared_ptr<AuthService> auth,
           std::string issuerUrl, std::string appBaseUrl, std::string consentPath);

  void metadata(const drogon::HttpRequestPtr& req, HttpCallback&& cb);        // GET  /.well-known/oauth-authorization-server
  void registerClient(const drogon::HttpRequestPtr& req, HttpCallback&& cb);  // POST /oauth/register
  void clientInfo(const drogon::HttpRequestPtr& req, HttpCallback&& cb);      // GET  /v1/oauth/client — for the consent screen
  void authorize(const drogon::HttpRequestPtr& req, HttpCallback&& cb);       // GET  /oauth/authorize
  void decision(const drogon::HttpRequestPtr& req, HttpCallback&& cb);        // POST /v1/oauth/decision
  void token(const drogon::HttpRequestPtr& req, HttpCallback&& cb);           // POST /oauth/token
  void listGrants(const drogon::HttpRequestPtr& req, HttpCallback&& cb);      // GET    /v1/oauth/grants
  void disconnectGrant(const drogon::HttpRequestPtr& req, HttpCallback&& cb,  // DELETE /v1/oauth/grants/{clientId}
                       const std::string& clientId);

private:
  std::optional<UserId> callerOf(const drogon::HttpRequestPtr& req) const;

  std::shared_ptr<OAuthService> oauth_;
  std::shared_ptr<AuthService> auth_;
  std::string issuerUrl_;    // this AS's public base, e.g. https://api.windmill.works
  std::string appBaseUrl_;   // the app's public base, for the consent redirect
  std::string consentPath_;  // e.g. /#/oauth/authorize
};

}

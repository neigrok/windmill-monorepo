#include "adapters/clock/SystemClock.h"
#include "adapters/crypto/OpenSslTokenGenerator.h"
#include "adapters/email/ResendEmailSender.h"
#include "adapters/http/AuthApi.h"
#include "adapters/http/HttpApi.h"
#include "adapters/http/OAuthApi.h"
#include "adapters/http/RateLimiter.h"
#include "adapters/postgres/PgAuthRepository.h"
#include "adapters/postgres/PgOAuthRepository.h"
#include "adapters/postgres/PgOpLog.h"
#include "adapters/postgres/PgProgressRepository.h"
#include "adapters/postgres/PgTreeRepository.h"
#include "adapters/ws/Collab.h"
#include "adapters/ws/PresenceHub.h"
#include "adapters/ws/TreeSocket.h"
#include "adapters/ws/WsPresenceBus.h"
#include "application/AuthService.h"
#include "application/OAuthService.h"
#include "application/ProgressService.h"
#include "application/RoomRegistry.h"
#include "application/UndoService.h"

#include <drogon/drogon.h>

#include <cstdlib>
#include <memory>
#include <set>
#include <string>

int main() {
  using namespace wm;

  const char* url = std::getenv("DATABASE_URL");
  std::string connString = url ? url : "postgresql://localhost/windmill";
  const Hlc genesis{1, 0, "genesis"};

  auto trees = std::make_shared<PgTreeRepository>(connString);
  auto progress = std::make_shared<PgProgressRepository>(connString);
  auto progressService = std::make_shared<ProgressService>(*progress);

  // Rooms are the authority; HTTP reads and socket edits both go through them (Phase 2).
  auto oplog = std::make_shared<PgOpLog>(connString);
  auto bus = std::make_shared<WsPresenceBus>();
  auto registry = std::make_shared<RoomRegistry>(*trees, *oplog, *bus);
  auto undos = std::make_shared<UndoService>();
  auto presence = std::make_shared<PresenceHub>();

  // Passwordless auth (guidelines/auth.md). The magic link points at the app; the session
  // rides in an HttpOnly cookie whose Secure flag and Domain follow the deployment. The
  // service is built first because the socket and the REST API both resolve callers with it.
  const char* appUrlEnv = std::getenv("WINDMILL_APP_URL");
  std::string appBaseUrl = appUrlEnv ? appUrlEnv : "http://localhost:5183";
  const char* resendKey = std::getenv("RESEND_API_KEY");
  const char* resendFrom = std::getenv("RESEND_FROM");
  const char* cookieDomainEnv = std::getenv("WINDMILL_COOKIE_DOMAIN");
  std::string cookieDomain = cookieDomainEnv ? cookieDomainEnv : "";
  bool secureCookies = appBaseUrl.rfind("https://", 0) == 0;

  auto authRepo = std::make_shared<PgAuthRepository>(connString);
  auto emailSender = std::make_shared<ResendEmailSender>(
      resendKey ? resendKey : "", resendFrom ? resendFrom : "Windmill <login@windmill.works>");
  auto tokens = std::make_shared<OpenSslTokenGenerator>();
  auto systemClock = std::make_shared<SystemClock>();
  auto authService = std::make_shared<AuthService>(*authRepo, *emailSender, *tokens, *systemClock, appBaseUrl);
  auto authApi = std::make_shared<AuthApi>(authService, secureCookies, cookieDomain);

  // OAuth 2.1 authorization server for the MCP resource server. This API host is the issuer;
  // the consent screen is a frontend route the /authorize redirect hands off to.
  const char* apiUrlEnv = std::getenv("WINDMILL_API_URL");
  std::string apiBaseUrl = apiUrlEnv ? apiUrlEnv : "http://localhost:8088";
  auto oauthRepo = std::make_shared<PgOAuthRepository>(connString);
  auto oauthService = std::make_shared<OAuthService>(*oauthRepo, *tokens, *systemClock);
  auto oauthApi = std::make_shared<OAuthApi>(oauthService, authService, apiBaseUrl, appBaseUrl, "/#/oauth/authorize");

  // The socket authenticates each connection at its upgrade and writes progress as that
  // user; anonymous connections may view but not edit.
  setCollab(std::make_shared<Collab>(*registry, *oplog, *bus, *undos, *progressService, *authService, *presence));
  linkTreeSocket();

  auto api = std::make_shared<HttpApi>(registry, trees, progress, oplog, genesis, authService);

  // The origins allowed to send credentialed (cookie-bearing) requests. The app itself is
  // always trusted; WINDMILL_ALLOWED_ORIGINS adds more, comma-separated. Anything else gets
  // no CORS grant, so a hostile page cannot drive /v1/auth/verify with the victim's cookies.
  std::set<std::string> allowedOrigins;
  std::string appOrigin = appBaseUrl;
  while (!appOrigin.empty() && appOrigin.back() == '/') appOrigin.pop_back();
  allowedOrigins.insert(appOrigin);
  if (const char* extra = std::getenv("WINDMILL_ALLOWED_ORIGINS")) {
    std::string list = extra;
    std::size_t start = 0;
    while (start <= list.size()) {
      std::size_t comma = list.find(',', start);
      std::string origin = list.substr(start, comma - start);
      while (!origin.empty() && (origin.front() == ' ' || origin.back() == ' ' || origin.back() == '/')) {
        if (origin.front() == ' ') origin.erase(0, 1);
        else origin.pop_back();
      }
      if (!origin.empty()) allowedOrigins.insert(origin);
      if (comma == std::string::npos) break;
      start = comma + 1;
    }
  }

  auto& app = drogon::app();

  // One CORS policy for every response the server mints early. The session cookie is credentialed,
  // so Allow-Credentials only ever rides an allow-listed Origin — never a reflect-any-origin, which
  // would let a hostile page drive a credentialed /v1/auth/verify with the victim's cookies.
  // Unlisted origins get no grant, so the browser drops their cross-site reads.
  auto writeCors = [allowedOrigins](const drogon::HttpRequestPtr& req, const drogon::HttpResponsePtr& resp) {
    const std::string& origin = req->getHeader("origin");
    if (!origin.empty() && allowedOrigins.count(origin)) {
      resp->addHeader("Access-Control-Allow-Origin", origin);
      resp->addHeader("Access-Control-Allow-Credentials", "true");
    }
    resp->addHeader("Vary", "Origin");
  };

  // CORS preflight, answered at the sync join point — the earliest hook, ahead of routing and of
  // Drogon's built-in "is OPTIONS? -> 200" responder (which would otherwise reply first, reflecting
  // any origin and advertising only OPTIONS in Allow-Methods, so the browser refuses the real POST).
  // It must be a *sync* advice: only that hook short-circuits on its return value. A pre-routing
  // lambda of this shape binds to the void(req) observer overload instead, so its response is dropped.
  app.registerSyncAdvice([writeCors](const drogon::HttpRequestPtr& req) -> drogon::HttpResponsePtr {
    if (req->method() != drogon::Options) return nullptr;  // real requests are dressed on the way out
    auto resp = drogon::HttpResponse::newHttpResponse();
    resp->setStatusCode(drogon::k204NoContent);
    writeCors(req, resp);
    resp->addHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
    resp->addHeader("Access-Control-Allow-Headers", "content-type, authorization");
    resp->addHeader("Access-Control-Max-Age", "600");
    return resp;
  });

  // Abuse ceilings, enforced at the sync join point so the 429 actually short-circuits — a
  // pre-routing advice returning a response binds to the observer overload and is dropped (see
  // CORS above). The limiter keys on the real client IP Caddy records in X-Forwarded-For;
  // internal traffic (health checks, no XFF) is never limited. The magic-link path additionally
  // rides a tight per-client bucket and a global send ceiling that protects the Resend quota.
  auto apiLimiter = std::make_shared<RateLimiter>(25.0, 50.0);          // ~25 req/s/client, burst 50
  auto magicPerIp = std::make_shared<RateLimiter>(10.0 / 600.0, 10.0);  // ~10 links / 10 min / client
  auto magicGlobal = std::make_shared<RateLimiter>(0.5, 60.0);          // global email send ceiling
  app.registerSyncAdvice(
      [apiLimiter, magicPerIp, magicGlobal, writeCors](const drogon::HttpRequestPtr& req) -> drogon::HttpResponsePtr {
        if (req->method() == drogon::Options) return nullptr;  // preflight already answered above
        const std::string ip = clientIp(req);
        if (ip.empty()) return nullptr;  // internal / health-check traffic
        bool ok = apiLimiter->allow(ip);
        if (ok && req->path() == "/v1/auth/magic-link")
          ok = magicGlobal->allow("global") && magicPerIp->allow(ip);
        if (ok) return nullptr;
        Json::Value body(Json::objectValue);
        body["error"] = "rate limited";
        body["code"] = "rate_limited";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(body);
        resp->setStatusCode(drogon::k429TooManyRequests);
        writeCors(req, resp);  // short-circuits post-handling, so dress the 429 for CORS here
        return resp;
      });

  // Presence coalescing: flush buffered cursors/selections to subscribers at 20 Hz (§12),
  // once the event loop is up. One timer drains every tree, latest-wins per actor.
  app.registerBeginningAdvice([presence]() {
    drogon::app().getLoop()->runEvery(0.05, [presence]() { presence->flush(); });
  });

  // Real responses carry the credentialed grant on the way out; preflight is answered above at
  // the sync join point, so no per-route OPTIONS handler is needed anywhere.
  app.registerPostHandlingAdvice(
      [writeCors](const drogon::HttpRequestPtr& req, const drogon::HttpResponsePtr& resp) { writeCors(req, resp); });

  app.registerHandler(
      "/v1/auth/magic-link",
      [authApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        authApi->requestLink(req, std::move(cb));
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/auth/verify",
      [authApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        authApi->verify(req, std::move(cb));
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/auth/logout",
      [authApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        authApi->logout(req, std::move(cb));
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/me",
      [authApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { authApi->me(req, std::move(cb)); },
      {drogon::Get});

  // OAuth authorization server. Discovery/register/authorize/token are driven by the MCP client;
  // the consent-facing endpoints (client info + decision) are called by the app, and their
  // preflight is covered by the shared CORS policy above.
  app.registerHandler(
      "/.well-known/oauth-authorization-server",
      [oauthApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { oauthApi->metadata(req, std::move(cb)); },
      {drogon::Get});
  app.registerHandler(
      "/oauth/register",
      [oauthApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { oauthApi->registerClient(req, std::move(cb)); },
      {drogon::Post});
  app.registerHandler(
      "/oauth/authorize",
      [oauthApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { oauthApi->authorize(req, std::move(cb)); },
      {drogon::Get});
  app.registerHandler(
      "/oauth/token",
      [oauthApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { oauthApi->token(req, std::move(cb)); },
      {drogon::Post});
  app.registerHandler(
      "/v1/oauth/client",
      [oauthApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { oauthApi->clientInfo(req, std::move(cb)); },
      {drogon::Get});
  app.registerHandler(
      "/v1/oauth/decision",
      [oauthApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { oauthApi->decision(req, std::move(cb)); },
      {drogon::Post});

  app.registerHandler(
      "/v1/trees/{id}",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->getTree(req, std::move(cb), id);
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/trees/{id}",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->putTree(req, std::move(cb), id);
      },
      {drogon::Put});
  app.registerHandler(
      "/v1/trees/{id}/fork",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->forkTree(req, std::move(cb), id);
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/trees/{id}/progress",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->getProgress(req, std::move(cb), id);
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/trees/{id}/diagnostics",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->getDiagnostics(req, std::move(cb), id);
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/trees/{id}/activity",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->getActivity(req, std::move(cb), id);
      },
      {drogon::Get});

  const char* portEnv = std::getenv("PORT");
  int port = portEnv ? std::atoi(portEnv) : 8080;
  LOG_INFO << "windmill-backend listening on :" << port;
  app.setClientMaxBodySize(8 * 1024 * 1024);         // backstop cap; a full PUT document can be large
  app.setClientMaxMemoryBodySize(1 * 1024 * 1024);
  app.setMaxConnectionNum(20000);                    // global socket ceiling (all arrive via Caddy)
  app.addListener("0.0.0.0", port).setThreadNum(4).run();
  return 0;
}

#include "adapters/amplitude/AmplitudeClient.h"
#include "adapters/clock/SystemClock.h"
#include "adapters/google/GoogleOAuthClient.h"
#include "adapters/paddle/BillingApi.h"
#include "adapters/crypto/OpenSslTokenGenerator.h"
#include "adapters/email/ResendEmailSender.h"
#include "adapters/sentry/SentryClient.h"
#include "adapters/http/AuthApi.h"
#include "adapters/http/ComposeApi.h"
#include "adapters/http/EventsApi.h"
#include "adapters/http/FeedbackApi.h"
#include "adapters/http/HttpApi.h"
#include "adapters/http/McpKeyApi.h"
#include "adapters/http/OAuthApi.h"
#include "adapters/http/OgImageApi.h"
#include "adapters/http/RateLimiter.h"
#include "adapters/http/SharePageApi.h"
#include "adapters/http/TreeRegistryApi.h"
#include "adapters/llm/AnthropicComposer.h"
#include "adapters/mcp/McpHttpEndpoint.h"
#include "adapters/mcp/McpServer.h"
#include "adapters/mcp/RoadmapTools.h"
#include "adapters/postgres/PgAuthRepository.h"
#include "adapters/postgres/PgEventRepository.h"
#include "adapters/postgres/PgFeedbackRepository.h"
#include "adapters/postgres/PgMcpKeyRepository.h"
#include "adapters/postgres/PgOAuthRepository.h"
#include "adapters/postgres/PgOgImageRepository.h"
#include "adapters/postgres/PgOpLog.h"
#include "adapters/postgres/PgProgressRepository.h"
#include "adapters/postgres/PgServerErrorRepository.h"
#include "adapters/postgres/PgSubscriptionRepository.h"
#include "adapters/postgres/PgTreeRepository.h"
#include "adapters/ws/Collab.h"
#include "adapters/ws/PresenceHub.h"
#include "adapters/ws/TreeSocket.h"
#include "adapters/ws/WsPresenceBus.h"
#include "application/AuthService.h"
#include "application/ForkService.h"
#include "application/McpKeyService.h"
#include "application/OAuthService.h"
#include "application/ProgressService.h"
#include "application/RoomRegistry.h"
#include "application/TreeRegistry.h"

#include <drogon/drogon.h>

#include <algorithm>
#include <cctype>
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

  // OAuth is built first: closing an account (AuthService) delegates tool teardown to it, so
  // the auth service holds a reference to it. This API host is the issuer; the consent screen
  // is a frontend route the /authorize redirect hands off to.
  const char* apiUrlEnv = std::getenv("WINDMILL_API_URL");
  std::string apiBaseUrl = apiUrlEnv ? apiUrlEnv : "http://localhost:8088";
  auto oauthRepo = std::make_shared<PgOAuthRepository>(connString);
  auto oauthService = std::make_shared<OAuthService>(*oauthRepo, *tokens, *systemClock);

  // Personal MCP API keys: the OAuth-less static-token fallback. The same token generator mints
  // and digests them (no prefix — consistent with sessions/oauth), so a leaked digest can neither
  // resurrect a key nor act as one.
  auto mcpKeyRepo = std::make_shared<PgMcpKeyRepository>(connString);
  auto mcpKeyService = std::make_shared<McpKeyService>(*mcpKeyRepo, *tokens, *systemClock);

  auto authService =
      std::make_shared<AuthService>(*authRepo, *emailSender, *tokens, *systemClock, *oauthService, appBaseUrl);
  auto forkService = std::make_shared<ForkService>(*registry, *trees, *tokens);
  // Google sign-in (second door onto wm_session). Empty client id/secret → configured() is false and
  // the routes bounce to the app, so the feature is dark until GOOGLE_CLIENT_ID/SECRET are set. The
  // redirect URI must be registered verbatim in the Google Cloud console.
  const char* googleClientId = std::getenv("GOOGLE_CLIENT_ID");
  const char* googleClientSecret = std::getenv("GOOGLE_CLIENT_SECRET");
  auto googleClient = std::make_shared<GoogleOAuthClient>(googleClientId ? googleClientId : "",
                                                          googleClientSecret ? googleClientSecret : "",
                                                          apiBaseUrl + "/v1/auth/google/callback");
  auto authApi = std::make_shared<AuthApi>(authService, forkService, secureCookies, cookieDomain,
                                           googleClient, appBaseUrl);
  auto mcpKeyApi = std::make_shared<McpKeyApi>(authService, mcpKeyService);
  auto oauthApi = std::make_shared<OAuthApi>(oauthService, authService, apiBaseUrl, appBaseUrl, "/#/oauth/authorize");

  // The socket authenticates each connection at its upgrade and writes progress as that
  // user; anonymous connections may view but not edit.
  setCollab(std::make_shared<Collab>(*registry, *oplog, *bus, *progressService, *authService, *presence, *systemClock));
  linkTreeSocket();

  auto api = std::make_shared<HttpApi>(registry, trees, progress, oplog, genesis, authService, forkService);

  // The real share path (path-share-pages): GET /t/:id serves the SPA shell with a shared
  // tree's own unfurl meta spliced in, so the link unfurls as itself for social scrapers. It
  // reads the built index.html from WINDMILL_WEB_ROOT (the same host dir Caddy serves); a
  // private or absent tree gets the shell verbatim, so it stays indistinguishable from absent.
  const char* webRootEnv = std::getenv("WINDMILL_WEB_ROOT");
  auto sharePageApi = std::make_shared<SharePageApi>(registry, authService, webRootEnv ? webRootEnv : "");

  // Per-tree unfurl cards (og-tree-cards): the owner PUTs their tree's rendered 1200×630 PNG,
  // and GET /og/:id.png serves it (canRead-gated) as the share link's og:image — with the
  // generic card as the fallback whenever a tree has no image or can't be read.
  auto ogImages = std::make_shared<PgOgImageRepository>(connString);
  auto ogImageApi = std::make_shared<OgImageApi>(ogImages, trees, authService);

  // The per-user tree registry (create + list + rename + delete). Reads are repo-direct;
  // rename goes through RoomRegistry so a live room's title stays coherent with the column.
  auto treeRegistry = std::make_shared<TreeRegistry>(*trees, *progress, *tokens, genesis, *registry, *systemClock);
  auto registryApi = std::make_shared<TreeRegistryApi>(treeRegistry, authService);

  // Funnel telemetry (event-spine): ghosts and signed-in users alike beacon here; the
  // general per-IP apiLimiter below covers this route like every other. Accepted events also
  // forward to Amplitude — with the session-resolved user_id — when AMPLITUDE_API_KEY is set.
  // AMPLITUDE_HOST overrides the region (api.eu.amplitude.com for an EU project); default is US.
  const char* amplitudeKey = std::getenv("AMPLITUDE_API_KEY");
  const char* amplitudeHost = std::getenv("AMPLITUDE_HOST");
  auto amplitude = std::make_shared<AmplitudeClient>(
      amplitudeKey ? amplitudeKey : "",
      (amplitudeHost && *amplitudeHost) ? amplitudeHost : "api2.amplitude.com");  // set-but-empty → default
  auto eventRepo = std::make_shared<PgEventRepository>(connString);
  auto eventsApi = std::make_shared<EventsApi>(eventRepo, authService, amplitude);

  // The feedback door: one-click notes from anyone, signed-in or ghost. Same shape as the
  // event-spine — anon-allowed, caller resolved server-side, one row per note.
  auto feedbackRepo = std::make_shared<PgFeedbackRepository>(connString);
  auto feedbackApi = std::make_shared<FeedbackApi>(feedbackRepo, authService);

  // Paddle billing: verified webhooks upsert the local mirror of customers + subscriptions, and the
  // browser reads its own subscription from that mirror. An empty PADDLE_WEBHOOK_SECRET refuses
  // every delivery (they retry), so billing is dark rather than forgeable until the secret lands.
  const char* paddleWebhookSecret = std::getenv("PADDLE_WEBHOOK_SECRET");
  const char* paddleApiKey = std::getenv("PADDLE_API_KEY");
  const char* paddleEnv = std::getenv("PADDLE_ENV");
  const char* paddlePriceId = std::getenv("PADDLE_PRICE_ID");
  auto subscriptionRepo = std::make_shared<PgSubscriptionRepository>(connString);
  auto paddleClient = std::make_shared<PaddleApiClient>(paddleApiKey ? paddleApiKey : "",
                                                        paddleEnv ? paddleEnv : "sandbox");
  auto billingApi = std::make_shared<BillingApi>(*subscriptionRepo, authService, *systemClock,
                                                 paddleWebhookSecret ? paddleWebhookSecret : "",
                                                 paddleClient, paddlePriceId ? paddlePriceId : "");

  // The uncaught-exception safety net: the drogon exception handler (registered below) persists
  // whatever escaped a request handler, so a broken endpoint surfaces in server_errors instead of
  // only in a stdout LOG_ERROR no one can see. It also ships the same exception to Sentry when
  // SENTRY_DSN is set (empty → a no-op client, mirroring the Resend/Anthropic key guards).
  auto serverErrors = std::make_shared<PgServerErrorRepository>(connString);
  const char* sentryDsn = std::getenv("SENTRY_DSN");
  auto sentry = std::make_shared<SentryClient>(sentryDsn ? sentryDsn : "");

  // Paste-import escalation (F3): the model rewrites arbitrary prose into the paste grammar
  // and the client re-parses it deterministically — text in, text out, never a door into the
  // tree. No ANTHROPIC_API_KEY → the route answers 503 and the client hides the handle.
  const char* anthropicKey = std::getenv("ANTHROPIC_API_KEY");
  auto composer = std::make_shared<AnthropicComposer>(anthropicKey ? anthropicKey : "");
  auto composeApi = std::make_shared<ComposeApi>(composer);

  // MCP (Streamable-HTTP) mounted in this same process — the whole point of this change: agent
  // edits run through the very same RoomRegistry as REST and the socket, so a tree has exactly
  // one live room (one head/seq, no cross-process collisions) and every MCP edit fans out to WS
  // subscribers through the shared WsPresenceBus. The resource server validates the OAuth access
  // tokens this host issues, audience-bound to the MCP resource URL (still served under DOMAIN_MCP
  // via Caddy). Defaults keep it working with no extra env: the audience falls back to this host.
  const char* mcpPathEnv = std::getenv("WINDMILL_MCP_PATH");
  const std::string mcpPath = mcpPathEnv ? mcpPathEnv : "/mcp";
  const char* mcpUserEnv = std::getenv("WINDMILL_MCP_USER");
  const UserId mcpFallbackUser{std::string(mcpUserEnv ? mcpUserEnv : "dev")};
  const char* mcpPublicEnv = std::getenv("WINDMILL_MCP_PUBLIC_URL");
  const std::string mcpPublicUrl = mcpPublicEnv ? mcpPublicEnv : apiBaseUrl;
  const std::string mcpResource = mcpPublicUrl + mcpPath;
  const std::string mcpResourceMetadataUrl = mcpPublicUrl + "/.well-known/oauth-protected-resource";
  const char* mcpTokenEnv = std::getenv("WINDMILL_MCP_TOKEN");
  const std::string mcpToken = mcpTokenEnv ? mcpTokenEnv : "";  // shared bearer fallback for CI/agents
  const char* mcpOriginsEnv = std::getenv("WINDMILL_MCP_ALLOWED_ORIGINS");
  const std::set<std::string> mcpOrigins = parseOriginList(mcpOriginsEnv ? mcpOriginsEnv : "");

  auto mcpTools = std::make_shared<RoadmapTools>(*registry, *progressService, *systemClock, *treeRegistry, *bus);
  McpAuth mcpAuth{oauthService.get(), mcpResource,     mcpResourceMetadataUrl,
                  mcpToken,           mcpFallbackUser, mcpKeyService.get()};
  ServerInfo mcpInfo{
      "windmill", "0.1.0",
      "Windmill roadmaps are RPG-style skill trees: nodes are skills/milestones, and a "
      "prerequisite edge points from a required node to the node it unlocks. Use get_tree and "
      "get_diagnostics to inspect, the edit tools (create_node, connect, …) to author, and "
      "set_progress to mark a node active or complete. Edits are never rejected — a cycle or a "
      "detached node is surfaced by get_diagnostics, not refused."};
  auto mcpServer = std::make_shared<McpServer>(*mcpTools, std::move(mcpInfo));
  auto mcpEndpoint = std::make_shared<McpHttpEndpoint>(*mcpServer, mcpOrigins, mcpAuth);

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

  // Safety net for uncaught exceptions: setExceptionHandler replaces ONLY drogon's default
  // uncaught-exception path — a handler that already catches its own error (EventsApi, McpKeyApi,
  // FeedbackApi) and every successful response are untouched. Anything that escaped a handler lands
  // a row in server_errors and gets a clean generic 500. The insert is fully guarded — if the DB is
  // the very thing that's down, the handler must never throw again — and e.what() never reaches the
  // body (it can carry internals); the stdout LOG_ERROR signal is kept too.
  app.setExceptionHandler([serverErrors, sentry](const std::exception& e, const drogon::HttpRequestPtr& req,
                                                 std::function<void(const drogon::HttpResponsePtr&)>&& callback) {
    const std::string method = req->getMethodString();
    const std::string path = req->getPath();
    std::string message = e.what();
    if (message.size() > 500) {                            // bound the column, cutting on a UTF-8 boundary
      std::size_t cut = 500;
      while (cut > 0 && (static_cast<unsigned char>(message[cut]) & 0xC0) == 0x80) --cut;
      message.resize(cut);
    }
    LOG_ERROR << "uncaught exception on " << method << " " << path << ": " << message;
    try {
      serverErrors->insert(method, path, 500, message);
    } catch (const std::exception& sink) {
      LOG_ERROR << "server_errors insert dropped: " << sink.what();
    }
    try {
      sentry->captureException("uncaught", method, path, message);
    } catch (const std::exception& sink) {
      LOG_ERROR << "sentry capture dropped: " << sink.what();
    }
    Json::Value body(Json::objectValue);
    body["error"] = "internal error";
    auto resp = drogon::HttpResponse::newHttpJsonResponse(body);
    resp->setStatusCode(drogon::k500InternalServerError);
    callback(resp);
  });

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
  app.registerSyncAdvice([writeCors, mcpPath](const drogon::HttpRequestPtr& req) -> drogon::HttpResponsePtr {
    if (req->method() != drogon::Options) return nullptr;  // real requests are dressed on the way out
    if (req->path() == mcpPath) return nullptr;            // the MCP endpoint answers its own preflight
    auto resp = drogon::HttpResponse::newHttpResponse();
    resp->setStatusCode(drogon::k204NoContent);
    writeCors(req, resp);
    resp->addHeader("Access-Control-Allow-Methods", "GET, PUT, PATCH, POST, DELETE, OPTIONS");
    resp->addHeader("Access-Control-Allow-Headers", "content-type, authorization");
    resp->addHeader("Access-Control-Max-Age", "600");
    return resp;
  });

  // Abuse ceilings, enforced at the sync join point so the 429 actually short-circuits — a
  // pre-routing advice returning a response binds to the observer overload and is dropped (see
  // CORS above). The limiter keys on the real visitor IP (CF-Connecting-IP behind Cloudflare, see
  // clientIp); internal traffic (no proxy header) is never limited. The magic-link path adds a
  // per-client bucket loose enough for shared NAT, plus a global send ceiling — the real guard on
  // the Resend quota — that no single client can lift. Compose gets the same pair of buckets: the
  // per-IP one keeps a single paster honest, the global one is the real guard on the LLM spend.
  auto apiLimiter = std::make_shared<RateLimiter>(25.0, 50.0);          // ~25 req/s/client, burst 50
  auto magicPerIp = std::make_shared<RateLimiter>(30.0 / 600.0, 30.0);  // ~30 links / 10 min / client
  auto magicGlobal = std::make_shared<RateLimiter>(0.5, 60.0);          // global email send ceiling
  auto composePerIp = std::make_shared<RateLimiter>(10.0 / 600.0, 5.0);  // ~10 plans / 10 min / client
  auto composeGlobal = std::make_shared<RateLimiter>(0.5, 20.0);         // global LLM spend ceiling
  app.registerSyncAdvice(
      [apiLimiter, magicPerIp, magicGlobal, composePerIp, composeGlobal,
       writeCors](const drogon::HttpRequestPtr& req) -> drogon::HttpResponsePtr {
        if (req->method() == drogon::Options) return nullptr;  // preflight already answered above
        const std::string ip = clientIp(req);
        if (ip.empty()) return nullptr;  // internal / health-check traffic
        // Per-IP before global, so a hammering client is denied out of its own bucket and
        // never drains the shared ceiling for everyone else. Drogon ROUTES paths
        // case-insensitively while path() preserves the request's casing — compare
        // lowercased, or /V1/Compose walks straight past the spend ceilings.
        std::string path = req->path();
        std::transform(path.begin(), path.end(), path.begin(),
                       [](unsigned char c) { return std::tolower(c); });
        // The Paddle webhook authenticates every byte by HMAC, and Paddle delivers a whole event
        // burst from a small IP set behind Cloudflare — which collapses onto ONE bucket here. A 429
        // is a failed delivery that burns one of Paddle's ~60 retries, so shedding a billing event
        // to rate-limit an endpoint that already verifies its own signature is a bad trade.
        if (path == "/v1/paddle/webhook") return nullptr;
        bool ok = apiLimiter->allow(ip);
        if (ok && path == "/v1/auth/magic-link")
          ok = magicPerIp->allow(ip) && magicGlobal->allow("global");
        if (ok && path == "/v1/compose")
          ok = composePerIp->allow(ip) && composeGlobal->allow("global");
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
      [writeCors, mcpPath](const drogon::HttpRequestPtr& req, const drogon::HttpResponsePtr& resp) {
        if (req->path() == mcpPath) return;  // MCP responses carry their own origin policy (below)
        writeCors(req, resp);
      });

  // MCP CORS for browser-based clients: reflect an allowed Origin and expose the session-id header
  // the transport mints. Non-browser clients (the common case) send no Origin and are gated only by
  // the endpoint's own DNS-rebind Origin check — token auth, not cookies, so no Allow-Credentials.
  app.registerPostHandlingAdvice(
      [mcpOrigins, mcpPath](const drogon::HttpRequestPtr& req, const drogon::HttpResponsePtr& resp) {
        if (req->path() != mcpPath) return;
        const std::string origin = req->getHeader("Origin");
        if (origin.empty()) return;
        if (!mcpOrigins.count("*") && !mcpOrigins.count(origin)) return;
        resp->addHeader("Access-Control-Allow-Origin", mcpOrigins.count("*") ? "*" : origin);
        resp->addHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
        resp->addHeader("Vary", "Origin");
      });

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
  // Paddle billing: the webhook Paddle delivers to (signature-verified, no session), and the
  // signed-in browser's own subscription read.
  app.registerHandler(
      "/v1/paddle/webhook",
      [billingApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        billingApi->webhook(req, std::move(cb));
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/billing/checkout",
      [billingApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        billingApi->startCheckout(req, std::move(cb));
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/subscription",
      [billingApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        billingApi->mySubscription(req, std::move(cb));
      },
      {drogon::Get});

  // Google sign-in: two top-level browser navigations (no CORS — these are redirects, not fetches).
  app.registerHandler(
      "/v1/auth/google/start",
      [authApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        authApi->googleStart(req, std::move(cb));
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/auth/google/callback",
      [authApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        authApi->googleCallback(req, std::move(cb));
      },
      {drogon::Get});
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

  // Settings §5 account surface: profile edit, sessions & devices, and the §4 soft close.
  app.registerHandler(
      "/v1/me",
      [authApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { authApi->patchMe(req, std::move(cb)); },
      {drogon::Patch});
  app.registerHandler(
      "/v1/me",
      [authApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { authApi->deleteMe(req, std::move(cb)); },
      {drogon::Delete});
  app.registerHandler(
      "/v1/sessions",
      [authApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { authApi->listSessions(req, std::move(cb)); },
      {drogon::Get});
  app.registerHandler(
      "/v1/sessions",
      [authApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { authApi->signOutEverywhere(req, std::move(cb)); },
      {drogon::Delete});
  app.registerHandler(
      "/v1/sessions/{id}",
      [authApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        authApi->revokeSession(req, std::move(cb), id);
      },
      {drogon::Delete});

  // Settings: personal MCP API keys — mint (the secret shown once), list (metadata only), revoke.
  app.registerHandler(
      "/v1/mcp-keys",
      [mcpKeyApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { mcpKeyApi->createKey(req, std::move(cb)); },
      {drogon::Post});
  app.registerHandler(
      "/v1/mcp-keys",
      [mcpKeyApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { mcpKeyApi->listKeys(req, std::move(cb)); },
      {drogon::Get});
  app.registerHandler(
      "/v1/mcp-keys/{id}",
      [mcpKeyApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        mcpKeyApi->revokeKey(req, std::move(cb), id);
      },
      {drogon::Delete});

  // OAuth authorization server. Discovery/register/authorize/token are driven by the MCP client;
  // the consent-facing endpoints (client info + decision) are called by the app, and their
  // preflight is covered by the shared CORS policy above.
  // The bare RFC 8414 URL, plus the shapes real MCP clients probe before it: the path-aware
  // variant (some clients wrongly append the resource path) and OpenID Connect's
  // openid-configuration (with and without the path). Serve the same authorization-server
  // metadata at each — a client that tries one of these FIRST must get JSON, not the SPA's
  // index.html falling through Caddy (which a client reads as "no authorization support").
  for (const char* asMetadataPath : {"/.well-known/oauth-authorization-server",
                                     "/.well-known/oauth-authorization-server/mcp",
                                     "/.well-known/openid-configuration",
                                     "/.well-known/openid-configuration/mcp"}) {
    app.registerHandler(
        asMetadataPath,
        [oauthApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { oauthApi->metadata(req, std::move(cb)); },
        {drogon::Get});
  }
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

  // Settings §2 connected tools: list a user's OAuth grants and disconnect one — separate
  // from the browser-session list above, so pulling a tool never signs a device out.
  app.registerHandler(
      "/v1/oauth/grants",
      [oauthApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { oauthApi->listGrants(req, std::move(cb)); },
      {drogon::Get});
  app.registerHandler(
      "/v1/oauth/grants/{clientId}",
      [oauthApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& clientId) {
        oauthApi->disconnectGrant(req, std::move(cb), clientId);
      },
      {drogon::Delete});

  app.registerHandler(
      "/v1/trees",
      [registryApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        registryApi->createTree(req, std::move(cb));
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/trees",
      [registryApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        registryApi->listTrees(req, std::move(cb));
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/trees/{id}",
      [registryApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        registryApi->patchTree(req, std::move(cb), id);
      },
      {drogon::Patch});
  app.registerHandler(
      "/v1/trees/{id}",
      [registryApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        registryApi->deleteTree(req, std::move(cb), id);
      },
      {drogon::Delete});
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

  // Per-tree unfurl card upload (og-tree-cards): owner-only, the raw PNG in the body.
  app.registerHandler(
      "/v1/trees/{id}/og-image",
      [ogImageApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        ogImageApi->putImage(req, std::move(cb), id);
      },
      {drogon::Put});
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

  // The unfurlable share page: /t/:id serves the SPA shell with this tree's OG meta baked in.
  // Caddy path-routes /t/* here; everything else stays the static SPA.
  app.registerHandler(
      "/t/{id}",
      [sharePageApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        sharePageApi->page(req, std::move(cb), id);
      },
      {drogon::Get});

  // The og:image scrapers fetch: the tree's own card, canRead-gated, 302 to the generic card
  // on any miss. Public, unauthenticated (a private tree's card resolves only for its owner).
  app.registerHandler(
      "/og/{id}.png",
      [ogImageApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        ogImageApi->getImage(req, std::move(cb), id);
      },
      {drogon::Get});

  app.registerHandler(
      "/v1/events",
      [eventsApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { eventsApi->ingest(req, std::move(cb)); },
      {drogon::Post});

  // The feedback door: anonymous allowed (a frustrated logged-out user is the point); the
  // shared per-IP apiLimiter covers this route like every other.
  app.registerHandler(
      "/v1/feedback",
      [feedbackApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { feedbackApi->submit(req, std::move(cb)); },
      {drogon::Post});

  // Paste-import escalation: anonymous allowed (the birth canvas has no account); abuse is
  // the compose rate-limit pair above. CORS rides the shared policy like every other route.
  app.registerHandler(
      "/v1/compose",
      [composeApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { composeApi->compose(req, std::move(cb)); },
      {drogon::Post});

  // MCP Streamable-HTTP transport: one path, three verbs (POST a JSON-RPC message, GET a would-be
  // SSE stream — 405 here, DELETE ends a session), plus its own OPTIONS preflight advertising the
  // MCP headers the generic API preflight above deliberately skips.
  app.registerHandler(
      mcpPath,
      [mcpEndpoint](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { mcpEndpoint->handlePost(req, std::move(cb)); },
      {drogon::Post});
  app.registerHandler(
      mcpPath,
      [mcpEndpoint](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { mcpEndpoint->handleGet(req, std::move(cb)); },
      {drogon::Get});
  app.registerHandler(
      mcpPath,
      [mcpEndpoint](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { mcpEndpoint->handleDelete(req, std::move(cb)); },
      {drogon::Delete});
  app.registerHandler(
      mcpPath,
      [](const drogon::HttpRequestPtr&, HttpCallback&& cb) {
        auto resp = drogon::HttpResponse::newHttpResponse();
        resp->setStatusCode(drogon::k204NoContent);
        resp->addHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
        resp->addHeader("Access-Control-Allow-Headers",
                        "content-type, mcp-session-id, mcp-protocol-version, authorization");
        resp->addHeader("Access-Control-Max-Age", "86400");
        cb(resp);
      },
      {drogon::Options});

  // OAuth Protected Resource Metadata (RFC 9728): where an MCP client discovers this host's
  // authorization server after a 401 challenge. Public, unauthenticated. Served at both the bare
  // URL (which the 401's WWW-Authenticate points at) and the path-aware variant that RFC 9728 §3.1
  // derives for the resource https://…/mcp — the one MCP 2025-06-18 clients probe FIRST.
  auto protectedResourceMetadata = [mcpResource, apiBaseUrl](const drogon::HttpRequestPtr&, HttpCallback&& cb) {
    Json::Value metadata(Json::objectValue);
    metadata["resource"] = mcpResource;
    Json::Value servers(Json::arrayValue);
    servers.append(apiBaseUrl);
    metadata["authorization_servers"] = servers;
    Json::Value methods(Json::arrayValue);
    methods.append("header");
    metadata["bearer_methods_supported"] = methods;
    cb(drogon::HttpResponse::newHttpJsonResponse(metadata));
  };
  app.registerHandler("/.well-known/oauth-protected-resource", protectedResourceMetadata, {drogon::Get});
  app.registerHandler("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata, {drogon::Get});

  const char* portEnv = std::getenv("PORT");
  int port = portEnv ? std::atoi(portEnv) : 8080;
  LOG_INFO << "windmill-backend listening on :" << port;
  app.setClientMaxBodySize(8 * 1024 * 1024);         // backstop cap; a full PUT document can be large
  app.setClientMaxMemoryBodySize(1 * 1024 * 1024);
  app.setMaxConnectionNum(20000);                    // global socket ceiling (all arrive via Caddy)
  app.addListener("0.0.0.0", port).setThreadNum(4).run();
  return 0;
}

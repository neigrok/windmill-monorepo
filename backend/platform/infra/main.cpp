#include "platform/adapters/amplitude/AmplitudeClient.h"
#include "platform/adapters/clock/SystemClock.h"
#include "platform/adapters/oidc/AppleOAuthClient.h"
#include "platform/adapters/oidc/GoogleOAuthClient.h"
#include "platform/adapters/postgres/PgAccountFootprint.h"
#include "platform/adapters/paddle/BillingApi.h"
#include "platform/adapters/crypto/OpenSslTokenGenerator.h"
#include "platform/adapters/email/ResendClient.h"
#include "platform/adapters/email/ResendEmailSender.h"
#include "platform/adapters/sentry/SentryClient.h"
#include "platform/adapters/http/AuthApi.h"
#include "products/roadmap/adapters/auth/ForkSignup.h"
#include "platform/adapters/http/EventsApi.h"
#include "platform/adapters/http/FeedbackApi.h"
#include "platform/adapters/http/McpKeyApi.h"
#include "platform/adapters/http/OAuthApi.h"
#include "platform/adapters/http/RateLimiter.h"
#include "products/roadmap/adapters/llm/AnthropicAgent.h"
#include "products/roadmap/adapters/llm/AnthropicComposer.h"
#include "platform/adapters/mcp/McpHttpEndpoint.h"
#include "platform/adapters/mcp/McpServer.h"
#include "products/roadmap/adapters/mcp/RoadmapResources.h"
#include "products/roadmap/adapters/mcp/RoadmapTools.h"
#include "platform/adapters/postgres/PgAuthRepository.h"
#include "platform/adapters/postgres/PgEventRepository.h"
#include "platform/adapters/postgres/PgFeedbackRepository.h"
#include "platform/adapters/postgres/PgMcpKeyRepository.h"
#include "platform/adapters/postgres/PgOAuthRepository.h"
#include "products/roadmap/adapters/postgres/PgOgImageRepository.h"
#include "products/roadmap/adapters/postgres/PgOgVideoRepository.h"
#include "products/roadmap/adapters/postgres/PgOpLog.h"
#include "products/roadmap/adapters/postgres/PgProgressRepository.h"
#include "products/roadmap/adapters/email/ResendReminderSender.h"
#include "products/roadmap/adapters/postgres/PgReminderRepository.h"
#include "platform/adapters/postgres/PgServerErrorRepository.h"
#include "platform/adapters/postgres/PgSubscriptionRepository.h"
#include "products/roadmap/adapters/postgres/PgTendRunRepository.h"
#include "products/roadmap/adapters/postgres/PgTreeRepository.h"
#include "products/roadmap/adapters/ws/PresenceHub.h"
#include "products/roadmap/adapters/ws/WsPresenceBus.h"
#include "platform/application/AuthService.h"
#include "platform/application/Entitlements.h"
#include "products/roadmap/application/ForkService.h"
#include "platform/application/McpKeyService.h"
#include "platform/application/OAuthService.h"
#include "products/roadmap/application/ProgressService.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/application/TendingService.h"
#include "products/roadmap/application/TreeRegistry.h"
#include "products/roadmap/application/ReminderSweep.h"
#include "products/roadmap/routes.h"
#include "products/journal/adapters/email/ResendNudgeSender.h"
#include "products/journal/adapters/llm/NullEmbedder.h"
#include "products/journal/adapters/llm/NullTranscriber.h"
#include "products/journal/adapters/llm/OpenAiTranscriber.h"
#include "products/journal/adapters/postgres/PgEchoRepository.h"
#include "products/journal/adapters/postgres/PgJournalRepository.h"
#include "products/journal/adapters/postgres/PgNudgeRepository.h"
#include "products/journal/application/PageService.h"
#include "products/journal/routes.h"
#include "products/gym/adapters/postgres/PgTrainingRepository.h"
#include "products/gym/application/LogService.h"
#include "products/gym/routes.h"

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
  // One Resend transport, shared by every mail: the neutral client owns the single outbound loop
  // and the api key, and each mail sender (platform sign-in, roadmap reminder, journal nudge) is
  // just a thin variable-binding over it. Kept alive here for the whole process, so every sender
  // holding a reference to it outlives nothing.
  auto resendClient = std::make_shared<ResendClient>(
      resendKey ? resendKey : "", resendFrom ? resendFrom : "Windmill <login@windmill.works>");
  auto emailSender = std::make_shared<ResendEmailSender>(*resendClient);
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

  // "Does this account hold anything?" — the one precondition on the link door (backend/AUTH.md).
  // Products are named HERE, in the composition root that composes them anyway, so platform never
  // learns a product's schema and a probe stays one table plus the column that owns its rows.
  // EVERY product must appear: one missing from this list reports an account empty that is not,
  // and the link door would then delete real data.
  auto accountFootprint = std::make_shared<PgAccountFootprint>(
      connString, std::vector<OwnedTable>{
                      {"trees", "owner_id"},                // roadmap
                      {"journal_page", "user_id"},          // journal
                      {"gym_sessions", "user_id"},          // gym — a workout with no sets is still a workout
                      {"gym_sets", "user_id"},              // gym
                      {"gym_routines", "user_id"},          // gym
                      {"paddle_subscriptions", "user_id"},  // platform — never fold away a payer
                      {"mcp_keys", "user_id"},              // platform
                      {"oauth_grants", "user_id"},          // platform
                  });
  auto authService = std::make_shared<AuthService>(*authRepo, *emailSender, *tokens, *systemClock,
                                                   *oauthService, *accountFootprint, appBaseUrl);
  auto forkService = std::make_shared<ForkService>(*registry, *trees, *tokens);
  // Google sign-in (second door onto wm_session). Empty client id/secret → configured() is false and
  // the routes bounce to the app, so the feature is dark until GOOGLE_CLIENT_ID/SECRET are set. The
  // redirect URI must be registered verbatim in the Google Cloud console.
  const char* googleClientId = std::getenv("GOOGLE_CLIENT_ID");
  const char* googleClientSecret = std::getenv("GOOGLE_CLIENT_SECRET");
  auto googleClient = std::make_shared<GoogleOAuthClient>(googleClientId ? googleClientId : "",
                                                          googleClientSecret ? googleClientSecret : "",
                                                          apiBaseUrl + "/v1/auth/google/callback");
  // The auth surface is product-neutral; the one product-shaped thing sign-in does — planting a
  // fork when a fork link is followed — rides in behind the SignupFork port. Roadmap injects its
  // ForkService here; a notes/gym-only deploy would pass nullptr and the fork steps no-op.
  // Apple sign-in (the native door). Dark until all four land — the bundle id the app ships, the
  // team, the key id, and the .p8 key itself as PEM — and then the route 404s rather than half-works.
  const char* appleClientId = std::getenv("APPLE_CLIENT_ID");
  const char* appleTeamId = std::getenv("APPLE_TEAM_ID");
  const char* appleKeyId = std::getenv("APPLE_KEY_ID");
  const char* applePrivateKey = std::getenv("APPLE_PRIVATE_KEY");
  auto appleClient = std::make_shared<AppleOAuthClient>(
      appleClientId ? appleClientId : "", appleTeamId ? appleTeamId : "", appleKeyId ? appleKeyId : "",
      applePrivateKey ? applePrivateKey : "");
  auto forkSignup = std::make_shared<ForkSignup>(*forkService);
  auto authApi = std::make_shared<AuthApi>(authService, forkSignup, secureCookies, cookieDomain,
                                           googleClient, appBaseUrl, appleClient);
  auto mcpKeyApi = std::make_shared<McpKeyApi>(authService, mcpKeyService);
  auto oauthApi = std::make_shared<OAuthApi>(oauthService, authService, apiBaseUrl, appBaseUrl, "/#/oauth/authorize");



  // Per-tree unfurl cards (og-tree-cards): the owner PUTs their tree's rendered 1200×630 PNG,
  // and GET /og/:id.png serves it (canRead-gated) as the share link's og:image — with the
  // generic card as the fallback whenever a tree has no image or can't be read.
  auto ogImages = std::make_shared<PgOgImageRepository>(connString);

  // Per-tree share videos (og-share-video): the owner PUTs their tree's rendered mp4/webm loop,
  // and GET /v1/trees/:id/og-video serves it (canRead-gated) as the share link's og:video — the
  // og:image card above stays the poster fallback, so a tree with no video is a plain 404 there,
  // never a broken tag. Built before the share page so it can advertise og:video only for a tree
  // that actually carries one (a cheap `has` on render).
  auto ogVideos = std::make_shared<PgOgVideoRepository>(connString);

  // The real share path (path-share-pages): GET /t/:id serves the SPA shell with a shared
  // tree's own unfurl meta spliced in, so the link unfurls as itself for social scrapers. It
  // reads the built index.html from WINDMILL_WEB_ROOT (the same host dir Caddy serves); a
  // private or absent tree gets the shell verbatim, so it stays indistinguishable from absent.
  const char* webRootEnv = std::getenv("WINDMILL_WEB_ROOT");

  // The public gallery (public-gallery), on its two surfaces over one index: GET /gallery renders
  // every LISTED tree as a real anchor in the served HTML — the path that was missing, since a
  // public tree's share page has always been indexable but nothing linked to it — and GET
  // /v1/gallery hands the same ranked index to the in-product shelf and /browse as JSON, with two
  // extra facts per row for a signed-in reader (is it mine, have I forked it).

  // The per-user tree registry (create + list + rename + delete). Reads are repo-direct;
  // rename goes through RoomRegistry so a live room's title stays coherent with the column.
  auto treeRegistry = std::make_shared<TreeRegistry>(*trees, *progress, *tokens, genesis, *registry, *systemClock);
  // The local mirror of Paddle billing state. Private trees are free (the paid line is tending, not
  // privacy), so nothing gates visibility on it — it feeds the /v1/subscription read and the
  // tending allowance's free-vs-Pro plan lookup.
  auto subscriptionRepo = std::make_shared<PgSubscriptionRepository>(connString);
  // Windmill One, asked as a domain question. Every paid feature — Talk, echoes, the tending Pro
  // plan — gates through this one seam instead of re-deriving the rule over the Paddle mirror, so
  // "what grants access" lives in exactly one place (platform/application/Entitlements).
  auto entitlements = std::make_shared<Entitlements>(*subscriptionRepo);

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
  auto composer = std::make_shared<AnthropicComposer>(anthropicKey ? anthropicKey : "", sentry);

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

  // Tending (durable half): a sentence starts a server-side agent run over the very same tools MCP
  // drives (*mcpTools), so an agent's edits land through the rooms exactly as a person's do. The
  // agent is the AnthropicAgent loop on the same ANTHROPIC_API_KEY the composer uses. Shipped DARK
  // by default — the designed first face is "not turned on" — so TENDING_ENABLED must be an explicit
  // "true"/"1" to arm it, AND the agent must actually be configured (a key present). Enabling the
  // flag with no key keeps the quiet "not-enabled" face rather than emitting a stream of failed runs.
  const char* tendingEnabledEnv = std::getenv("TENDING_ENABLED");
  const std::string tendingEnabledFlag = tendingEnabledEnv ? tendingEnabledEnv : "";
  auto tendRuns = std::make_shared<PgTendRunRepository>(connString);
  // Reap runs a previous process left mid-flight: this boots before the server accepts traffic, so
  // every `running` row is orphaned and safe to settle to `failed` — a returning phone then reads a
  // finished run rather than polling a `running` row that will never move.
  if (const int reaped = tendRuns->failOrphanedRuns(); reaped > 0)
    LOG_INFO << "tending: reaped " << reaped << " run(s) stranded by a restart";
  auto tendingAgent = std::make_shared<AnthropicAgent>(anthropicKey ? anthropicKey : "", sentry);
  const bool tendingEnabled =
      (tendingEnabledFlag == "true" || tendingEnabledFlag == "1") && tendingAgent->configured();
  auto tendingService = std::make_shared<TendingService>(*tendRuns, *tendingAgent, *mcpTools,
                                                         *systemClock, *tokens, *entitlements,
                                                         tendingEnabled);

  // Weekly reminders (domain/Reminders.h). The heartbeat is a dedicated thread of the sweep's
  // own — never a drogon request loop, which must not block on libpqxx — and it carries no
  // schedule state, so this restart loses nothing: within one tick it asks the database who is
  // due. Shipped DARK twice over: REMINDERS_ENABLED must say so AND the user must be named in
  // REMINDERS_ALLOWLIST, which is how the whole engine runs against one account for a month
  // before anyone else can receive anything. Both gates are read at send time, so the decision
  // ledger keeps recording honest weeks while nothing goes out.
  const char* remindersEnabledEnv = std::getenv("REMINDERS_ENABLED");
  const std::string remindersEnabledFlag = remindersEnabledEnv ? remindersEnabledEnv : "";
  const char* remindersAllowlistEnv = std::getenv("REMINDERS_ALLOWLIST");
  const char* remindersAdminEnv = std::getenv("REMINDERS_ADMIN_TOKEN");
  auto reminderRepo = std::make_shared<PgReminderRepository>(connString);
  ReminderArming reminderArming(remindersEnabledFlag == "true" || remindersEnabledFlag == "1",
                                remindersAllowlistEnv ? remindersAllowlistEnv : "");
  auto reminderMail = std::make_shared<ResendReminderSender>(*resendClient);
  auto reminderSweep = std::make_shared<ReminderSweep>(*reminderRepo, *reminderMail, *tokens,
                                                       *systemClock, reminderArming, appBaseUrl);
  reminderSweep->start();

  McpAuth mcpAuth{oauthService.get(), mcpResource,     mcpResourceMetadataUrl,
                  mcpToken,           mcpFallbackUser, mcpKeyService.get()};
  ServerInfo mcpInfo{
      "windmill", "0.1.0",
      "Windmill roadmaps are RPG-style skill trees: nodes are skills/milestones, and a "
      "prerequisite edge points from a required node to the node it unlocks. Use get_tree and "
      "get_diagnostics to inspect, the edit tools (create_node, connect, …) to author, and "
      "set_progress to mark a node active or complete. Edits are never rejected — a cycle or a "
      "detached node is surfaced by get_diagnostics, not refused."};
  auto mcpServer = std::make_shared<McpServer>(*mcpTools, std::move(mcpInfo), roadmapResources());
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
  // Tending starts a whole agent loop — many model turns and many tool calls — so it is far more
  // expensive than one compose and gets its own, tighter pair. The per-user allowance in
  // TendingService is the real per-account brake; these buckets guard the fleet against a single IP.
  auto tendPerIp = std::make_shared<RateLimiter>(5.0 / 600.0, 3.0);   // ~5 runs / 10 min / client
  auto tendGlobal = std::make_shared<RateLimiter>(0.2, 8.0);          // global agent-spend ceiling
  app.registerSyncAdvice(
      [apiLimiter, magicPerIp, magicGlobal, composePerIp, composeGlobal, tendPerIp, tendGlobal,
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
        // Only the POST that STARTS a run (/v1/trees/{id}/tend) carries the agent cost; the GET
        // catch-up (/v1/tend/{runId}) is a plain row read the general apiLimiter already covers.
        if (ok && path.rfind("/v1/trees/", 0) == 0 && path.size() >= 5 &&
            path.compare(path.size() - 5, 5, "/tend") == 0)
          ok = tendPerIp->allow(ip) && tendGlobal->allow("global");
        if (ok) return nullptr;
        Json::Value body(Json::objectValue);
        body["error"] = "rate limited";
        body["code"] = "rate_limited";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(body);
        resp->setStatusCode(drogon::k429TooManyRequests);
        writeCors(req, resp);  // short-circuits post-handling, so dress the 429 for CORS here
        return resp;
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
  // Apple sign-in: one POST, no redirect — the native app ran the authorization itself. Signed in
  // already, the same call attaches the door instead of resolving an account.
  app.registerHandler(
      "/v1/auth/apple",
      [authApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { authApi->apple(req, std::move(cb)); },
      {drogon::Post});
  // The link door: fold this (empty) account into the one the magic link names.
  app.registerHandler(
      "/v1/auth/link",
      [authApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { authApi->link(req, std::move(cb)); },
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
      "/v1/events",
      [eventsApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { eventsApi->ingest(req, std::move(cb)); },
      {drogon::Post});

  // The feedback door: anonymous allowed (a frustrated logged-out user is the point); the
  // shared per-IP apiLimiter covers this route like every other.
  app.registerHandler(
      "/v1/feedback",
      [feedbackApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { feedbackApi->submit(req, std::move(cb)); },
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

  // The roadmap product's whole surface, mounted behind one seam (products/roadmap/routes.h): the
  // collab socket, its presence flush, and every roadmap HTTP route. Platform routes and the shared
  // MCP endpoint were registered above; a future product mirrors this call with its own Deps.
  RoadmapDeps roadmapDeps{
      .registry = registry, .trees = trees, .progress = progress, .progressService = progressService,
      .oplog = oplog, .bus = bus, .presence = presence, .genesis = genesis,
      .authService = authService, .forkService = forkService, .treeRegistry = treeRegistry,
      .ogImages = ogImages, .ogVideos = ogVideos, .webRoot = webRootEnv ? webRootEnv : "",
      .tendingService = tendingService, .reminderSweep = reminderSweep, .reminderRepo = reminderRepo,
      .tokens = tokens, .clock = systemClock,
      .remindersAdminToken = remindersAdminEnv ? remindersAdminEnv : "", .composer = composer};
  registerRoutes(app, roadmapDeps);

  // The journal product — the second room — mounted behind its own seam (products/journal/routes.h),
  // in namespace wm::journal so its registerRoutes never collides with roadmap's. Wave 1 is the
  // pages canvas: durable, owner-scoped, offline-convergent. It reads platform auth like roadmap and
  // owns no public surface.
  auto journalPages = std::make_shared<PgJournalRepository>(connString);
  auto pageService = std::make_shared<PageService>(*journalPages);
  // Wave 2 nudges: a daily heartbeat on its own thread, shipped DARK behind an arming allowlist
  // exactly like the reminder engine — JOURNAL_NUDGE_ENABLED must say so AND the user be named in
  // JOURNAL_NUDGE_ALLOWLIST before any mail leaves; both gates are read at send time, so the ledger
  // records honest days while nothing goes out. The knock time is the device's, so the server holds
  // no rhythm and needs no timezone.
  const char* journalNudgeEnabledEnv = std::getenv("JOURNAL_NUDGE_ENABLED");
  const std::string journalNudgeEnabledFlag = journalNudgeEnabledEnv ? journalNudgeEnabledEnv : "";
  const char* journalNudgeAllowlistEnv = std::getenv("JOURNAL_NUDGE_ALLOWLIST");
  const char* journalNudgeAdminEnv = std::getenv("JOURNAL_NUDGE_ADMIN_TOKEN");
  auto journalNudges = std::make_shared<PgNudgeRepository>(connString);
  NudgeArming journalNudgeArming(journalNudgeEnabledFlag == "true" || journalNudgeEnabledFlag == "1",
                                 journalNudgeAllowlistEnv ? journalNudgeAllowlistEnv : "");
  auto journalNudgeMail = std::make_shared<ResendNudgeSender>(*resendClient);
  auto journalNudgeSweep = std::make_shared<NudgeSweep>(*journalNudges, *journalNudgeMail, *tokens,
                                                        *systemClock, journalNudgeArming, appBaseUrl);
  journalNudgeSweep->start();
  // Wave 3 echoes (Windmill One): the nightly reading-across, gated on the one entitlement seam the
  // billing edge already feeds. The embedder is unwired by default (NullEmbedder ⇒ configured()
  // false ⇒ the sweep no-ops) until a vendor or a self-hosted model is plugged in behind the
  // Embedder port; nothing else in the echo path moves.
  auto journalEmbedder = std::make_shared<NullEmbedder>();
  auto journalEchoes = std::make_shared<PgEchoRepository>(connString);
  const char* journalEchoAdminEnv = std::getenv("JOURNAL_ECHO_ADMIN_TOKEN");
  auto journalEchoSweep = std::make_shared<EchoSweep>(*journalEchoes, *journalEmbedder,
                                                      *entitlements, *systemClock, EchoRules{});
  journalEchoSweep->start();
  // Voice (Windmill One): bought from OpenAI's gpt-4o-transcribe when OPENAI_API_KEY is set, and
  // unwired otherwise (NullTranscriber ⇒ the endpoint answers 503 and the client hides Talk). Either
  // way it gates through the same Windmill One entitlement seam as echoes and tending.
  const char* openaiKeyEnv = std::getenv("OPENAI_API_KEY");
  std::shared_ptr<Transcriber> journalTranscriber;
  if (openaiKeyEnv && *openaiKeyEnv) journalTranscriber = std::make_shared<OpenAiTranscriber>(openaiKeyEnv);
  else journalTranscriber = std::make_shared<NullTranscriber>();
  journal::JournalDeps journalDeps{.pageService = pageService, .authService = authService,
                                   .nudges = journalNudges, .nudgeSweep = journalNudgeSweep,
                                   .tokens = tokens, .clock = systemClock,
                                   .nudgeAdminToken = journalNudgeAdminEnv ? journalNudgeAdminEnv : "",
                                   .echoes = journalEchoes, .echoSweep = journalEchoSweep,
                                   .echoAdminToken = journalEchoAdminEnv ? journalEchoAdminEnv : "",
                                   .transcriber = journalTranscriber, .entitlements = entitlements};
  journal::registerRoutes(app, journalDeps);

  // The gym product — the third room — mounted behind its own seam (products/gym/routes.h). Phase 0
  // is the durable set write: owner-scoped, idempotent by client-minted id, auto-close applied
  // lazily by the service. No env vars, no arming flags, no sweeps, no vendor keys — the seam's
  // whole surface area is the absence in this block.
  auto gymRepository = std::make_shared<gym::PgTrainingRepository>(connString);
  auto logService = std::make_shared<gym::LogService>(*gymRepository, *systemClock);
  gym::GymDeps gymDeps{.logService = logService, .authService = authService};
  gym::registerRoutes(app, gymDeps);

  const char* portEnv = std::getenv("PORT");
  int port = portEnv ? std::atoi(portEnv) : 8080;
  LOG_INFO << "windmill-backend listening on :" << port;
  app.setClientMaxBodySize(8 * 1024 * 1024);         // backstop cap; a full PUT document can be large
  app.setClientMaxMemoryBodySize(1 * 1024 * 1024);
  app.setMaxConnectionNum(20000);                    // global socket ceiling (all arrive via Caddy)
  app.addListener("0.0.0.0", port).setThreadNum(4).run();
  return 0;
}

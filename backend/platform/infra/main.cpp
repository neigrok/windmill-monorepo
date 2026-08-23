#include "platform/adapters/amplitude/AmplitudeClient.h"
#include "platform/adapters/clock/SystemClock.h"
#include "platform/adapters/oidc/AppleOAuthClient.h"
#include "platform/adapters/oidc/GoogleOAuthClient.h"
#include "platform/adapters/postgres/PgAccountFootprint.h"
#include "platform/adapters/paddle/BillingApi.h"
#include "platform/adapters/crypto/OpenSslTokenGenerator.h"
#include "platform/adapters/email/ResendClient.h"
#include "platform/adapters/email/ResendEmailSender.h"
#include "platform/adapters/email/ResendWebhookApi.h"
#include "platform/adapters/http/AccessLog.h"
#include "platform/adapters/sentry/LogTee.h"
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
#include "platform/adapters/mcp/CompositeToolHost.h"
#include "platform/adapters/mcp/McpHttpEndpoint.h"
#include "platform/adapters/mcp/McpServer.h"
#include "products/roadmap/adapters/mcp/RoadmapResources.h"
#include "products/roadmap/adapters/mcp/RoadmapTools.h"
#include "platform/adapters/postgres/PgAuthRepository.h"
#include "platform/adapters/amplitude/AmplitudeUsageSink.h"
#include "platform/adapters/postgres/PgAiUsageRepository.h"
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
#include "platform/adapters/postgres/PgRetentionStore.h"
#include "platform/adapters/postgres/PgServerErrorRepository.h"
#include "platform/adapters/postgres/PgSweepMutex.h"
#include "platform/adapters/postgres/PgSubscriptionRepository.h"
#include "products/roadmap/adapters/postgres/PgTendRunRepository.h"
#include "platform/adapters/postgres/PgPool.h"
#include "products/roadmap/adapters/postgres/PgTreeRepository.h"
#include "products/roadmap/adapters/ws/PresenceHub.h"
#include "products/roadmap/adapters/ws/WsPresenceBus.h"
#include "platform/application/AuthService.h"
#include "platform/application/Entitlements.h"
#include "platform/domain/AiFuse.h"
#include "platform/domain/MailArming.h"
#include "products/roadmap/application/ForkService.h"
#include "platform/application/McpKeyService.h"
#include "platform/application/OAuthService.h"
#include "products/roadmap/application/ProgressService.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/application/TendingService.h"
#include "products/roadmap/application/TreeRegistry.h"
#include "platform/application/RetentionSweep.h"
#include "products/roadmap/application/ReminderSweep.h"
#include "products/roadmap/routes.h"
#include "products/journal/adapters/email/ResendNudgeSender.h"
#include "platform/adapters/llm/AnthropicClient.h"
#include "products/journal/adapters/llm/AnthropicCurator.h"
#include "products/journal/adapters/llm/AnthropicSegmenter.h"
#include "products/journal/adapters/llm/HttpEmbedder.h"
#include "products/journal/adapters/llm/NullCurator.h"
#include "products/journal/adapters/llm/NullEmbedder.h"
#include "products/journal/adapters/llm/NullTranscriber.h"
#include "products/journal/adapters/llm/OpenAiTranscriber.h"
#include "products/journal/adapters/postgres/PgEchoRepository.h"
#include "products/journal/adapters/postgres/PgJournalRepository.h"
#include "products/journal/adapters/postgres/PgNudgeRepository.h"
#include "products/journal/application/EchoDerivations.h"
#include "products/journal/application/PageService.h"
#include "products/journal/application/WarmEchoRepository.h"
#include "products/journal/routes.h"
#include "products/gym/adapters/llm/AnthropicAsk.h"
#include "products/gym/adapters/mcp/GymToolCatalog.h"
#include "products/gym/adapters/mcp/GymTools.h"
#include "products/gym/adapters/postgres/PgAskThreadRepository.h"
#include "products/gym/adapters/postgres/PgCatalogRepository.h"
#include "products/gym/adapters/postgres/PgLogRepository.h"
#include "products/gym/adapters/postgres/PgPreferencesRepository.h"
#include "products/gym/adapters/postgres/PgProgramRepository.h"
#include "products/gym/application/AskService.h"
#include "products/gym/application/CatalogService.h"
#include "products/gym/application/PreferencesService.h"
#include "products/gym/application/ProgramService.h"
#include "products/gym/application/ThreadService.h"
#include "products/gym/application/TrainingService.h"
#include "products/gym/routes.h"

#include <drogon/drogon.h>

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <memory>
#include <set>
#include <string>
#include <thread>

namespace {
// A retention window in days. Unset or unreadable keeps the built-in default; 0 or less means keep
// forever, which the sweep honours by skipping that table.
int envDays(const char* name, int fallback) {
  const char* value = std::getenv(name);
  if (!value || !*value) return fallback;
  try {
    return std::stoi(value);
  } catch (const std::exception&) {
    return fallback;
  }
}
}

int main() {
  using namespace wm;

  // Also sizes the database pool: a pool ceiling below the thread count turns into waits and 500s.
  const unsigned int ioThreads = std::max(4u, std::thread::hardware_concurrency());

  const char* url = std::getenv("DATABASE_URL");
  std::string connString = url ? url : "postgresql://localhost/windmill";
  auto pool = std::make_shared<PgPool>(connString, ioThreads + PgPool::kReservedConnections);
  const Hlc genesis{1, 0, "genesis"};

  auto trees = std::make_shared<PgTreeRepository>(pool);
  auto progress = std::make_shared<PgProgressRepository>(pool);
  auto progressService = std::make_shared<ProgressService>(*progress);

  auto oplog = std::make_shared<PgOpLog>(pool);
  auto bus = std::make_shared<WsPresenceBus>();
  auto registry = std::make_shared<RoomRegistry>(*trees, *oplog, *bus);
  auto presence = std::make_shared<PresenceHub>();

  // The session rides in an HttpOnly cookie whose Secure flag and Domain follow the deployment.
  const char* appUrlEnv = std::getenv("WINDMILL_APP_URL");
  std::string appBaseUrl = appUrlEnv ? appUrlEnv : "http://localhost:5183";
  const char* resendKey = std::getenv("RESEND_API_KEY");
  const char* resendFrom = std::getenv("RESEND_FROM");
  const char* cookieDomainEnv = std::getenv("WINDMILL_COOKIE_DOMAIN");
  std::string cookieDomain = cookieDomainEnv ? cookieDomainEnv : "";
  bool secureCookies = appBaseUrl.rfind("https://", 0) == 0;

  auto authRepo = std::make_shared<PgAuthRepository>(pool);
  auto resendClient = std::make_shared<ResendClient>(
      resendKey ? resendKey : "", resendFrom ? resendFrom : "Windmill <login@windmill.works>");
  auto emailSender = std::make_shared<ResendEmailSender>(*resendClient);
  auto tokens = std::make_shared<OpenSslTokenGenerator>();
  auto systemClock = std::make_shared<SystemClock>();

  // Built before AuthService, which holds a reference to it for account close.
  const char* apiUrlEnv = std::getenv("WINDMILL_API_URL");
  std::string apiBaseUrl = apiUrlEnv ? apiUrlEnv : "http://localhost:8088";
  auto oauthRepo = std::make_shared<PgOAuthRepository>(pool);
  auto oauthService = std::make_shared<OAuthService>(*oauthRepo, *tokens, *systemClock);

  auto mcpKeyRepo = std::make_shared<PgMcpKeyRepository>(pool);
  auto mcpKeyService = std::make_shared<McpKeyService>(*mcpKeyRepo, *tokens, *systemClock);

  // Does this account hold anything. EVERY product must appear: one missing reports an account
  // empty that is not, and the link door then deletes real data.
  auto accountFootprint = std::make_shared<PgAccountFootprint>(
      pool, std::vector<OwnedTable>{
                {"trees", "owner_id"},                // roadmap
                {"journal_page", "user_id"},          // journal
                {"gym_sessions", "user_id"},          // gym
                {"gym_sets", "user_id"},              // gym
                {"gym_set_revisions", "user_id"},     // gym
                {"gym_routines", "user_id"},          // gym
                {"gym_proposals", "user_id"},         // gym
                {"gym_proposal_changes", "user_id"},  // gym
                {"gym_session_shares", "user_id"},    // gym
                {"gym_ask_threads", "user_id"},       // gym
                {"gym_ask_turns", "user_id"},         // gym
                // created_by is null on the catalog seeds, so they match no account.
                {"gym_exercises", "created_by"},
                {"gym_exercise_names", "user_id"},    // gym
                {"gym_exercise_aliases", "user_id"},  // gym
                // gym_preferences is absent on purpose: settings are not data an account holds.
                {"paddle_subscriptions", "user_id"},  // platform
                {"mcp_keys", "user_id"},              // platform
                {"oauth_grants", "user_id"},          // platform
            });
  auto authService = std::make_shared<AuthService>(*authRepo, *emailSender, *tokens, *systemClock,
                                                   *oauthService, *accountFootprint, appBaseUrl);
  auto forkService = std::make_shared<ForkService>(*registry, *trees, *tokens);
  // Empty client id/secret leaves configured() false and the routes bounce to the app. The redirect
  // URI must be registered verbatim in the Google Cloud console.
  const char* googleClientId = std::getenv("GOOGLE_CLIENT_ID");
  const char* googleClientSecret = std::getenv("GOOGLE_CLIENT_SECRET");
  auto googleClient = std::make_shared<GoogleOAuthClient>(googleClientId ? googleClientId : "",
                                                          googleClientSecret ? googleClientSecret : "",
                                                          apiBaseUrl + "/v1/auth/google/callback");
  // Apple sign-in: dark until all four land — the bundle id the app ships, the team, the key id,
  // and the .p8 key itself as PEM.
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



  auto ogImages = std::make_shared<PgOgImageRepository>(pool);

  // Built before the share page, which advertises og:video only for a tree that carries one.
  auto ogVideos = std::make_shared<PgOgVideoRepository>(pool);

  // The share page reads the built index.html from here. A private or absent tree gets the shell
  // verbatim, so the two stay indistinguishable.
  const char* webRootEnv = std::getenv("WINDMILL_WEB_ROOT");

  // Rename goes through RoomRegistry so a live room's title stays coherent with the column.
  auto treeRegistry = std::make_shared<TreeRegistry>(*trees, *progress, *tokens, genesis, *registry, *systemClock);
  auto subscriptionRepo = std::make_shared<PgSubscriptionRepository>(pool);
  // The spend ledger the ceilings read back; the Amplitude mirror below is only the eyes.
  auto aiUsageRepo = std::make_shared<PgAiUsageRepository>(pool);
  // One in-process trailing-hour ceiling over every vendor call; holds no database, so it still
  // bounds spend when Postgres is down.
  auto aiFuse = std::make_shared<AiFuse>(kHourlyFuseNanos);

  // Every paid feature gates through this one seam. WINDMILL_OWNER_EMAILS is a comma-separated
  // list of addresses that hold Windmill One; unset means nobody is an owner.
  const char* ownerEmailsEnv = std::getenv("WINDMILL_OWNER_EMAILS");
  auto entitlements = std::make_shared<Entitlements>(*subscriptionRepo, *aiUsageRepo,
                                                     ownerEmailsEnv ? ownerEmailsEnv : "");

  // Accepted funnel events forward to Amplitude with the session-resolved user_id when
  // AMPLITUDE_API_KEY is set. AMPLITUDE_HOST overrides the region (api.eu.amplitude.com for EU).
  const char* amplitudeKey = std::getenv("AMPLITUDE_API_KEY");
  const char* amplitudeHost = std::getenv("AMPLITUDE_HOST");
  auto amplitude = std::make_shared<AmplitudeClient>(
      amplitudeKey ? amplitudeKey : "",
      (amplitudeHost && *amplitudeHost) ? amplitudeHost : "api2.amplitude.com");  // set-but-empty → default
  // What every LLM adapter is handed: the ledger, written first, mirrored to Amplitude.
  std::shared_ptr<UsageSink> aiSpendSink =
      std::make_shared<AmplitudeUsageSink>(aiUsageRepo, amplitude);

  auto eventRepo = std::make_shared<PgEventRepository>(pool);
  auto eventsApi = std::make_shared<EventsApi>(eventRepo, authService, amplitude);


  auto feedbackRepo = std::make_shared<PgFeedbackRepository>(pool);
  auto feedbackApi = std::make_shared<FeedbackApi>(feedbackRepo, authService);

  // An empty PADDLE_WEBHOOK_SECRET refuses every delivery (Paddle retries), so billing is dark
  // rather than forgeable until the secret lands.
  const char* paddleWebhookSecret = std::getenv("PADDLE_WEBHOOK_SECRET");
  const char* paddleApiKey = std::getenv("PADDLE_API_KEY");
  const char* paddleEnv = std::getenv("PADDLE_ENV");
  const char* paddlePriceId = std::getenv("PADDLE_PRICE_ID");
  auto paddleClient = std::make_shared<PaddleApiClient>(paddleApiKey ? paddleApiKey : "",
                                                        paddleEnv ? paddleEnv : "sandbox");
  auto billingApi = std::make_shared<BillingApi>(*subscriptionRepo, authService, *systemClock,
                                                 paddleWebhookSecret ? paddleWebhookSecret : "",
                                                 paddleClient, paddlePriceId ? paddlePriceId : "");

  // An empty SENTRY_DSN leaves a no-op client.
  auto serverErrors = std::make_shared<PgServerErrorRepository>(pool);
  const char* sentryDsn = std::getenv("SENTRY_DSN");
  const char* sentryEnv = std::getenv("SENTRY_ENVIRONMENT");
  const char* sentryRelease = std::getenv("SENTRY_RELEASE");
  auto sentry = std::make_shared<SentryClient>(sentryDsn ? sentryDsn : "",
                                               sentryEnv ? sentryEnv : "production",
                                               sentryRelease ? sentryRelease : "");

  // Every LOG_* line teed to Sentry, installed before anything else logs so a failure during the
  // rest of this composition is already on the wire. SENTRY_LOG_LEVEL (default info) is the volume.
  installLogTee(sentry, logLevelFromEnv(std::getenv("SENTRY_LOG_LEVEL")));

  // The one sweep that deletes; no product table is reachable from it. 0 or less on any window
  // means keep forever.
  RetentionWindows retention;
  retention.eventDays = envDays("WINDMILL_EVENTS_RETENTION_DAYS", retention.eventDays);
  retention.feedbackDays = envDays("WINDMILL_FEEDBACK_RETENTION_DAYS", retention.feedbackDays);
  retention.serverErrorDays = envDays("WINDMILL_SERVER_ERROR_RETENTION_DAYS", retention.serverErrorDays);
  auto retentionStore = std::make_shared<PgRetentionStore>(pool);
  auto retentionLock = std::make_shared<PgSweepMutex>(pool, "hashtext('retention_sweep')::bigint",
                                                       "retention");
  auto retentionSweep =
      std::make_shared<RetentionSweep>(*retentionStore, *retentionLock, *systemClock, retention);
  retentionSweep->start();

  // No ANTHROPIC_API_KEY leaves /v1/compose answering 503.
  const char* anthropicKey = std::getenv("ANTHROPIC_API_KEY");
  auto composer = std::make_shared<AnthropicComposer>(anthropicKey ? anthropicKey : "", sentry, aiFuse, aiSpendSink);

  // MCP runs in this process, so agent edits go through the same RoomRegistry as REST and the
  // socket. Tokens are audience-bound to the MCP resource URL, which defaults to this host.
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

  // Tending runs a server-side agent over the same tools MCP drives, on the same ANTHROPIC_API_KEY
  // the composer uses. TENDING_ENABLED must be "true"/"1" AND the agent configured to arm it.
  const char* tendingEnabledEnv = std::getenv("TENDING_ENABLED");
  const std::string tendingEnabledFlag = tendingEnabledEnv ? tendingEnabledEnv : "";
  auto tendRuns = std::make_shared<PgTendRunRepository>(pool);
  // Runs before the server accepts traffic, so every `running` row is orphaned and safe to fail.
  if (const int reaped = tendRuns->failOrphanedRuns(); reaped > 0)
    LOG_INFO << "tending: reaped " << reaped << " run(s) stranded by a restart";
  auto tendingAgent = std::make_shared<AnthropicAgent>(anthropicKey ? anthropicKey : "", sentry, aiFuse, aiSpendSink);
  const bool tendingEnabled =
      (tendingEnabledFlag == "true" || tendingEnabledFlag == "1") && tendingAgent->configured();
  auto tendingService = std::make_shared<TendingService>(*tendRuns, *tendingAgent, *mcpTools,
                                                         *systemClock, *tokens, *entitlements,
                                                         tendingEnabled);

  // Weekly reminders, on a dedicated thread — never a drogon request loop, which must not block on
  // libpqxx. Dark twice over: REMINDERS_ENABLED must say so AND the user be named in
  // REMINDERS_ALLOWLIST. Both gates are read at send time, so the ledger keeps recording.
  const char* remindersEnabledEnv = std::getenv("REMINDERS_ENABLED");
  const std::string remindersEnabledFlag = remindersEnabledEnv ? remindersEnabledEnv : "";
  const char* remindersAllowlistEnv = std::getenv("REMINDERS_ALLOWLIST");
  const char* remindersAdminEnv = std::getenv("REMINDERS_ADMIN_TOKEN");
  auto reminderRepo = std::make_shared<PgReminderRepository>(pool);
  MailArming reminderArming(remindersEnabledFlag == "true" || remindersEnabledFlag == "1",
                            remindersAllowlistEnv ? remindersAllowlistEnv : "");
  auto reminderMail = std::make_shared<ResendReminderSender>(*resendClient);
  auto reminderSweep = std::make_shared<ReminderSweep>(*reminderRepo, *reminderMail, *tokens,
                                                       *systemClock, reminderArming, appBaseUrl);
  reminderSweep->start();

  // Built here because its tools are part of the MCP surface below, constructed once before the
  // server takes traffic. It takes appBaseUrl and NOT apiBaseUrl: a share is a link a human opens.
  auto gymLog = std::make_shared<gym::PgLogRepository>(pool);
  auto gymCatalog = std::make_shared<gym::PgCatalogRepository>(pool);
  auto gymProgram = std::make_shared<gym::PgProgramRepository>(pool);
  auto gymThreads = std::make_shared<gym::PgAskThreadRepository>(pool);
  auto gymPreferences = std::make_shared<gym::PgPreferencesRepository>(pool);
  auto gymTrainingService =
      std::make_shared<gym::TrainingService>(*gymLog, *gymProgram, *systemClock, *tokens);
  auto gymCatalogService = std::make_shared<gym::CatalogService>(*gymCatalog);
  auto gymProgramService = std::make_shared<gym::ProgramService>(*gymProgram, *systemClock);
  auto gymThreadService = std::make_shared<gym::ThreadService>(*gymThreads, *systemClock);
  auto gymPreferencesService = std::make_shared<gym::PreferencesService>(*gymPreferences);
  auto gymTools = std::make_shared<gym::GymTools>(*gymTrainingService, *gymCatalogService,
                                                  *gymProgramService, appBaseUrl);

  // With no ANTHROPIC_API_KEY there is no AskService, so gym::registerRoutes never mounts the path.
  auto gymAskAgent = std::make_shared<gym::AnthropicAsk>(anthropicKey ? anthropicKey : "", sentry, aiFuse, aiSpendSink);
  std::shared_ptr<gym::AskService> gymAsk;
  if (gymAskAgent->configured())
    gymAsk = std::make_shared<gym::AskService>(*gymTrainingService, *gymThreadService, *gymAskAgent,
                                               *gymTools, *entitlements);

  // Every product's module behind one host, filtered by the grant the credential carries. A
  // duplicate tool name across two products refuses to boot. Tending is deliberately NOT given this
  // host — it keeps *mcpTools directly, so an agent reading node text cannot reach another product.
  const std::vector<ToolModule> mcpModules{{*mcpTools, roadmapInstructions()},
                                           {*gymTools, gym::gymInstructions()}};
  auto mcpComposite = std::make_shared<CompositeToolHost>(mcpModules);

  // The shared bearer and the no-auth local door carry the account-wide grant.
  McpAuth mcpAuth{oauthService.get(), mcpResource,     mcpResourceMetadataUrl,   mcpToken,
                  mcpFallbackUser,    mcpKeyService.get(), ToolScope::everything()};
  auto mcpServer = std::make_shared<McpServer>(
      *mcpComposite, windmillServerInfo(*mcpComposite, sentryRelease ? sentryRelease : ""),
      roadmapResources());
  auto mcpEndpoint = std::make_shared<McpHttpEndpoint>(*mcpServer, mcpOrigins, mcpAuth);

  // After the composite, so `scopes_supported` is derived from the tool surface.
  auto oauthApi = std::make_shared<OAuthApi>(oauthService, authService, apiBaseUrl, appBaseUrl,
                                             "/#/oauth/authorize", supportedScopes(mcpComposite->products()));

  // The origins allowed to send credentialed (cookie-bearing) requests. The app is always trusted;
  // WINDMILL_ALLOWED_ORIGINS adds more, comma-separated. Anything else gets no CORS grant.
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

  // Registered first, so it wraps everything registered after it.
  installAccessLog(app);

  // Every sink here is guarded — this handler must never throw — and e.what() never reaches the
  // body, which can carry internals.
  app.setExceptionHandler([serverErrors, sentry](const std::exception& e, const drogon::HttpRequestPtr& req,
                                                 std::function<void(const drogon::HttpResponsePtr&)>&& callback) {
    const std::string method = loggableField(req->getMethodString());
    // Redacted: this path reaches stdout, a retained server_errors column and Sentry, and some
    // paths carry a live credential.
    const std::string path = loggableField(redactedPath(req->getPath()));
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

  // Allow-Credentials only ever rides an allow-listed Origin, never a reflected one.
  auto writeCors = [allowedOrigins](const drogon::HttpRequestPtr& req, const drogon::HttpResponsePtr& resp) {
    const std::string& origin = req->getHeader("origin");
    if (!origin.empty() && allowedOrigins.count(origin)) {
      resp->addHeader("Access-Control-Allow-Origin", origin);
      resp->addHeader("Access-Control-Allow-Credentials", "true");
    }
    resp->addHeader("Vary", "Origin");
  };

  // CORS preflight must be answered at the sync join point: it is ahead of Drogon's own OPTIONS
  // responder, and only that hook short-circuits on its return value — a pre-routing lambda of this
  // shape binds to the void(req) observer overload and its response is dropped.
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

  // Enforced at the sync join point so the 429 short-circuits. Keyed on the real visitor IP
  // (clientIp); internal traffic with no proxy header is never limited.
  auto apiLimiter = std::make_shared<RateLimiter>(25.0, 50.0);          // ~25 req/s/client, burst 50
  auto magicPerIp = std::make_shared<RateLimiter>(30.0 / 600.0, 30.0);  // ~30 links / 10 min / client
  auto magicGlobal = std::make_shared<RateLimiter>(0.5, 60.0);          // global email send ceiling
  auto codePerIp = std::make_shared<RateLimiter>(10.0 / 60.0, 10.0);    // ~10 code tries / min / client
  auto composePerIp = std::make_shared<RateLimiter>(10.0 / 600.0, 5.0);  // ~10 plans / 10 min / client
  auto composeGlobal = std::make_shared<RateLimiter>(0.5, 20.0);         // global LLM spend ceiling
  auto tendPerIp = std::make_shared<RateLimiter>(5.0 / 600.0, 3.0);   // ~5 runs / 10 min / client
  auto tendGlobal = std::make_shared<RateLimiter>(0.2, 8.0);          // global agent-spend ceiling
  app.registerSyncAdvice(
      [apiLimiter, magicPerIp, magicGlobal, codePerIp, composePerIp, composeGlobal, tendPerIp,
       tendGlobal, writeCors](const drogon::HttpRequestPtr& req) -> drogon::HttpResponsePtr {
        if (req->method() == drogon::Options) return nullptr;  // preflight already answered above
        const std::string ip = clientIp(req);
        if (ip.empty()) return nullptr;  // internal / health-check traffic
        // Per-IP before global, so a hammering client never drains the shared ceiling. Drogon routes
        // case-insensitively while path() preserves casing, so compare lowercased or /V1/Compose
        // walks past the spend ceilings.
        std::string path = req->path();
        std::transform(path.begin(), path.end(), path.begin(),
                       [](unsigned char c) { return std::tolower(c); });
        // Vendor webhooks verify an HMAC first and burst from a small egress pool onto one bucket
        // here: a 429 burns a retry.
        if (path == "/v1/paddle/webhook" || path == "/v1/resend/webhook") return nullptr;
        bool ok = apiLimiter->allow(ip);
        if (ok && path == "/v1/auth/magic-link")
          ok = magicPerIp->allow(ip) && magicGlobal->allow("global");
        if (ok && path == "/v1/auth/verify-code") ok = codePerIp->allow(ip);
        if (ok && path == "/v1/compose")
          ok = composePerIp->allow(ip) && composeGlobal->allow("global");
        // Only the POST that starts a run carries the agent cost; the GET catch-up is a plain read.
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


  app.registerPostHandlingAdvice(
      [writeCors, mcpPath](const drogon::HttpRequestPtr& req, const drogon::HttpResponsePtr& resp) {
        if (req->path() == mcpPath) return;  // MCP responses carry their own origin policy (below)
        writeCors(req, resp);
      });

  // Token auth, not cookies, so no Allow-Credentials.
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
  app.registerHandler(
      "/v1/auth/verify-code",
      [authApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        authApi->verifyCode(req, std::move(cb));
      },
      {drogon::Post});
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

  // Redirects, not fetches, so no CORS.
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
  // Called while already signed in, this attaches the door instead of resolving an account.
  app.registerHandler(
      "/v1/auth/apple",
      [authApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { authApi->apple(req, std::move(cb)); },
      {drogon::Post});
  // Folds this (empty) account into the one the magic link names.
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

  // Mint returns the secret once; list is metadata only.
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

  // The bare RFC 8414 URL plus the shapes MCP clients probe before it (the path-aware variant and
  // openid-configuration, with and without the path). Each must answer JSON, or a client that tries
  // one first gets the SPA's index.html through Caddy and reads it as "no authorization support".
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

  // Separate from the session list above, so pulling a tool never signs a device out.
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


  // Anonymous allowed.
  app.registerHandler(
      "/v1/feedback",
      [feedbackApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { feedbackApi->submit(req, std::move(cb)); },
      {drogon::Post});


  // Its own preflight, advertising the MCP headers the generic one skips.
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

  // RFC 9728. Public, unauthenticated. Served at both the bare URL the 401 challenge points at and
  // the path-aware variant §3.1 derives, which is the one MCP 2025-06-18 clients probe first.
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

  RoadmapDeps roadmapDeps{
      .registry = registry, .trees = trees, .progress = progress, .progressService = progressService,
      .oplog = oplog, .bus = bus, .presence = presence, .genesis = genesis,
      .authService = authService, .forkService = forkService, .treeRegistry = treeRegistry,
      .ogImages = ogImages, .ogVideos = ogVideos, .webRoot = webRootEnv ? webRootEnv : "",
      .tendingService = tendingService, .reminderSweep = reminderSweep, .reminderRepo = reminderRepo,
      .tokens = tokens, .clock = systemClock,
      .remindersAdminToken = remindersAdminEnv ? remindersAdminEnv : "", .composer = composer,
      .allowedOrigins = allowedOrigins};
  registerRoutes(app, roadmapDeps);

  auto journalPages = std::make_shared<PgJournalRepository>(pool);
  // PageService is built after the echo stack, because a save triggers a derivation.
  // JOURNAL_NUDGE_ENABLED must say so AND the user be named in JOURNAL_NUDGE_ALLOWLIST before any
  // mail leaves; both gates are read at send time.
  const char* journalNudgeEnabledEnv = std::getenv("JOURNAL_NUDGE_ENABLED");
  const std::string journalNudgeEnabledFlag = journalNudgeEnabledEnv ? journalNudgeEnabledEnv : "";
  const char* journalNudgeAllowlistEnv = std::getenv("JOURNAL_NUDGE_ALLOWLIST");
  const char* journalNudgeAdminEnv = std::getenv("JOURNAL_NUDGE_ADMIN_TOKEN");
  auto journalNudges = std::make_shared<PgNudgeRepository>(pool);
  MailArming journalNudgeArming(journalNudgeEnabledFlag == "true" || journalNudgeEnabledFlag == "1",
                                journalNudgeAllowlistEnv ? journalNudgeAllowlistEnv : "");
  auto journalNudgeMail = std::make_shared<ResendNudgeSender>(*resendClient);
  auto journalNudgeSweep = std::make_shared<NudgeSweep>(*journalNudges, *journalNudgeMail, *tokens,
                                                        *systemClock, journalNudgeArming, appBaseUrl);
  journalNudgeSweep->start();
  // Either boundary unwired makes any echo pass a no-op: NullEmbedder and NullCurator both answer
  // configured() false. The sidecar must run the same bge-small weights the browser downloads, or a
  // server vector and an on-device one stop being interchangeable.
  const char* embedderUrlEnv = std::getenv("JOURNAL_EMBEDDER_URL");
  std::shared_ptr<Embedder> journalEmbedder;
  if (embedderUrlEnv && *embedderUrlEnv)
    journalEmbedder = std::make_shared<HttpEmbedder>(embedderUrlEnv);
  else
    journalEmbedder = std::make_shared<NullEmbedder>();

  const char* anthropicKeyEnv = std::getenv("ANTHROPIC_API_KEY");
  std::shared_ptr<Curator> journalCurator;
  if (anthropicKeyEnv && *anthropicKeyEnv)
    journalCurator = std::make_shared<AnthropicCurator>(
        std::make_shared<AnthropicClient>(anthropicKeyEnv), "claude-sonnet-5", "low",
        aiFuse, aiSpendSink);
  else
    journalCurator = std::make_shared<NullCurator>();
  // Without an Anthropic key, the line-and-sentence rule cuts the page instead.
  std::shared_ptr<Segmenter> journalSegmenter;
  if (anthropicKeyEnv && *anthropicKeyEnv)
    journalSegmenter = std::make_shared<AnthropicSegmenter>(
        std::make_shared<AnthropicClient>(anthropicKeyEnv), "claude-sonnet-5", "low", aiFuse,
        aiSpendSink);
  else
    journalSegmenter = std::make_shared<RuleSegmenter>();
  auto journalSpans = std::make_shared<PgEchoRepository>(pool);
  // The live path, the repair pass and the read layer must all hold this one object, or one of them
  // reads a staler copy.
  auto journalEchoes = std::make_shared<WarmEchoRepository>(*journalSpans, *systemClock);
  const char* journalEchoAdminEnv = std::getenv("JOURNAL_ECHO_ADMIN_TOKEN");
  auto journalEchoSweep = std::make_shared<EchoSweep>(*journalEchoes, *journalSegmenter,
                                                      *journalEmbedder, *journalCurator,
                                                      *systemClock, *entitlements,
                                                      SelectionRules{}, SweepBudget{});
  journalEchoSweep->start();
  // Derives on its own thread, never a drogon request thread: a curator call is seconds long.
  auto journalEchoDerivations =
      std::make_shared<EchoDerivations>(*journalEchoSweep, *systemClock, LiveDerivationRules{});
  journalEchoDerivations->start();
  auto pageService = std::make_shared<PageService>(*journalPages, journalEchoDerivations.get());
  // Writes nothing; holds the same corpus, embedder and curator the live path does.
  auto journalEchoExplainer = std::make_shared<EchoExplainer>(
      *journalEchoes, *journalSegmenter, *journalEmbedder, *journalCurator, *pageService);
  // Without OPENAI_API_KEY the transcriber is null and the endpoint answers 503.
  const char* openaiKeyEnv = std::getenv("OPENAI_API_KEY");
  std::shared_ptr<Transcriber> journalTranscriber;
  if (openaiKeyEnv && *openaiKeyEnv)
    journalTranscriber =
        std::make_shared<OpenAiTranscriber>(openaiKeyEnv, "gpt-4o-transcribe", aiFuse, aiSpendSink);
  else journalTranscriber = std::make_shared<NullTranscriber>();
  journal::JournalDeps journalDeps{.pageService = pageService, .authService = authService,
                                   .nudges = journalNudges, .nudgeSweep = journalNudgeSweep,
                                   .tokens = tokens, .clock = systemClock,
                                   .nudgeAdminToken = journalNudgeAdminEnv ? journalNudgeAdminEnv : "",
                                   .echoes = journalEchoes, .echoSweep = journalEchoSweep,
                                   .echoExplainer = journalEchoExplainer,
                                   .echoAdminToken = journalEchoAdminEnv ? journalEchoAdminEnv : "",
                                   .transcriber = journalTranscriber, .entitlements = entitlements};
  journal::registerRoutes(app, journalDeps);

  gym::GymDeps gymDeps{.trainingService = gymTrainingService,
                       .catalogService = gymCatalogService,
                       .programService = gymProgramService,
                       .preferencesService = gymPreferencesService,
                       .threadService = gymThreadService,
                       .authService = authService,
                       .askService = gymAsk,
                       .appBaseUrl = appBaseUrl};
  gym::registerRoutes(app, gymDeps);

  // EVERY product that sends mail must appear in this list, or it keeps mailing an address the
  // provider has already called dead. An empty secret refuses every delivery (Svix retries): set
  // the secret FIRST, then register the endpoint in Resend, or every genuine delivery burns a retry.
  const char* resendWebhookSecretEnv = std::getenv("RESEND_WEBHOOK_SECRET");
  auto resendWebhookApi = std::make_shared<ResendWebhookApi>(
      std::vector<MailStream>{{"roadmap reminder", reminderRepo}, {"journal nudge", journalNudges}},
      systemClock, resendWebhookSecretEnv ? resendWebhookSecretEnv : "");
  app.registerHandler(
      "/v1/resend/webhook",
      [resendWebhookApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        resendWebhookApi->webhook(req, std::move(cb));
      },
      {drogon::Post});

  const char* portEnv = std::getenv("PORT");
  int port = portEnv ? std::atoi(portEnv) : 8080;
  LOG_INFO << "windmill-backend listening on :" << port;
  app.setClientMaxBodySize(8 * 1024 * 1024);         // backstop cap; a full PUT document can be large
  app.setClientMaxMemoryBodySize(1 * 1024 * 1024);
  app.setMaxConnectionNum(20000);                    // global socket ceiling (all arrive via Caddy)
  app.addListener("0.0.0.0", port).setThreadNum(ioThreads).run();
  return 0;
}

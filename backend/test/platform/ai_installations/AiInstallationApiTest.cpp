#include "platform/ai_installations/AiInstallationApi.h"
#include "platform/adapters/http/AccessLog.h"
#include "platform/adapters/http/WriteRoutes.h"
#include "platform/adapters/crypto/OpenSslTokenGenerator.h"
#include "platform/adapters/json/AiBudgetJson.h"
#include "platform/adapters/llm/AiCallBudget.h"
#include "platform/adapters/llm/AnthropicClient.h"
#include "test/DrogonLoopback.h"
#include "test/platform/Fakes.h"
#include "test/platform/FakeAiBudgetRepository.h"
#include "test/testing.h"

#include <map>

using namespace wm;
using namespace wm::fake;

namespace {

struct InstallationRows : AiInstallationRepository {
  std::map<std::string, AiInstallationRow> rows;
  std::vector<AiInstallationNetwork> networks;
  bool fail = false;
  std::optional<AiInstallationRow> find(const std::string& digest) override {
    if (fail) throw std::runtime_error("private_installation_detail");
    const auto row = rows.find(digest);
    if (row == rows.end()) return std::nullopt;
    return row->second;
  }
  AiInstallationCode issue(const AiInstallationRow& row, const AiInstallationNetwork& network) override {
    if (fail) throw std::runtime_error("private_installation_detail");
    rows.emplace(row.tokenDigest, row);
    networks.push_back(network);
    return AiInstallationCode::Ok;
  }
  AiInstallationCode admit(const std::string&, const std::string&, const AiInstallationNetwork& network, long long) override {
    networks.push_back(network);
    return AiInstallationCode::Ok;
  }
  void prune(long long) override {}
};

struct InstallationFailures : FailureReporter {
  std::vector<std::string> reports;
  void report(const std::string&, const std::string& where, const std::string&) override { reports.push_back(where); }
  void reportWrite(const std::string& operation, const std::string&, const std::string&,
                   const std::string&, const std::string&, const std::string&) override { reports.push_back(operation); }
};

}

TEST(ai_installation_network_identity_is_canonical_and_never_trusts_ambiguous_headers) {
  CHECK_EQ(aiInstallationClientAddress({}, "127.0.0.1", AiInstallationProxy::Direct), std::optional<std::string>{"127.0.0.1"});
  CHECK_EQ(aiInstallationClientAddress({}, "::ffff:192.0.2.1", AiInstallationProxy::Direct), std::optional<std::string>{"192.0.2.1"});
  CHECK_EQ(aiInstallationClientAddress({{"CF-Connecting-IP", " 2001:0DB8:0:0:0:0:0:1 \t"}}, "127.0.0.1", AiInstallationProxy::Cloudflare),
           std::optional<std::string>{"2001:db8::"});
  for (const auto& headers : std::vector<sync::HeaderOccurrences>{
      {}, {{"CF-Connecting-IP", ""}}, {{"CF-Connecting-IP", "192.0.2.1, 192.0.2.2"}},
      {{"CF-Connecting-IP", "192.0.2.1"}, {"cf-connecting-ip", "192.0.2.1"}},
      {{"CF-Connecting-IP", "[::1]"}}, {{"CF-Connecting-IP", "::1%lo0"}},
      {{"CF-Connecting-IP", "192.0.2.1:443"}}, {{"X-Forwarded-For", "192.0.2.1"}},
      {{"CF-Connecting-IP", std::string("192.0.2.1\0private", 17)}}}) {
    CHECK_FALSE(aiInstallationClientAddress(headers, "127.0.0.1", AiInstallationProxy::Cloudflare));
  }
  for (const std::string header : {"Forwarded", "X-Forwarded-For", "CF-Connecting-IP"})
    CHECK_FALSE(aiInstallationClientAddress({{header, "192.0.2.1"}}, "127.0.0.1", AiInstallationProxy::Direct));
  CHECK_FALSE(aiInstallationClientAddress({}, "", AiInstallationProxy::Direct));
  CHECK_EQ(aiInstallationNetworkAddress("2001:db8:1234:5678::1"), aiInstallationNetworkAddress("2001:db8:1234:5678:ffff:ffff:ffff:ffff"));
  CHECK(aiInstallationNetworkAddress("2001:db8:1234:5678::1") != aiInstallationNetworkAddress("2001:db8:1234:5679::1"));
  CHECK_EQ(aiInstallationNetworkAddress("::ffff:192.0.2.1"), aiInstallationNetworkAddress("192.0.2.1"));
}

TEST(ai_installation_headers_never_downgrade_invalid_accounts_or_mint_over_existing_credentials) {
  FakeAuthRepository accounts;
  FakeEmail email;
  FakeTokens authTokens;
  OpenSslTokenGenerator installationTokens;
  FakeClock clock;
  clock.now = 1'792'281'600'000;
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, authTokens, clock};
  FakeAccountFootprint footprint;
  FakeSessionRevocations revocations;
  auto auth = std::make_shared<AuthService>(accounts, email, authTokens, clock, oauth, footprint,
                                           revocations, "https://windmill.works");
  const User account{UserId{"44444444-4444-4444-4444-444444444444"}, Email{"test@example.test"}, "Test", {}};
  accounts.usersById[account.id.str()] = account;
  accounts.insertSession(authTokens.digestOf("valid-account"), account.id, clock.now + 1'000'000, "", "", clock.now);
  FakeAiBudgetRepository budgetRows;
  const AiBudgetLimits limits;
  auto budgets = std::make_shared<AiBudgetService>(budgetRows, [=] { return limits; }, [&] { return clock.now; });
  FakeSubscriptionRepository subscriptions;
  FakeAiUsageRepository usage;
  auto entitlements = std::make_shared<Entitlements>(subscriptions, usage, "", std::vector<std::string>{}, budgets);
  InstallationRows rows;
  auto installations = std::make_shared<AiInstallations>(rows, budgets, installationTokens, clock, std::string(32, 'k'));
  auto failures = std::make_shared<InstallationFailures>();
  AiInstallationApi api{installations, auth, entitlements, failures, AiInstallationProxy::Direct};
  wm::test::DrogonLoopback::Connection wire;
  const auto request = [&](const std::string& headers, const std::string& path = "/v1/ai/installations") {
    return wire.exchange("POST " + path + " HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\n" + headers + "\r\n{}").request;
  };
  drogon::HttpResponsePtr response;
  api.issue(request(""), [&](const auto& value) { response = value; });
  REQUIRE(response);
  REQUIRE(response->getJsonObject());
  CHECK_EQ(response->getStatusCode(), drogon::k201Created);
  const auto issued = *response->getJsonObject();
  const auto token = issued["credential"].asString();
  REQUIRE(validAiInstallationCredential(token));
  CHECK_EQ(rows.rows.size(), std::size_t{1});
  CHECK_FALSE(rows.rows.begin()->second.tokenDigest == token);
  auto expected = Json::Value(Json::objectValue);
  expected["credential"] = token;
  expected["bound"] = false;
  expected["allowance"] = aiAllowanceJson(installations->allowance(*installations->authenticate(token)));
  CHECK(issued == expected);
  CHECK_EQ(response->getHeader("cache-control"), std::string{"no-store"});
  const std::string installation = "X-Windmill-Installation: " + token + "\r\n";
  for (const std::string headers : std::vector<std::string>{
      "X-Windmill-Installation: invalid\r\n", installation + installation,
      installation + "Authorization: Bearer invalid\r\n",
      installation + "Authorization: Bearer valid-account\r\nAuthorization: Bearer valid-account\r\n",
      installation + "Authorization: Bearer valid-account\r\nCookie: wm_session=invalid\r\n"}) {
    const auto incoming = request(headers);
    REQUIRE(incoming);
    CHECK_FALSE(api.resolve(incoming).refusal.empty());
    api.issue(incoming, [&](const auto& value) { response = value; });
    CHECK_EQ(response->getStatusCode(), drogon::k401Unauthorized);
    CHECK_EQ(rows.rows.size(), std::size_t{1});
  }
  api.issue(request(installation), [&](const auto& value) { response = value; });
  CHECK_EQ(response->getStatusCode(), drogon::k409Conflict);
  api.bind(request(installation + "Authorization: Bearer valid-account\r\n"), [&](const auto& value) { response = value; });
  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  expected.removeMember("credential");
  expected["bound"] = true;
  expected["allowance"] = aiAllowanceJson(entitlements->aiAllowanceView(account.id, account.email.value));
  CHECK(*response->getJsonObject() == expected);
  api.bind(request(installation + "Authorization: Bearer valid-account\r\n"), [&](const auto& value) { response = value; });
  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK(*response->getJsonObject() == expected);
  const auto principal = installations->authenticate(token);
  REQUIRE(principal);
  CHECK_EQ(principal->boundAccount(), std::optional<std::string>{account.id.str()});
  CHECK_EQ(installations->admitGeneration(*principal, "request", "127.0.0.1"), AiInstallationCode::DeviceBound);
  CHECK_EQ(installations->bind(*principal, UserId{"55555555-5555-5555-5555-555555555555"}), AiBudgetCode::Conflict);
  rows.fail = true;
  api.current(request(installation), [&](const auto& value) { response = value; });
  CHECK_EQ(response->getStatusCode(), drogon::k503ServiceUnavailable);
  CHECK_EQ(failures->reports, (std::vector<std::string>{"ai.installation.read"}));
  CHECK_EQ(rows.rows.size(), std::size_t{1});
}

TEST(ai_installation_binding_survives_disabled_anonymous_admission_without_a_network_secret) {
  FakeAuthRepository accounts;
  FakeEmail email;
  FakeTokens authTokens;
  OpenSslTokenGenerator installationTokens;
  FakeClock clock;
  clock.now = 1'792'281'600'000;
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, authTokens, clock};
  FakeAccountFootprint footprint;
  FakeSessionRevocations revocations;
  auto auth = std::make_shared<AuthService>(accounts, email, authTokens, clock, oauth, footprint,
                                           revocations, "https://windmill.works");
  const User account{UserId{"44444444-4444-4444-4444-444444444444"}, Email{"test@example.test"}, "Test", {}};
  accounts.usersById[account.id.str()] = account;
  accounts.insertSession(authTokens.digestOf("valid-account"), account.id, clock.now + 1'000'000, "", "", clock.now);
  FakeAiBudgetRepository budgetRows;
  const AiBudgetLimits limits;
  auto budgets = std::make_shared<AiBudgetService>(budgetRows, [=] { return limits; }, [&] { return clock.now; });
  FakeSubscriptionRepository subscriptions;
  FakeAiUsageRepository usage;
  auto entitlements = std::make_shared<Entitlements>(subscriptions, usage, "", std::vector<std::string>{}, budgets);
  InstallationRows rows;
  AiInstallations enabled{rows, budgets, installationTokens, clock, std::string(32, 'k')};
  const auto bound = enabled.issue("192.0.2.1");
  const auto unbound = enabled.issue("192.0.2.1");
  REQUIRE(bound.principal);
  REQUIRE(unbound.principal);
  REQUIRE(enabled.bind(*bound.principal, account.id) == AiBudgetCode::Ok);

  auto disabled = std::make_shared<AiInstallations>(rows, budgets, installationTokens, clock);
  CHECK_FALSE(disabled->anonymousEnabled());
  for (const std::string invalidKey : {std::string{}, std::string(31, 'k')}) {
    bool refused = false;
    try { AiInstallations invalid{rows, budgets, installationTokens, clock, invalidKey}; }
    catch (const std::invalid_argument&) { refused = true; }
    CHECK(refused);
  }
  auto failures = std::make_shared<InstallationFailures>();
  AiInstallationApi api{disabled, auth, entitlements, failures, AiInstallationProxy::Direct};
  wm::test::DrogonLoopback::Connection wire;
  const auto request = [&](const std::string& headers) {
    return wire.exchange("POST /v1/ai/installations HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\n" + headers + "\r\n{}").request;
  };
  drogon::HttpResponsePtr response;
  for (const auto& credential : {bound.credential, unbound.credential, unbound.credential}) {
    const std::string installation = "X-Windmill-Installation: " + credential + "\r\n";
    api.bind(request(installation + "Authorization: Bearer valid-account\r\n"), [&](const auto& value) { response = value; });
    REQUIRE(response);
    REQUIRE(response->getJsonObject());
    CHECK_EQ(response->getStatusCode(), drogon::k200OK);
    Json::Value expected(Json::objectValue);
    expected["bound"] = true;
    expected["allowance"] = aiAllowanceJson(entitlements->aiAllowanceView(account.id, account.email.value));
    CHECK(*response->getJsonObject() == expected);
    api.current(request(installation), [&](const auto& value) { response = value; });
    CHECK_EQ(response->getStatusCode(), drogon::k200OK);
    const auto principal = disabled->authenticate(credential);
    REQUIRE(principal);
    expected["allowance"] = aiAllowanceJson(disabled->allowance(*principal));
    CHECK(*response->getJsonObject() == expected);
    CHECK_EQ(disabled->admitGeneration(*principal, "request", "192.0.2.1"), AiInstallationCode::Unavailable);
  }
  api.issue(request(""), [&](const auto& value) { response = value; });
  CHECK_EQ(response->getStatusCode(), drogon::k503ServiceUnavailable);
  CHECK_EQ((*response->getJsonObject())["code"].asString(), std::string{"anonymous_ai_unavailable"});
  CHECK_EQ(disabled->issue("192.0.2.1").code, AiInstallationCode::Unavailable);
  CHECK_EQ(disabled->bind(*bound.principal, UserId{"55555555-5555-5555-5555-555555555555"}), AiBudgetCode::Conflict);
  CHECK_EQ(rows.rows.size(), std::size_t{2});
  CHECK_EQ(rows.networks.size(), std::size_t{2});
  CHECK(budgetRows.reservations.empty());
  CHECK(failures->reports.empty());
}

// One request is one completion, the route's: an expected refusal is one WARN line under door `rest`, and its access-log
// line a warning; a storage failure is one failed line and one Issue, under the same operation.
TEST(ai_installation_issue_completes_once_under_its_route) {
  FakeAuthRepository accounts;
  FakeEmail email;
  FakeTokens authTokens;
  OpenSslTokenGenerator installationTokens;
  FakeClock clock;
  clock.now = 1'792'281'600'000;
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, authTokens, clock};
  FakeAccountFootprint footprint;
  FakeSessionRevocations revocations;
  auto auth = std::make_shared<AuthService>(accounts, email, authTokens, clock, oauth, footprint,
                                           revocations, "https://windmill.works");
  FakeAiBudgetRepository budgetRows;
  const AiBudgetLimits limits;
  auto budgets = std::make_shared<AiBudgetService>(budgetRows, [=] { return limits; }, [&] { return clock.now; });
  FakeSubscriptionRepository subscriptions;
  FakeAiUsageRepository usage;
  auto entitlements = std::make_shared<Entitlements>(subscriptions, usage, "", std::vector<std::string>{}, budgets);
  InstallationRows rows;
  auto failures = std::make_shared<InstallationFailures>();
  std::vector<WriteCompletion> lines;
  installWriteSink([&](const WriteCompletion& completion) { lines.push_back(completion); });
  installWriteReporter(failures);
  wm::test::DrogonLoopback::Connection wire;
  const WriteRoute route{"/v1/ai/installations", "ai.installation.issue", "platform", "rest", {drogon::Post}};
  const auto issue = [&](AiInstallationApi& api) {
    const auto request = wire.exchange("POST /v1/ai/installations HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n"
                                       "Content-Length: 2\r\n\r\n{}").request;
    auto handler = [&api](const drogon::HttpRequestPtr& incoming, WriteHttpCallback&& reply) { api.issue(incoming, std::move(reply)); };
    drogon::HttpResponsePtr response;
    detail::ObservedHttpHandler<decltype(&decltype(handler)::operator())>::wrap(route, handler)(
        request, [&](const drogon::HttpResponsePtr& value) { response = value; });
    return std::make_pair(request, response);
  };

  AiInstallationApi disabled{std::make_shared<AiInstallations>(rows, budgets, installationTokens, clock), auth, entitlements,
                             failures, AiInstallationProxy::Direct};
  const auto [refusing, refused] = issue(disabled);
  REQUIRE(refused);
  CHECK_EQ(refused->getStatusCode(), drogon::k503ServiceUnavailable);
  CHECK(accessSeverity(refused, writeOperation(refusing)) == Severity::warn);
  REQUIRE_EQ(lines.size(), std::size_t{1});
  CHECK_EQ(lines[0].operation, std::string{"ai.installation.issue"});
  CHECK_EQ(lines[0].product, std::string{"platform"});
  CHECK_EQ(lines[0].door, std::string{"rest"});
  CHECK_EQ(lines[0].outcome, std::string{"anonymous_ai_unavailable"});
  CHECK(lines[0].severity == WriteSeverity::warn);
  CHECK(failures->reports.empty());

  AiInstallationApi enabled{std::make_shared<AiInstallations>(rows, budgets, installationTokens, clock, std::string(32, 'k')), auth,
                            entitlements, failures, AiInstallationProxy::Direct};
  rows.fail = true;
  const auto [failing, failed] = issue(enabled);
  REQUIRE(failed);
  CHECK_EQ(failed->getStatusCode(), drogon::k503ServiceUnavailable);
  CHECK(accessSeverity(failed, writeOperation(failing)) == Severity::error);
  REQUIRE_EQ(lines.size(), std::size_t{2});
  CHECK_EQ(lines[1].operation, std::string{"ai.installation.issue"});
  CHECK_EQ(lines[1].door, std::string{"rest"});
  CHECK_EQ(lines[1].outcome, std::string{"failed"});
  CHECK(lines[1].severity == WriteSeverity::error);
  CHECK_EQ(failures->reports, (std::vector<std::string>{"ai.installation.issue"}));
  installWriteSink({});
  installWriteReporter({});
}

TEST(ai_installation_budget_is_explicit_and_keeps_legacy_anonymous_calls_closed) {
  FakeClock clock;
  clock.now = 1'792'281'600'000;
  OpenSslTokenGenerator tokens;
  FakeAiBudgetRepository rows;
  const AiBudgetLimits limits;
  auto budgets = std::make_shared<AiBudgetService>(rows, [=] { return limits; }, [&] { return clock.now; });
  InstallationRows installationRows;
  AiInstallations installations{installationRows, budgets, tokens, clock, std::string(32, 'k')};
  const auto issued = installations.issue("192.0.2.1");
  REQUIRE(issued.principal);
  FakeAuthRepository accounts;
  FakeSubscriptionRepository subscriptions;
  FakeAiUsageRepository usage;
  Entitlements entitlements{subscriptions, usage, {}, {}, budgets};
  InstallationFailures failures;
  AiCallBudget budget{budgets, entitlements, accounts, failures};
  AiSpend spend;
  spend.product = "gym";
  spend.operation = "coach.preview";
  spend.model = "claude-opus-5";
  MessagesRequest request;
  request.model = spend.model;
  request.system = "Return a routine";
  request.user = "Two sessions";
  request.maxTokens = 2000;
  CHECK_EQ(budget.begin(spend, messagesBody(request), 1024).refusal, std::string{"device_verification_required"});
  auto admission = budget.beginInstallation(*issued.principal, spend, messagesBody(request), 1024);
  REQUIRE(admission.reservation);
  CHECK_EQ(admission.reservation->subject, (AiBudgetSubject{AiBudgetSubjectKind::Device, issued.principal->id()}));
  CHECK_EQ(admission.reservation->tier, AiBudgetTier::Anonymous);
  REQUIRE(admission.reservation->outputBudget);
  const auto selected = admission.reservation->outputBudget->tokensFor(admission.reservation->amountNanos);
  REQUIRE(selected);
  CHECK(*selected >= 1024 && *selected < request.maxTokens);
  request.maxTokens = *selected;
  CHECK_EQ(anthropicReservationNanos(messagesBody(request)), std::optional<long long>{admission.reservation->amountNanos});
  Json::Value charged(Json::objectValue);
  charged["input_tokens"] = 100;
  charged["output_tokens"] = 200;
  charged["cache_read_input_tokens"] = 0;
  charged["cache_creation_input_tokens"] = 0;
  budget.finish(*admission.reservation, spend.model, charged, AiCallEnd::settled);
  CHECK_EQ(rows.reservations.at(admission.reservation->id).actualNanos, std::optional<long long>{5'500'000});
  CHECK_EQ(installations.bind(*issued.principal, UserId{"44444444-4444-4444-4444-444444444444"}), AiBudgetCode::Ok);
  CHECK_EQ(budget.beginInstallation(*issued.principal, spend, messagesBody(request), 1024).refusal, std::string{"device_bound"});
  spend.user = UserId{"44444444-4444-4444-4444-444444444444"};
  CHECK_EQ(budget.beginInstallation(*issued.principal, spend, messagesBody(request), 1024).refusal, std::string{"invalid_installation_principal"});
}

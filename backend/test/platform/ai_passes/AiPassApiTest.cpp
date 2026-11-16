#include "platform/ai_passes/AiPassApi.h"
#include "platform/adapters/crypto/OpenSslTokenGenerator.h"
#include "platform/adapters/http/WriteRoutes.h"
#include "test/DrogonLoopback.h"
#include "test/platform/Fakes.h"
#include "test/platform/FakeAiBudgetRepository.h"
#include "test/testing.h"
#include <openssl/evp.h>
#include <sstream>

using namespace wm;
using namespace wm::fake;

namespace {

struct PassRows : AiInstallationRepository {
  std::map<std::string, AiInstallationRow> rows;
  std::vector<AiInstallationNetwork> admissions;
  bool fail = false;
  std::optional<AiInstallationRow> find(const std::string& digest) override {
    if (fail) throw std::runtime_error("PRIVATE installation and request detail");
    const auto row = rows.find(digest);
    if (row == rows.end()) return std::nullopt;
    return row->second;
  }
  AiInstallationCode issue(const AiInstallationRow& row, const AiInstallationNetwork&) override {
    rows.emplace(row.tokenDigest, row);
    return AiInstallationCode::Ok;
  }
  AiInstallationCode admit(const std::string&, const std::string&, const AiInstallationNetwork& network, long long) override {
    if (admissions.size() >= static_cast<std::size_t>(network.limit)) return AiInstallationCode::RateLimited;
    admissions.push_back(network);
    return AiInstallationCode::Ok;
  }
  void prune(long long) override {}
};

struct PassFailures : FailureReporter {
  std::vector<std::string> reports;
  void report(const std::string&, const std::string& operation, const std::string& detail) override { reports.push_back(operation + ":" + detail); }
};

struct PassFixture {
  FakeAuthRepository accounts;
  FakeEmail email;
  FakeTokens authTokens;
  OpenSslTokenGenerator tokens;
  FakeClock clock;
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, authTokens, clock};
  FakeAccountFootprint footprint;
  FakeSessionRevocations revocations;
  std::shared_ptr<AuthService> auth = std::make_shared<AuthService>(accounts, email, authTokens, clock, oauth, footprint, revocations, "https://windmill.works");
  FakeAiBudgetRepository budgetRows;
  std::shared_ptr<AiBudgetService> budgets = std::make_shared<AiBudgetService>(budgetRows, [] { return AiBudgetLimits{}; }, [this] { return clock.now; });
  FakeEntitlementCopy subscriptions;
  FakeAiUsageRepository usage;
  std::shared_ptr<Entitlements> entitlements = std::make_shared<Entitlements>(subscriptions, clock, usage, Allowlists{}, std::vector<std::string>{}, budgets);
  PassRows rows;
  std::shared_ptr<AiInstallations> installations = std::make_shared<AiInstallations>(rows, budgets, tokens, clock, std::string(32, 'k'));
  std::shared_ptr<AiPasses> passes = std::make_shared<AiPasses>("nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A", "test-rfc8032", "development", R"({"gym.coach":2})");
  std::shared_ptr<RateLimiter> limiter = std::make_shared<RateLimiter>(0.0, 200.0);
  std::shared_ptr<PassFailures> failures = std::make_shared<PassFailures>();
  AiPassApi api{passes, auth, installations, entitlements, limiter, clock, {"https://windmill.works"}, AiInstallationProxy::Direct};
  wm::test::DrogonLoopback::Connection wire;
  std::vector<WriteCompletion> completions;
  const User account{UserId{"44444444-4444-4444-4444-444444444444"}, Email{"private@example.test"}, "Private name", {}};

  explicit PassFixture(Allowlists lists = {})
      : entitlements(std::make_shared<Entitlements>(subscriptions, clock, usage, std::move(lists), std::vector<std::string>{}, budgets)) {
    clock.now = 1'800'000'000'000;
    accounts.usersById[account.id.str()] = account;
    accounts.insertSession(authTokens.digestOf("session"), account.id, clock.now + 1'000'000, "", "", clock.now);
    installWriteReporter(failures);
    installWriteSink([this](const auto& completion) { completions.push_back(completion); });
  }
  ~PassFixture() { installWriteSink({}); installWriteReporter({}); }

  drogon::HttpResponsePtr call(const std::string& headers, const std::string& body = R"({"client":"web","use":"gym.coach","version":2})",
                             const std::string& contentType = "Content-Type: application/json\r\n") {
    const auto request = wire.exchange("POST /v1/ai/passes HTTP/1.1\r\nHost: localhost\r\n" + contentType +
        "Content-Length: " + std::to_string(body.size()) + "\r\n" + headers + "\r\n" + body).request;
    if (!request) throw std::runtime_error("pass request did not parse");
    beginWriteRequest(request, {"/v1/ai/passes", "ai.pass.sign", "platform", "rest", {drogon::Post}});
    drogon::HttpResponsePtr response;
    observeHttpWork(request, [&] { api.sign(request, [&](const auto& result) { response = result; }); });
    finishWriteRequest(request, response);
    CHECK_EQ(response->getHeader("cache-control"), "no-store");
    return response;
  }
};

Json::Value claims(const drogon::HttpResponsePtr& response) {
  const std::string token = (*response->getJsonObject())["pass"].asString();
  const auto start = token.find('.', std::string("wm-pass.v1.").size()) + 1;
  std::string encoded = token.substr(start, token.find('.', start) - start);
  std::replace(encoded.begin(), encoded.end(), '-', '+');
  std::replace(encoded.begin(), encoded.end(), '_', '/');
  while (encoded.size() % 4) encoded += '=';
  std::string decoded(encoded.size(), '\0');
  const int count = EVP_DecodeBlock(reinterpret_cast<unsigned char*>(decoded.data()), reinterpret_cast<const unsigned char*>(encoded.data()), encoded.size());
  const auto padding = encoded.ends_with("==") ? 2 : encoded.ends_with("=") ? 1 : 0;
  decoded.resize(count - padding);
  Json::Value value;
  std::istringstream(decoded) >> value;
  return value;
}

}

TEST(ai_pass_accounts_and_installations_have_exact_claims_and_one_private_observation) {
  PassFixture fixture;
  const auto issued = fixture.installations->issue("127.0.0.1");
  REQUIRE(issued.principal);
  const auto account = fixture.call("Authorization: Bearer session\r\n");
  REQUIRE(account->statusCode() == drogon::k200OK);
  Json::Value expected;
  std::istringstream(R"({"aud":"ai","env":"development","iat":1800000000000,"exp":1800000600000,"sub":{"account":"44444444-4444-4444-4444-444444444444"},"plan":"none","client":"web"})") >> expected;
  CHECK(claims(account) == expected);
  CHECK_EQ((*account->getJsonObject())["expiresIn"].asInt64(), 600'000);
  const std::string installation = "X-Windmill-Installation: " + issued.credential + "\r\n";
  CHECK(claims(fixture.call("Authorization: Bearer session\r\n" + installation)) == expected);
  CHECK_EQ(fixture.installations->bind(*issued.principal, fixture.account.id), AiBudgetCode::Ok);
  expected["installation"] = issued.principal->id();
  CHECK(claims(fixture.call("Authorization: Bearer session\r\n" + installation)) == expected);
  CHECK_EQ((*fixture.call(installation)->getJsonObject())["code"].asString(), "device_bound");
  const auto anonymous = fixture.installations->issue("127.0.0.1");
  REQUIRE(anonymous.principal);
  expected.removeMember("plan"); expected.removeMember("installation"); expected["sub"].removeMember("account");
  expected["sub"]["installation"] = anonymous.principal->id();
  const auto anonymousAnswer = fixture.call("X-Windmill-Installation: " + anonymous.credential + "\r\n");
  CHECK(claims(anonymousAnswer) == expected);
  CHECK_EQ(fixture.rows.admissions.size(), std::size_t{1});
  CHECK_EQ(fixture.rows.admissions.front().limit, 30);
  std::size_t passCompletions = 0;
  for (const auto& completion : fixture.completions) {
    if (completion.operation != "ai.pass.sign") continue;
    ++passCompletions;
    const auto line = writeCompletionJson(completion);
    for (const auto& privateValue : {fixture.account.id.str(), fixture.account.email.value, issued.credential, anonymous.principal->id(), (*account->getJsonObject())["pass"].asString()})
      CHECK_EQ(line.find(privateValue), std::string::npos);
  }
  CHECK_EQ(passCompletions, std::size_t{5});
  CHECK(fixture.completions.back().metadata == (std::map<std::string, std::string>{{"client", "web"}, {"use", "gym.coach"}, {"version", "2"}, {"principal", "installation"}, {"plan", "none"}}));
  CHECK(fixture.failures->reports.empty());
}

TEST(ai_pass_authentication_transport_and_json_refusals_never_fall_back) {
  PassFixture fixture;
  const auto issued = fixture.installations->issue("127.0.0.1");
  const std::string installation = "X-Windmill-Installation: " + issued.credential + "\r\n";
  for (const auto& [headers, code] : std::vector<std::pair<std::string, std::string>>{
      {"", "unauthenticated"}, {installation + "Authorization: Bearer invalid\r\n", "unauthenticated"},
      {installation + "Authorization: Bearer session\r\nAuthorization: Bearer session\r\n", "unauthenticated"},
      {installation + installation + "Authorization: Bearer session\r\n", "invalid_installation"},
      {"X-Windmill-Installation: invalid\r\nAuthorization: Bearer session\r\n", "invalid_installation"},
      {"Cookie: wm_session=session\r\n", "untrusted-origin"},
      {"Cookie: wm_session=session\r\nOrigin: https://evil.example\r\n", "untrusted-origin"},
      {"Cookie: wm_session=session\r\nOrigin: https://windmill.works\r\nOrigin: https://windmill.works\r\n", "untrusted-origin"},
      {"Cookie: wm_session=session; wm_session=session\r\nOrigin: https://windmill.works\r\n", "unauthenticated"},
      {"Authorization: Bearer session\r\nCookie: wm_session=invalid\r\nOrigin: https://windmill.works\r\n", "unauthenticated"}})
    CHECK_EQ((*fixture.call(headers)->getJsonObject())["code"].asString(), code);
  for (const auto& body : {R"({"client":"web","use":"gym.coach","version":2,"version":2})", R"({"client":"web","use":"unknown","version":2})"}) {
    CHECK_EQ((*fixture.call("Authorization: Bearer session\r\n", body)->getJsonObject())["code"].asString(), "invalid_request");
    CHECK(fixture.completions.back().metadata.empty());
  }
  CHECK_EQ((*fixture.call("Authorization: Bearer session\r\n", R"({"client":"web","use":"gym.coach","version":1})")->getJsonObject())["code"].asString(), "client-update-required");
  CHECK(fixture.completions.back().metadata == (std::map<std::string, std::string>{{"client", "web"}, {"use", "gym.coach"}, {"version", "1"}}));
  CHECK_EQ((*fixture.call("Authorization: Bearer session\r\n", "{}", "Content-Type: text/plain\r\n")->getJsonObject())["code"].asString(), "unsupported-media-type");
  CHECK_EQ(fixture.call("Cookie: wm_session=session\r\nOrigin: https://windmill.works\r\n")->statusCode(), drogon::k200OK);
  CHECK(fixture.rows.admissions.empty());
  CHECK(fixture.failures->reports.empty());
}

TEST(ai_pass_rate_limits_and_technical_failures_are_distinct) {
  PassFixture fixture;
  const auto issued = fixture.installations->issue("127.0.0.1");
  for (int index = 0; index < 30; ++index)
    CHECK_EQ(fixture.call("X-Windmill-Installation: " + issued.credential + "\r\n")->statusCode(), drogon::k200OK);
  CHECK_EQ((*fixture.call("X-Windmill-Installation: " + issued.credential + "\r\n")->getJsonObject())["code"].asString(), "rate_limited");
  CHECK(fixture.failures->reports.empty());
  fixture.rows.fail = true;
  CHECK_EQ(fixture.call("X-Windmill-Installation: " + issued.credential + "\r\n")->statusCode(), drogon::k503ServiceUnavailable);
  REQUIRE(fixture.failures->reports.size() == 1);
  CHECK(fixture.failures->reports.front().starts_with("ai-pass:"));
  CHECK_EQ(fixture.failures->reports.front().find("PRIVATE"), std::string::npos);
  CHECK_EQ(fixture.completions.back().operation, "ai.pass.sign");
  CHECK_EQ(fixture.completions.back().outcome, "failed");
}

TEST(ai_pass_entitlement_claims_do_not_fund_owner_or_sandbox_allowances) {
  for (const bool owner : {false, true}) {
    PassFixture fixture{owner ? Allowlists{.owners = EmailList{"private@example.test"}} : Allowlists{.sandboxTesters = EmailList{"private@example.test"}}};
    if (!owner) fixture.subscriptions.plant(fixture.account.id, std::nullopt, fixture.clock.now + 60'000);
    const auto response = fixture.call("Authorization: Bearer session\r\n");
    REQUIRE(response->statusCode() == drogon::k200OK);
    Json::Value expected;
    std::istringstream(R"({"aud":"ai","env":"development","iat":1800000000000,"exp":1800000600000,"sub":{"account":"44444444-4444-4444-4444-444444444444"},"plan":"one","ownerGrant":true,"client":"web"})") >> expected;
    CHECK(claims(response) == expected);
    CHECK(fixture.budgetRows.grants.empty());
  }
}

TEST(ai_pass_principal_limit_is_separate_from_installation_address_limit) {
  PassFixture fixture;
  AiPassApi limited{fixture.passes, fixture.auth, fixture.installations, fixture.entitlements,
      std::make_shared<RateLimiter>(0.0, 1.0), fixture.clock, {"https://windmill.works"}, AiInstallationProxy::Direct};
  const std::string body = R"({"client":"web","use":"gym.coach","version":2})";
  for (int index = 0; index < 2; ++index) {
    const auto request = fixture.wire.exchange("POST /v1/ai/passes HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nAuthorization: Bearer session\r\nContent-Length: " + std::to_string(body.size()) + "\r\n\r\n" + body).request;
    REQUIRE(request);
    drogon::HttpResponsePtr response;
    limited.sign(request, [&](const auto& answer) { response = answer; });
    CHECK_EQ(response->statusCode(), index == 0 ? drogon::k200OK : drogon::k429TooManyRequests);
    if (index == 1) CHECK_EQ((*response->getJsonObject())["code"].asString(), "rate_limited");
  }
  CHECK(fixture.rows.admissions.empty());
}

#include "platform/adapters/http/AuthApi.h"
#include "platform/adapters/http/WriteRoutes.h"
#include "platform/adapters/sentry/SentryClient.h"
#include "test/platform/Fakes.h"
#include "test/testing.h"

#include <json/json.h>

using namespace wm;
using namespace wm::fake;

namespace {
struct ClosureHttp {
  struct Revocations : FakeSessionRevocations {
    bool fail = false;
    void revoked(const std::vector<std::string>& values) override {
      FakeSessionRevocations::revoked(values);
      if (fail) throw std::runtime_error("private postcommit notification fault");
    }
  };
  FakeAuthRepository repo;
  FakeEmail email;
  FakeTokens tokens;
  FakeClock clock;
  FakeOAuthRepository grants;
  OAuthService oauth{grants, tokens, clock};
  FakeAccountFootprint footprint;
  Revocations revoked;
  std::shared_ptr<AuthService> auth = std::make_shared<AuthService>(repo, email, tokens, clock, oauth, footprint, revoked, "https://windmill.works");
  AuthApi api{auth, nullptr, false, SessionCookieScopes{"", ""}};
  UserId account{"e1000000-0000-4000-8000-000000000001"};
  Json::Value input{Json::objectValue};

  ClosureHttp() {
    User user{account, Email{"closure@example.com"}, "", std::nullopt, std::nullopt};
    repo.usersById.emplace(account.str(), user);
    repo.usersByEmail.emplace(user.email.value, user);
    repo.insertSession(tokens.digestOf("s-closure"), account, clock.now + 1000000, "", "", clock.now);
    input["account"] = account.str();
    input["operationId"] = "e2000000-0000-4000-8000-000000000001";
    input["proof"] = std::string(64, 'a');
    input["requestedAtMs"] = Json::UInt64(clock.now);
  }

  drogon::HttpResponsePtr call(bool close, const Json::Value& body, const std::string& token = "") {
    auto request = drogon::HttpRequest::newHttpRequest();
    request->setMethod(close ? drogon::Delete : drogon::Post);
    request->setPath(close ? "/v1/me" : "/v1/account-deletion/result");
    request->setContentTypeCode(drogon::CT_APPLICATION_JSON);
    request->setBody(Json::writeString(Json::StreamWriterBuilder{}, body));
    if (!token.empty()) request->addHeader("authorization", "Bearer " + token);
    drogon::HttpResponsePtr response;
    auto capture = [&](const drogon::HttpResponsePtr& value) { response = value; };
    beginWriteRequest(request, WriteRoute{request->path(), close ? "platform.DELETE.v1.me" : "auth.account.closure.read",
        "platform", "rest", {request->method()}});
    observeHttpWork(request, [&] {
      if (close) api.deleteMe(request, capture);
      else api.deletionResult(request, capture);
    });
    finishWriteRequest(request, response);
    CHECK_EQ(response->getHeader("cache-control"), std::string("private, no-store"));
    return response;
  }
};

struct ClosureObservation : FailureReporter {
  std::vector<WriteCompletion> lines;
  std::vector<Json::Value> issues;
  ClosureObservation() {
    installWriteReporter(std::shared_ptr<FailureReporter>(this, [](FailureReporter*) {}));
    installWriteSink([this](const WriteCompletion& line) { lines.push_back(line); });
  }
  ~ClosureObservation() {
    installWriteSink({});
    installWriteReporter({});
  }
  void report(const std::string&, const std::string&, const std::string&) override {}
  void reportWrite(const std::string& operation, const std::string& product, const std::string& door,
      const std::string& outcome, const std::string& id, const std::string& type) override {
    issues.push_back(SentryClient::writeEvent(operation, product, door, outcome, id, type));
  }
};

Json::Value answer(const char* state, const char* code) {
  Json::Value body(Json::objectValue);
  body["state"] = state;
  body["code"] = code;
  return body;
}
}

TEST(account_deletion_lost_response_recovers_without_session_and_replays_never_restore_or_reclose) {
  ClosureHttp h;
  const auto closed = h.call(true, h.input, "s-closure");
  CHECK_EQ(closed->statusCode(), drogon::k200OK);
  CHECK_EQ(closed->getHeader("set-cookie"), std::string("wm_session=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly"));
  Json::Value expected(Json::objectValue);
  expected["state"] = "closed";
  expected["closesMs"] = Json::UInt64(h.clock.now + AuthPolicy::closeGraceMs);
  expected["closingOn"] = "2023-12-14T22:13:20Z";
  expected["receiptExpiresMs"] = Json::UInt64(h.clock.now + AuthPolicy::closeReceiptLifetimeMs);
  CHECK_EQ(*closed->getJsonObject(), expected);
  CHECK_EQ(h.revoked.digests, (std::vector<std::string>{h.tokens.digestOf("s-closure")}));
  const auto retry = h.call(true, h.input, "s-closure");
  CHECK_EQ(retry->statusCode(), drogon::k401Unauthorized);
  CHECK_EQ(*retry->getJsonObject(), answer("pending", "unauthenticated"));
  CHECK_EQ(*h.call(false, h.input)->getJsonObject(), expected);
  CHECK(h.repo.findUserById(h.account)->deletedAt.has_value());
  CHECK(h.repo.sessions.empty());

  h.clock.now += 1000;
  CHECK(h.repo.reviveUser(h.account, h.clock.now));
  h.repo.insertSession(h.tokens.digestOf("s-restored"), h.account, h.clock.now + 1000000, "", "", h.clock.now);
  const auto replay = h.call(true, h.input, "s-restored");
  CHECK_EQ(*replay->getJsonObject(), expected);
  CHECK(replay->cookies().empty());
  CHECK(replay->getHeader("set-cookie").empty());
  CHECK_EQ(*h.call(false, h.input)->getJsonObject(), expected);
  CHECK_FALSE(h.repo.findUserById(h.account)->deletedAt.has_value());
  CHECK(h.auth->authenticate("s-restored").has_value());
  CHECK_EQ(h.repo.closures.size(), std::size_t{1});
}

TEST(account_deletion_receipt_does_not_enumerate_and_expires_without_proving_failure) {
  ClosureHttp h;
  CHECK_EQ(h.call(true, h.input, "s-closure")->statusCode(), drogon::k200OK);
  for (const auto& [field, value] : std::vector<std::pair<std::string, Json::Value>>{
      {"account", "e1000000-0000-4000-8000-000000000002"},
      {"operationId", "e2000000-0000-4000-8000-000000000002"}, {"proof", std::string(64, 'b')},
      {"requestedAtMs", Json::UInt64(h.clock.now + 1)}}) {
    auto input = h.input;
    input[field] = value;
    const auto result = h.call(false, input);
    CHECK_EQ(result->statusCode(), drogon::k404NotFound);
    CHECK_EQ(*result->getJsonObject(), answer("unavailable", "unavailable"));
    CHECK(result->cookies().empty());
    CHECK(result->getHeader("set-cookie").empty());
  }
  const auto& saved = h.repo.closures.begin()->second;
  CHECK_EQ(saved.operation.proofDigest, h.tokens.digestOf("account-closure:" + std::string(64, 'a')));
  CHECK(saved.operation.proofDigest != h.input["proof"].asString());
  h.clock.now = saved.receipt.expiresAt;
  CHECK_EQ(*h.call(false, h.input)->getJsonObject(), answer("unavailable", "unavailable"));
}

TEST(account_deletion_validation_and_clock_refusals_do_not_close_or_revoke) {
  ClosureHttp h;
  for (const auto& [field, value] : std::vector<std::pair<std::string, Json::Value>>{
      {"proof", "short"}, {"proof", std::string(64, 'A')}, {"proof", 42},
      {"operationId", "not-a-uuid"}, {"account", "not-a-uuid"},
      {"requestedAtMs", 0}, {"requestedAtMs", -1}, {"requestedAtMs", 1.25}, {"requestedAtMs", 1.0},
      {"requestedAtMs", Json::UInt64(1ULL << 53)}}) {
    auto input = h.input;
    input[field] = value;
    const auto result = h.call(true, input, "s-closure");
    CHECK_EQ(result->statusCode(), drogon::k400BadRequest);
    CHECK_EQ(*result->getJsonObject(), answer("refused", "malformed"));
  }
  auto future = h.input;
  future["requestedAtMs"] = Json::UInt64(h.clock.now + AuthPolicy::closeRequestWindowMs);
  const auto ahead = h.call(true, future, "s-closure");
  CHECK_EQ(ahead->statusCode(), drogon::k409Conflict);
  CHECK_EQ(*ahead->getJsonObject(), answer("refused", "clock-ahead"));
  auto old = h.input;
  old["requestedAtMs"] = Json::UInt64(h.clock.now - AuthPolicy::closeRequestWindowMs);
  CHECK_EQ(*h.call(true, old, "s-closure")->getJsonObject(), answer("unavailable", "unavailable"));
  auto other = h.input;
  other["account"] = "e1000000-0000-4000-8000-000000000002";
  CHECK_EQ(*h.call(true, other, "s-closure")->getJsonObject(), answer("refused", "account-mismatch"));
  CHECK_FALSE(h.repo.findUserById(h.account)->deletedAt.has_value());
  CHECK(h.auth->authenticate("s-closure").has_value());
  CHECK(h.repo.closures.empty());
  CHECK(h.revoked.digests.empty());
}

TEST(account_deletion_storage_failure_stays_unknown_and_preserves_the_operation_for_recovery) {
  ClosureHttp h;
  h.repo.failClosure = true;
  for (const bool close : {true, false}) {
    const auto failed = h.call(close, h.input, "s-closure");
    CHECK_EQ(failed->statusCode(), drogon::k503ServiceUnavailable);
    CHECK_EQ(*failed->getJsonObject(), answer("pending", "temporarily_unavailable"));
    CHECK(failed->cookies().empty());
  }
  CHECK_FALSE(h.repo.findUserById(h.account)->deletedAt.has_value());
  CHECK(h.repo.closures.empty());
  h.repo.failClosure = false;
  const auto receipt = h.call(true, h.input, "s-closure");
  CHECK_EQ(receipt->statusCode(), drogon::k200OK);
  CHECK_EQ(*h.call(false, h.input)->getJsonObject(), *receipt->getJsonObject());
}

TEST(account_deletion_postcommit_failure_recovers_and_observes_only_static_metadata) {
  ClosureHttp h;
  ClosureObservation observations;
  h.revoked.fail = true;
  const auto failed = h.call(true, h.input, "s-closure");
  CHECK_EQ(failed->statusCode(), drogon::k503ServiceUnavailable);
  CHECK_EQ(*failed->getJsonObject(), answer("pending", "temporarily_unavailable"));
  CHECK(h.repo.findUserById(h.account)->deletedAt.has_value());
  CHECK(h.repo.sessions.empty());
  const auto recovered = h.call(false, h.input);
  CHECK_EQ(recovered->statusCode(), drogon::k200OK);
  CHECK_EQ((*recovered->getJsonObject())["closesMs"], Json::Value(Json::UInt64(h.clock.now + AuthPolicy::closeGraceMs)));
  REQUIRE_EQ(observations.issues.size(), std::size_t{1});
  CHECK_EQ(observations.issues[0]["transaction"], Json::Value("platform.DELETE.v1.me"));
  std::vector<std::pair<std::string, std::string>> outcomes;
  std::string serialized = observations.issues[0].toStyledString();
  for (const auto& line : observations.lines) {
    serialized += writeCompletionJson(line);
    if (line.operation == "platform.DELETE.v1.me" || line.operation == "auth.account.closure.read")
      outcomes.emplace_back(line.operation, line.outcome);
  }
  CHECK_EQ(outcomes, (std::vector<std::pair<std::string, std::string>>{
      {"platform.DELETE.v1.me", "failed"}, {"auth.account.closure.read", "ok"}}));
  for (const auto& secret : {h.account.str(), h.input["operationId"].asString(), h.input["proof"].asString(),
      std::string("closure@example.com"), std::string("s-closure"), std::string("private postcommit notification fault")})
    CHECK_EQ(serialized.find(secret), std::string::npos);
}

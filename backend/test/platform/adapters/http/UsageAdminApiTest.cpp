#include "platform/adapters/http/UsageAdminApi.h"

#include "test/platform/Fakes.h"
#include "test/testing.h"

#include <chrono>
#include <memory>
#include <string>

using namespace wm;
using namespace wm::fake;

namespace {

constexpr long long kThirtyDaysMs = 30LL * 24 * 60 * 60 * 1000;

struct Harness {
  FakeAuthRepository authRepo;
  FakeEmail email;
  FakeTokens tokens;
  FakeClock clock;
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, clock};
  FakeAccountFootprint footprint;
  std::shared_ptr<AuthService> auth = std::make_shared<AuthService>(
      authRepo, email, tokens, clock, oauth, footprint, "https://windmill.works");
  std::shared_ptr<FakeAiUsageRepository> usage = std::make_shared<FakeAiUsageRepository>();
  UsageAdminApi api;

  explicit Harness(const std::string& owners = "sam@example.com")
      : api(usage, auth, owners) {}

  UserId signIn(const std::string& sessionSecret, const std::string& address) {
    User user = authRepo.createUser(Email{address}, "sam");
    authRepo.insertSession(tokens.digestOf(sessionSecret), user.id, clock.now + 1'000'000, "", "",
                           clock.now);
    return user.id;
  }
};

drogon::HttpRequestPtr get(const std::string& path, const std::string& session = "") {
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Get);
  request->setPath(path);
  if (!session.empty()) request->addCookie("wm_session", session);
  return request;
}

long long nowMs() {
  const auto since = std::chrono::system_clock::now().time_since_epoch();
  return std::chrono::duration_cast<std::chrono::milliseconds>(since).count();
}

UsageSummary plantedSummary() {
  UsageSummary summary;
  summary.costNanos = 12'345'678;
  summary.calls = 9;
  summary.unpricedCalls = 2;
  summary.inputTokens = 4'000;
  summary.outputTokens = 900;
  summary.cacheReadTokens = 12'000;
  summary.cacheWriteTokens = 300;
  summary.anonymousCostNanos = 2'000'000;
  summary.unpricedModels = {"claude-something-unreleased"};
  summary.byProduct = {ProductSpend{"roadmap", 9'000'000, 5, 1},
                       ProductSpend{"gym", 3'345'678, 4, 1}};
  summary.daily = {DaySpend{"2026-08-07", 5'000'000, 4, 0},
                   DaySpend{"2026-08-08", 7'345'678, 5, 2}};
  return summary;
}

}  // namespace

// --- the door ------------------------------------------------------------------------------

TEST(usage_admin_answers_a_signed_out_caller_with_a_plain_404) {
  Harness h;

  drogon::HttpResponsePtr response = nullptr;
  h.api.summary(get("/v1/admin/usage/summary"), [&](const drogon::HttpResponsePtr& r) { response = r; });

  CHECK_EQ(response->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ((*response->getJsonObject())["error"].asString(), std::string{"not found"});
  CHECK_EQ(response->getJsonObject()->isMember("code"), false);
  CHECK_EQ(h.usage->fromMs, 0LL);  // and the ledger was never read on the way to refusing
}

TEST(usage_admin_answers_a_signed_in_stranger_byte_identically_to_a_signed_out_one) {
  Harness h;
  h.signIn("s-stranger", "someone@example.com");

  drogon::HttpResponsePtr strangers = nullptr;
  h.api.summary(get("/v1/admin/usage/summary", "s-stranger"),
                [&](const drogon::HttpResponsePtr& r) { strangers = r; });
  drogon::HttpResponsePtr anonymous = nullptr;
  h.api.summary(get("/v1/admin/usage/summary"), [&](const drogon::HttpResponsePtr& r) { anonymous = r; });

  // Not 403 and not 401: a private room denies exactly as an absent one does, so the door tells
  // nobody it is there.
  CHECK_EQ(strangers->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(std::string{strangers->getBody()}, std::string{anonymous->getBody()});
  CHECK_EQ(h.usage->fromMs, 0LL);
}

TEST(an_absent_owner_allowlist_opens_nothing_even_to_the_owner) {
  Harness h{""};
  h.signIn("s-owner", "sam@example.com");

  drogon::HttpResponsePtr response = nullptr;
  h.api.users(get("/v1/admin/usage/users", "s-owner"),
              [&](const drogon::HttpResponsePtr& r) { response = r; });

  CHECK_EQ(response->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(h.usage->limit, 0);
}

TEST(the_allowlist_is_a_comma_list_matched_folded_and_trimmed) {
  Harness h{" Sam@Example.com , second@windmill.works "};
  h.signIn("s-owner", "sam@example.com");
  h.signIn("s-second", "SECOND@windmill.works");
  h.signIn("s-other", "third@windmill.works");

  drogon::HttpResponsePtr first = nullptr;
  h.api.summary(get("/v1/admin/usage/summary", "s-owner"),
                [&](const drogon::HttpResponsePtr& r) { first = r; });
  drogon::HttpResponsePtr second = nullptr;
  h.api.summary(get("/v1/admin/usage/summary", "s-second"),
                [&](const drogon::HttpResponsePtr& r) { second = r; });
  drogon::HttpResponsePtr third = nullptr;
  h.api.summary(get("/v1/admin/usage/summary", "s-other"),
                [&](const drogon::HttpResponsePtr& r) { third = r; });

  CHECK_EQ(first->getStatusCode(), drogon::k200OK);
  CHECK_EQ(second->getStatusCode(), drogon::k200OK);
  CHECK_EQ(third->getStatusCode(), drogon::k404NotFound);
}

// --- what an owner reads -------------------------------------------------------------------

TEST(the_summary_is_the_whole_shape_in_integer_nanos) {
  Harness h;
  h.signIn("s-owner", "sam@example.com");
  h.usage->summaryValue = plantedSummary();

  drogon::HttpResponsePtr response = nullptr;
  h.api.summary(get("/v1/admin/usage/summary", "s-owner"),
                [&](const drogon::HttpResponsePtr& r) { response = r; });

  REQUIRE_EQ(response->getStatusCode(), drogon::k200OK);
  const Json::Value body = *response->getJsonObject();
  CHECK_EQ(body["costNanos"].asInt64(), 12'345'678);
  CHECK_EQ(body["calls"].asInt64(), 9);
  CHECK_EQ(body["unpricedCalls"].asInt64(), 2);
  CHECK_EQ(body["inputTokens"].asInt64(), 4'000);
  CHECK_EQ(body["outputTokens"].asInt64(), 900);
  CHECK_EQ(body["cacheReadTokens"].asInt64(), 12'000);
  CHECK_EQ(body["cacheWriteTokens"].asInt64(), 300);
  CHECK_EQ(body["anonymousCostNanos"].asInt64(), 2'000'000);
  CHECK_EQ(body["costNanos"].isIntegral(), true);  // never a float, never pre-formatted money

  REQUIRE_EQ(body["unpricedModels"].size(), 1u);
  CHECK_EQ(body["unpricedModels"][0].asString(), std::string{"claude-something-unreleased"});

  REQUIRE_EQ(body["byProduct"].size(), 2u);
  CHECK_EQ(body["byProduct"][0]["product"].asString(), std::string{"roadmap"});
  CHECK_EQ(body["byProduct"][0]["costNanos"].asInt64(), 9'000'000);
  CHECK_EQ(body["byProduct"][0]["calls"].asInt64(), 5);
  CHECK_EQ(body["byProduct"][0]["unpricedCalls"].asInt64(), 1);
  CHECK_EQ(body["byProduct"][1]["product"].asString(), std::string{"gym"});
  CHECK_EQ(body["byProduct"][1]["costNanos"].asInt64(), 3'345'678);
  CHECK_EQ(body["byProduct"][1]["calls"].asInt64(), 4);
  CHECK_EQ(body["byProduct"][1]["unpricedCalls"].asInt64(), 1);

  REQUIRE_EQ(body["daily"].size(), 2u);
  CHECK_EQ(body["daily"][0]["day"].asString(), std::string{"2026-08-07"});
  CHECK_EQ(body["daily"][0]["costNanos"].asInt64(), 5'000'000);
  CHECK_EQ(body["daily"][0]["calls"].asInt64(), 4);
  CHECK_EQ(body["daily"][0]["unpricedCalls"].asInt64(), 0);
  CHECK_EQ(body["daily"][1]["day"].asString(), std::string{"2026-08-08"});
  CHECK_EQ(body["daily"][1]["costNanos"].asInt64(), 7'345'678);
  CHECK_EQ(body["daily"][1]["calls"].asInt64(), 5);
  // The marker the honesty strip is drawn from rides on the row, not only on the total.
  CHECK_EQ(body["daily"][1]["unpricedCalls"].asInt64(), 2);
}

TEST(the_spenders_table_is_a_ranked_array_of_ten_at_most) {
  Harness h;
  h.signIn("s-owner", "sam@example.com");
  h.usage->spenders = {UserSpend{UserId{"u1"}, "one@example.com", 8'000, 4, 1, "roadmap"},
                       UserSpend{UserId{"u2"}, "two@example.com", 3'000, 2, 0, "gym"}};

  drogon::HttpResponsePtr response = nullptr;
  h.api.users(get("/v1/admin/usage/users", "s-owner"),
              [&](const drogon::HttpResponsePtr& r) { response = r; });

  REQUIRE_EQ(response->getStatusCode(), drogon::k200OK);
  const Json::Value body = *response->getJsonObject();
  REQUIRE_EQ(body.size(), 2u);
  CHECK_EQ(body[0]["userId"].asString(), std::string{"u1"});
  CHECK_EQ(body[0]["email"].asString(), std::string{"one@example.com"});
  CHECK_EQ(body[0]["costNanos"].asInt64(), 8'000);
  CHECK_EQ(body[0]["calls"].asInt64(), 4);
  CHECK_EQ(body[0]["unpricedCalls"].asInt64(), 1);
  CHECK_EQ(body[0]["topProduct"].asString(), std::string{"roadmap"});
  CHECK_EQ(body[1]["userId"].asString(), std::string{"u2"});
  CHECK_EQ(body[1]["email"].asString(), std::string{"two@example.com"});
  CHECK_EQ(body[1]["costNanos"].asInt64(), 3'000);
  CHECK_EQ(body[1]["calls"].asInt64(), 2);
  CHECK_EQ(body[1]["unpricedCalls"].asInt64(), 0);
  CHECK_EQ(body[1]["topProduct"].asString(), std::string{"gym"});
  CHECK_EQ(h.usage->limit, 10);
}

// --- the window ----------------------------------------------------------------------------

TEST(an_absent_window_is_the_trailing_thirty_days) {
  Harness h;
  h.signIn("s-owner", "sam@example.com");

  const long long before = nowMs();
  drogon::HttpResponsePtr response = nullptr;
  h.api.summary(get("/v1/admin/usage/summary", "s-owner"),
                [&](const drogon::HttpResponsePtr& r) { response = r; });
  const long long after = nowMs();

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(h.usage->toMs >= before, true);
  CHECK_EQ(h.usage->toMs <= after, true);
  CHECK_EQ(h.usage->toMs - h.usage->fromMs, kThirtyDaysMs);
}

TEST(a_given_window_is_passed_through_and_a_nonsense_one_falls_back) {
  Harness h;
  h.signIn("s-owner", "sam@example.com");

  drogon::HttpRequestPtr asked = get("/v1/admin/usage/summary", "s-owner");
  asked->setParameter("from", "1700000000000");
  asked->setParameter("to", "1700086400000");
  h.api.summary(asked, [](const drogon::HttpResponsePtr&) {});
  CHECK_EQ(h.usage->fromMs, 1'700'000'000'000LL);
  CHECK_EQ(h.usage->toMs, 1'700'086'400'000LL);

  // Garbage is not worth a 400 on a two-reader page: the default IS what was wanted.
  drogon::HttpRequestPtr junk = get("/v1/admin/usage/summary", "s-owner");
  junk->setParameter("from", "yesterday");
  junk->setParameter("to", "-5");
  const long long before = nowMs();
  h.api.summary(junk, [](const drogon::HttpResponsePtr&) {});
  CHECK_EQ(h.usage->toMs >= before, true);
  CHECK_EQ(h.usage->toMs - h.usage->fromMs, kThirtyDaysMs);
}

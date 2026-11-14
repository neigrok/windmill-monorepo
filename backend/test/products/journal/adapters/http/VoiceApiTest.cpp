#include "products/journal/adapters/http/VoiceApi.h"

#include "platform/application/Entitlements.h"
#include "platform/adapters/json/JsonText.h"
#include "test/platform/FakeAiBudgetRepository.h"
#include "test/platform/Fakes.h"
#include "test/products/journal/Fakes.h"
#include "test/testing.h"

#include <memory>
#include <string>

using namespace wm;
using namespace wm::fake;

namespace {

struct Harness {
  FakeAuthRepository authRepo;
  FakeEmail email;
  FakeTokens tokens;
  std::shared_ptr<FakeClock> clock = std::make_shared<FakeClock>();
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, *clock};
  FakeAccountFootprint footprint;
  FakeSessionRevocations revocations;
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, tokens, *clock, oauth, footprint, revocations, "https://windmill.works");
  std::shared_ptr<FakeTranscriber> transcriber = std::make_shared<FakeTranscriber>();
  std::shared_ptr<FakeSubscriptionRepository> subs = std::make_shared<FakeSubscriptionRepository>();
  FakeAiUsageRepository usage;
  FakeAiBudgetRepository allowances;
  AiBudgetLimits limits;
  std::shared_ptr<AiBudgetService> budgets = std::make_shared<AiBudgetService>(
      allowances, [this] { return limits; }, [this] { return static_cast<long long>(clock->now); });
  std::shared_ptr<Entitlements> entitlements;
  VoiceApi api;

  // `ledger` turns the durable USD allowances on, the mode Windmill One is funded in.
  explicit Harness(bool ledger = false)
      : entitlements(std::make_shared<Entitlements>(*subs, usage, "", std::vector<std::string>{},
                                                    ledger ? budgets : nullptr)),
        api(transcriber, entitlements, auth, clock) {}

  UserId signIn(const std::string& sessionSecret) {
    User user = authRepo.createUser(Email{"sam@example.com"}, "sam");
    authRepo.insertSession(tokens.digestOf(sessionSecret), user.id, clock->now + 1'000'000, "", "",
                           clock->now);
    return user.id;
  }

  // A Windmill One subscription whose payment funded the billing period around now.
  AiBudgetGrant fund(const UserId& user) {
    subs->subscribe(user);
    const AiBudgetGrant grant{"grant_talk", user.str(), AiBudgetFundingSource::Subscription,
                              AiBudgetPeriod{static_cast<long long>(clock->now) - 86'400'000,
                                             static_cast<long long>(clock->now) + 29LL * 86'400'000},
                              limits.paidPeriodNanos, "txn_talk"};
    allowances.grants.emplace(grant.id, grant);
    return grant;
  }
};

drogon::HttpRequestPtr post(const std::string& audio, const std::string& session = "") {
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Post);
  request->setPath("/v1/journal/transcribe");
  request->setBody(audio);
  request->addHeader("content-type", "audio/webm");
  if (!session.empty()) request->addCookie("wm_session", session);
  return request;
}

// The reply may arrive after this returns, so the slot it lands in is shared, never a reference to this stack frame. A null answer means the take is still with the vendor.
drogon::HttpResponsePtr send(VoiceApi& api, const drogon::HttpRequestPtr& request) {
  auto captured = std::make_shared<drogon::HttpResponsePtr>();
  api.transcribe(request,
                 [captured](const drogon::HttpResponsePtr& response) { *captured = response; });
  return *captured;
}

}

TEST(voice_without_a_session_is_401) {
  Harness h;
  CHECK_EQ(send(h.api, post("opus-bytes"))->getStatusCode(), drogon::k401Unauthorized);
}

TEST(voice_for_a_non_subscriber_is_403_before_the_vendor_or_the_ledger_hears_of_it) {
  for (const bool ledger : {false, true}) {
    Harness h{ledger};
    h.signIn("s-live");

    const auto response = send(h.api, post("opus-bytes", "s-live"));

    CHECK_EQ(response->getStatusCode(), drogon::k403Forbidden);
    CHECK_EQ(dump(*response->getJsonObject()), std::string{R"({"error":"talk is part of Windmill One"})"});
    CHECK_EQ(h.transcriber->calls, 0);
    CHECK_EQ(h.allowances.reads, 0);
  }
}

TEST(voice_without_a_vendor_wired_is_503) {
  Harness h;
  UserId me = h.signIn("s-live");
  h.subs->subscribe(me);
  h.transcriber->on = false;
  const auto response = send(h.api, post("opus-bytes", "s-live"));
  CHECK_EQ(response->getStatusCode(), drogon::k503ServiceUnavailable);
  CHECK_EQ(dump(*response->getJsonObject()),
           std::string{R"({"code":"voice_unavailable","error":"voice is not available right now"})"});
  CHECK_EQ(h.transcriber->calls, 0);
}

TEST(voice_for_a_subscriber_transcribes_the_audio_and_makes_no_page) {
  Harness h;
  UserId me = h.signIn("s-live");
  h.subs->subscribe(me);

  drogon::HttpResponsePtr response = send(h.api, post("opus-bytes", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  Json::Value body = *response->getJsonObject();
  CHECK_EQ(body["text"].asString(), std::string("rain all morning"));
  CHECK_EQ(h.transcriber->lastAudio, std::string("opus-bytes"));
  CHECK_EQ(h.transcriber->lastMime, std::string("audio/webm"));
  CHECK_EQ(h.transcriber->lastUser, me.str());
}

TEST(voice_answers_502_when_the_vendor_does_not) {
  Harness h;
  UserId me = h.signIn("s-live");
  h.subs->subscribe(me);
  h.transcriber->answers = false;

  drogon::HttpResponsePtr response = send(h.api, post("opus-bytes", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k502BadGateway);
  CHECK_EQ((*response->getJsonObject())["error"].asString(),
           std::string("the transcriber could not answer"));
}

TEST(voice_refuses_a_take_past_the_audio_cap_before_the_vendor_sees_it) {
  Harness h;
  UserId me = h.signIn("s-live");
  h.subs->subscribe(me);

  drogon::HttpResponsePtr response =
      send(h.api, post(std::string(kMaxAudioBytes + 1, 'a'), "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k413RequestEntityTooLarge);
  CHECK_EQ(h.transcriber->calls, 0);
}

TEST(voice_refuses_an_account_that_has_talked_its_day_away) {
  Harness h;
  UserId me = h.signIn("s-live");
  h.subs->subscribe(me);

  // Five maximum takes is 30 MB — the day's bytes exactly — and the sixth is refused. Each is answered before the next is sent, so this is the ration and not the in-flight cap.
  const std::string take(kMaxAudioBytes, 'a');
  for (int i = 0; i < 5; ++i)
    CHECK_EQ(send(h.api, post(take, "s-live"))->getStatusCode(), drogon::k200OK);

  drogon::HttpResponsePtr response = send(h.api, post(take, "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k429TooManyRequests);
  CHECK_EQ((*response->getJsonObject())["error"].asString(),
           std::string("talk has had its turn for today"));
  CHECK_EQ(h.transcriber->calls, 5);
}

TEST(voice_refuses_a_third_take_while_two_are_still_with_the_vendor) {
  Harness h;
  UserId me = h.signIn("s-live");
  h.subs->subscribe(me);
  h.transcriber->hold = true;

  CHECK(!send(h.api, post("one", "s-live")));
  CHECK(!send(h.api, post("two", "s-live")));
  drogon::HttpResponsePtr third = send(h.api, post("three", "s-live"));

  CHECK_EQ(third->getStatusCode(), drogon::k503ServiceUnavailable);
  CHECK_EQ((*third->getJsonObject())["error"].asString(), std::string("voice is busy right now"));
  CHECK_EQ(h.transcriber->calls, 2);

  h.transcriber->answerHeld();
  h.transcriber->hold = false;
  CHECK_EQ(send(h.api, post("four", "s-live"))->getStatusCode(), drogon::k200OK);
}

TEST(voice_refuses_an_account_over_its_ai_allowance_before_the_vendor_sees_it) {
  Harness h;
  UserId me = h.signIn("s-live");
  h.subs->subscribe(me);
  h.usage.spentByProduct[""] = kProMonthlyAiNanos;

  drogon::HttpResponsePtr response = send(h.api, post("opus-bytes", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k429TooManyRequests);
  CHECK_EQ((*response->getJsonObject())["error"].asString(),
           std::string("talk has had its turn for now"));
  CHECK_EQ(h.transcriber->calls, 0);
}

// The subscriber Windmill One is sold to: a take is transcribed, and once the period's allowance is spent the next one
// is refused with the allowance's own code before the vendor hears it.
TEST(voice_with_allowances_on_transcribes_for_a_funded_subscriber_and_refuses_a_spent_allowance_with_its_code) {
  Harness h{true};
  UserId me = h.signIn("s-live");
  const AiBudgetGrant grant = h.fund(me);

  const auto transcribed = send(h.api, post("opus-bytes", "s-live"));

  CHECK_EQ(transcribed->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(*transcribed->getJsonObject()), std::string{R"({"text":"rain all morning"})"});
  CHECK_EQ(h.transcriber->calls, 1);

  h.allowances.totals.subject.spentNanos = h.limits.paidPeriodNanos;
  const auto refused = send(h.api, post("opus-bytes", "s-live"));

  CHECK_EQ(refused->getStatusCode(), drogon::k429TooManyRequests);
  Json::Value expected = parse(R"({"code":"subject_exhausted","reason":"allowance_exhausted",
      "error":"your AI allowance is fully used or reserved","allowance":{"code":"subject_exhausted",
      "currency":"USD","period":"billing_period","tier":"windmill_one","configured":true,"limit":"7.000000000",
      "used":"7.000000000","reserved":"0.000000000","remaining":"0.000000000"}})");
  expected["allowance"]["resetsAtMs"] = Json::Int64(grant.period.endMs);
  expected["allowance"]["budgetResetsAtMs"] = Json::Int64(grant.period.endMs);
  CHECK_EQ(dump(*refused->getJsonObject()), dump(expected));
  CHECK_EQ(h.transcriber->calls, 1);
}

TEST(voice_with_allowances_on_answers_a_subscription_no_payment_has_funded_with_funding_required) {
  Harness h{true};
  UserId me = h.signIn("s-live");
  h.subs->subscribe(me);

  const auto response = send(h.api, post("opus-bytes", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k503ServiceUnavailable);
  CHECK_EQ(dump(*response->getJsonObject()), dump(parse(R"({"code":"funding_required","reason":"unavailable",
      "error":"your plan has no funded AI allowance for this period","allowance":{"code":"funding_required",
      "currency":"USD","period":"billing_period","tier":"windmill_one","configured":false,"limit":null,
      "used":"0.000000000","reserved":"0.000000000","remaining":"0.000000000","resetsAtMs":null,
      "budgetResetsAtMs":null}})")));
  CHECK_EQ(h.transcriber->calls, 0);
}

// The read showed room, and the transcriber's admission refused anyway: a take holds more than is left, another AI
// request holds the slot, or the ledger could not be asked. Each answers under the code that refused it, and every
// refused take gives its ration slot back.
TEST(voice_with_allowances_on_answers_a_refused_admission_under_the_code_that_refused_it) {
  Harness h{true};
  UserId me = h.signIn("s-live");
  const AiBudgetGrant grant = h.fund(me);
  h.allowances.totals.subject.spentNanos = h.limits.paidPeriodNanos - 50'000'000;
  Json::Value allowance = parse(R"({"currency":"USD","period":"billing_period","tier":"windmill_one",
      "configured":true,"limit":"7.000000000","used":"6.950000000","reserved":"0.000000000",
      "remaining":"0.050000000","budgetResetsAtMs":null})");
  allowance["resetsAtMs"] = Json::Int64(grant.period.endMs);

  struct Case {
    std::string refusal;
    drogon::HttpStatusCode status;
    Json::Value body;
  };
  Json::Value capacity = parse(R"({"code":"subject_exhausted","reason":"request_exceeds_remaining",
      "error":"a take needs more AI allowance than you have left"})");
  capacity["allowance"] = allowance;
  capacity["allowance"]["code"] = "subject_exhausted";
  capacity["allowance"]["budgetResetsAtMs"] = Json::Int64(grant.period.endMs);
  Json::Value busy = parse(R"({"code":"concurrency_exhausted","reason":"unavailable",
      "error":"another AI request is still in progress"})");
  busy["allowance"] = allowance;
  busy["allowance"]["code"] = "concurrency_exhausted";
  for (const Case& scenario : std::vector<Case>{
           {"subject_exhausted", drogon::k429TooManyRequests, capacity},
           {"concurrency_exhausted", drogon::k503ServiceUnavailable, busy},
           {"ai_accounting_unavailable", drogon::k503ServiceUnavailable,
            parse(R"({"code":"ai_accounting_unavailable","error":"talk's AI allowance could not be checked right now"})")},
           {"unsupported_ai_pricing", drogon::k503ServiceUnavailable,
            parse(R"({"code":"unsupported_ai_pricing","error":"voice is not available right now"})")}}) {
    h.transcriber->refusal = scenario.refusal;

    const auto response = send(h.api, post("opus-bytes", "s-live"));

    CHECK_EQ(response->getStatusCode(), scenario.status);
    CHECK_EQ(dump(*response->getJsonObject()), dump(scenario.body));
  }
  CHECK_EQ(h.transcriber->calls, 4);
}

// A take the allowance refused never reached the vendor, so its bytes go back on the day's bucket: six refused
// maximum takes leave the whole 30 MiB for the five that follow.
TEST(voice_with_allowances_on_a_refused_take_gives_its_audio_back_to_the_day) {
  Harness h{true};
  UserId me = h.signIn("s-live");
  h.fund(me);
  const std::string take(kMaxAudioBytes, 'a');
  h.transcriber->refusal = "concurrency_exhausted";
  for (int i = 0; i < 6; ++i)
    CHECK_EQ(send(h.api, post(take, "s-live"))->getStatusCode(), drogon::k503ServiceUnavailable);

  h.transcriber->refusal.clear();
  for (int i = 0; i < 5; ++i) CHECK_EQ(send(h.api, post(take, "s-live"))->getStatusCode(), drogon::k200OK);
  const auto spent = send(h.api, post(take, "s-live"));

  CHECK_EQ(spent->getStatusCode(), drogon::k429TooManyRequests);
  CHECK_EQ(dump(*spent->getJsonObject()), std::string{R"({"error":"talk has had its turn for today"})"});
  CHECK_EQ(h.transcriber->calls, 11);
}

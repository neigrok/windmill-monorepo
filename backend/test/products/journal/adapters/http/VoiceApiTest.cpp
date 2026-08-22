#include "products/journal/adapters/http/VoiceApi.h"

#include "platform/application/Entitlements.h"
#include "platform/adapters/json/JsonText.h"
#include "test/platform/Fakes.h"
#include "test/products/journal/Fakes.h"
#include "test/testing.h"

#include <memory>
#include <string>

using namespace wm;
using namespace wm::fake;

namespace {

// The auth harness JournalApiTest/NudgeApiTest use, plus the two ports voice owns: a toggleable
// transcriber (the 503 path) and the billing mirror (the subscription gate).
struct Harness {
  FakeAuthRepository authRepo;
  FakeEmail email;
  FakeTokens tokens;
  FakeClock clock;
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, clock};
  FakeAccountFootprint footprint;
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, tokens, clock, oauth, footprint, "https://windmill.works");
  std::shared_ptr<FakeTranscriber> transcriber = std::make_shared<FakeTranscriber>();
  std::shared_ptr<FakeSubscriptionRepository> subs = std::make_shared<FakeSubscriptionRepository>();
  FakeAiUsageRepository usage;
  std::shared_ptr<Entitlements> entitlements = std::make_shared<Entitlements>(*subs, usage);
  VoiceApi api{transcriber, entitlements, auth};

  UserId signIn(const std::string& sessionSecret) {
    User user = authRepo.createUser(Email{"sam@example.com"}, "sam");
    authRepo.insertSession(tokens.digestOf(sessionSecret), user.id, clock.now + 1'000'000, "", "",
                           clock.now);
    return user.id;
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

// The reply may arrive after this returns — the whole point of the wave is that the handler does not
// wait for the vendor — so the slot it lands in is shared, never a reference to this stack frame. A
// null answer means the take is still with the vendor; the fake decides when that ends.
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

TEST(voice_for_a_non_subscriber_is_403) {
  Harness h;
  h.signIn("s-live");
  CHECK_EQ(send(h.api, post("opus-bytes", "s-live"))->getStatusCode(), drogon::k403Forbidden);
}

TEST(voice_without_a_vendor_wired_is_503) {
  Harness h;
  UserId me = h.signIn("s-live");
  h.subs->subscribe(me);
  h.transcriber->on = false;
  CHECK_EQ(send(h.api, post("opus-bytes", "s-live"))->getStatusCode(),
           drogon::k503ServiceUnavailable);
}

TEST(voice_for_a_subscriber_transcribes_the_audio_and_makes_no_page) {
  Harness h;
  UserId me = h.signIn("s-live");
  h.subs->subscribe(me);

  drogon::HttpResponsePtr response = send(h.api, post("opus-bytes", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  Json::Value body = *response->getJsonObject();
  CHECK_EQ(body["text"].asString(), std::string("rain all morning"));
  CHECK_EQ(h.transcriber->lastAudio, std::string("opus-bytes"));   // the bytes reached the vendor seam
  CHECK_EQ(h.transcriber->lastMime, std::string("audio/webm"));
  CHECK_EQ(h.transcriber->lastUser, me.str());                     // and the seam knows whose spend it is
}

TEST(voice_answers_502_when_the_vendor_does_not) {
  // It used to answer 200 {"text":""}, so an outage and a take carrying no words were the same
  // reply — and the writer had no reason to try again.
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
  CHECK_EQ(h.transcriber->calls, 0);   // nothing was uploaded, so nothing was spent
}

TEST(voice_refuses_an_account_that_has_talked_its_day_away) {
  Harness h;
  UserId me = h.signIn("s-live");
  h.subs->subscribe(me);

  // Five maximum takes is 30 MB — the day's bytes exactly — and the sixth is refused. Each is
  // answered before the next is sent, so this is the ration speaking and not the in-flight cap.
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

  CHECK(!send(h.api, post("one", "s-live")));     // held: no reply yet, and the handler already returned
  CHECK(!send(h.api, post("two", "s-live")));
  drogon::HttpResponsePtr third = send(h.api, post("three", "s-live"));

  CHECK_EQ(third->getStatusCode(), drogon::k503ServiceUnavailable);
  CHECK_EQ((*third->getJsonObject())["error"].asString(), std::string("voice is busy right now"));
  CHECK_EQ(h.transcriber->calls, 2);

  // The slots come back when the vendor answers, so the next take is served.
  h.transcriber->answerHeld();
  h.transcriber->hold = false;
  CHECK_EQ(send(h.api, post("four", "s-live"))->getStatusCode(), drogon::k200OK);
}

TEST(voice_refuses_an_account_over_its_ai_allowance_before_the_vendor_sees_it) {
  // OUR fuse, not a sales door: the dollar figure is never shown, and the vendor is never asked.
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

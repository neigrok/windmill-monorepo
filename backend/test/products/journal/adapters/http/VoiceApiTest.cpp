#include "products/journal/adapters/http/VoiceApi.h"

#include "platform/application/Entitlements.h"
#include "platform/adapters/json/JsonText.h"
#include "test/application/AuthFakes.h"
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
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, tokens, clock, oauth, "https://windmill.works");
  std::shared_ptr<FakeTranscriber> transcriber = std::make_shared<FakeTranscriber>();
  std::shared_ptr<FakeSubscriptionRepository> subs = std::make_shared<FakeSubscriptionRepository>();
  std::shared_ptr<Entitlements> entitlements = std::make_shared<Entitlements>(*subs);
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

drogon::HttpResponsePtr send(VoiceApi& api, const drogon::HttpRequestPtr& request) {
  drogon::HttpResponsePtr captured;
  api.transcribe(request, [&](const drogon::HttpResponsePtr& response) { captured = response; });
  return captured;
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
}

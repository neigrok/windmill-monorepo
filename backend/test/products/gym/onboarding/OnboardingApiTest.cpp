#include "products/gym/onboarding/OnboardingApi.h"
#include "test/products/gym/onboarding/OnboardingFixture.h"
#include "test/DrogonLoopback.h"
#include "test/testing.h"

#include <future>

using namespace wm;
using namespace wm::gym;
using namespace wm::gym::onboardingtest;

namespace {

struct HttpHarness {
  Harness h;
  fake::FakeAuthRepository accounts;
  fake::FakeEmail email;
  fake::FakeOAuthRepository oauthRepository;
  OAuthService oauth{oauthRepository,h.tokens,h.clock};
  fake::FakeAccountFootprint footprint;
  fake::FakeSessionRevocations revocations;
  std::shared_ptr<AuthService> auth=std::make_shared<AuthService>(accounts,email,h.tokens,h.clock,oauth,footprint,revocations,"http://localhost");
  fake::FakeSubscriptionRepository subscriptions;
  fake::FakeAiUsageRepository usage;
  std::shared_ptr<Entitlements> entitlements=std::make_shared<Entitlements>(subscriptions,usage,std::string{},std::vector<std::string>{},h.budgets);
  std::shared_ptr<AiInstallations> identity;
  std::shared_ptr<AiInstallationApi> installations;
  OnboardingApi api;
  test::DrogonLoopback::Connection wire;
  std::string forwarded;
  explicit HttpHarness(bool disabled=false)
      : identity(disabled ? std::make_shared<AiInstallations>(h.installationRepository,h.budgets,h.tokens,h.clock,std::nullopt) : h.installations),
        installations(std::make_shared<AiInstallationApi>(identity,auth,entitlements,h.failures,
                      disabled ? AiInstallationProxy::Cloudflare : AiInstallationProxy::Direct)),
        api(disabled ? std::make_shared<OnboardingService>(h.records,h.model,h.catalog,identity,h.tokens,h.clock,h.failures) : h.service,
            installations,h.failures),
        forwarded(disabled ? "CF-Connecting-IP: 203.0.113.7\r\n" : "") {}
  drogon::HttpResponsePtr post(Json::Value body,const std::string& credential,const std::string& authHeader="") {
    const auto raw=dump(body);
    const auto request=wire.exchange("POST /v1/gym/coach/onboarding HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: "+std::to_string(raw.size())+"\r\n"+
        (credential.empty()?"":"X-Windmill-Installation: "+credential+"\r\n")+
        (authHeader.empty()?"":"Authorization: "+authHeader+"\r\n")+forwarded+"\r\n"+raw).request;
    if (!request) throw std::runtime_error("test request was not parsed");
    auto value=std::make_shared<std::promise<drogon::HttpResponsePtr>>();
    auto future=value->get_future();
    api.start(request,[value](const auto& response){value->set_value(response);});
    if (future.wait_for(std::chrono::seconds(5))!=std::future_status::ready) throw std::runtime_error("onboarding POST timed out");
    return future.get();
  }
  drogon::HttpResponsePtr get(const std::string& id,const std::string& credential) {
    const auto request=wire.exchange("GET /v1/gym/coach/onboarding/"+id+" HTTP/1.1\r\nHost: localhost\r\nX-Windmill-Installation: "+credential+"\r\n"+forwarded+"\r\n").request;
    if (!request) throw std::runtime_error("test request was not parsed");
    auto value=std::make_shared<std::promise<drogon::HttpResponsePtr>>();
    auto future=value->get_future();
    api.get(request,[value](const auto& response){value->set_value(response);},id);
    if (future.wait_for(std::chrono::seconds(5))!=std::future_status::ready) throw std::runtime_error("onboarding GET timed out");
    return future.get();
  }
};

}

TEST(gym_onboarding_http_rejects_anonymous_account_downgrade_and_invalid_photo_without_a_claim) {
  HttpHarness h;
  const auto goal=parse(R"({"requestId":"12345678-1234-1234-1234-123456789abc","mode":"goal","goal":"Strength","daysPerWeek":3,"equipment":"gym"})");
  const auto absent=h.post(goal,"");
  CHECK_EQ(absent->getStatusCode(),drogon::k401Unauthorized);
  CHECK_EQ(parse(std::string(absent->body()))["code"],"invalid_installation");
  const auto badAccount=h.post(goal,h.h.issue.credential,"Bearer invalid-session");
  CHECK_EQ(badAccount->getStatusCode(),drogon::k401Unauthorized);
  CHECK_EQ(parse(std::string(badAccount->body()))["code"],"unauthenticated");
  const auto photo=parse(R"({"requestId":"12345678-1234-1234-1234-123456789abc","mode":"photo","image":{"mimeType":"image/png","data":"AAAA"}})");
  const auto badPhoto=h.post(photo,h.h.issue.credential);
  CHECK_EQ(badPhoto->getStatusCode(),drogon::k400BadRequest);
  CHECK_EQ(parse(std::string(badPhoto->body()))["code"],"invalid_image");
  CHECK_EQ(h.h.model->calls.load(),0);
  CHECK(h.h.records->rows.empty());
  CHECK_EQ(absent->getHeader("Cache-Control"),"private, no-store");
}

TEST(gym_onboarding_http_validates_photo_pixels_and_returns_only_device_scoped_result) {
  HttpHarness h;
  std::promise<void> entered;
  h.h.model->before=[&]{entered.set_value();};
  const auto photo=parse(R"({"requestId":"12345678-1234-1234-1234-123456789abc","mode":"photo","image":{"mimeType":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNoaGgAAAMEAYFL09IQAAAAAElFTkSuQmCC"}})");
  const auto started=h.post(photo,h.h.issue.credential);
  REQUIRE_EQ(started->getStatusCode(),drogon::k202Accepted);
  REQUIRE(entered.get_future().wait_for(std::chrono::seconds(5))==std::future_status::ready);
  h.h.service->stop();
  const auto result=h.get(photo["requestId"].asString(),h.h.issue.credential);
  CHECK_EQ(result->getStatusCode(),drogon::k200OK);
  const auto body=parse(std::string(result->body()));
  CHECK_EQ(body["status"],"completed");
  CHECK_EQ(body["requestId"],photo["requestId"]);
  CHECK(body["errorCode"].isNull());
  CHECK_EQ(body["routines"],parse(R"([{"name":"Push","entries":[{"exerciseId":"bench-press","sets":[{"reps":8,"weightKg":null}],"restSeconds":120}]}])"));
  CHECK_EQ(body["allowance"],parse(R"({"code":"ok","currency":"USD","period":"lifetime","tier":"anonymous","configured":true,"limit":"0.050000000","used":"0.000000000","reserved":"0.000000000","remaining":"0.050000000","resetsAtMs":null,"budgetResetsAtMs":null})"));
  CHECK_EQ(body.getMemberNames(),(Json::Value::Members{"allowance","errorCode","expiresAtMs","message","requestId","resultId","routines","status"}));
  CHECK_EQ(result->getHeader("Cache-Control"),"private, no-store");
  const auto other=h.h.installations->issue("127.0.0.2");
  const auto hidden=h.get(photo["requestId"].asString(),other.credential);
  const auto missing=h.get("12345678-1234-1234-1234-123456789abb",other.credential);
  CHECK_EQ(hidden->getStatusCode(),drogon::k404NotFound);
  CHECK_EQ(std::string(hidden->body()),std::string(missing->body()));
  CHECK_EQ(h.h.catalog->ownerReads.load(),0);
  CHECK_EQ(h.h.model->calls.load(),1);
}

TEST(gym_onboarding_http_switch_off_recovers_cloudflare_replays_without_new_claims) {
  HttpHarness h{true};
  const auto input=parse(R"({"requestId":"12345678-1234-1234-1234-123456789abc","mode":"program","program":"Bench press 3x8"})");
  const auto parsed=readOnboardingIn(input);
  REQUIRE(parsed);
  OnboardingRecord record{.deviceId=h.h.issue.principal->id(),.requestId=parsed->requestId,
                         .inputHash=h.h.tokens.digestOf(dump(onboardingInput(*parsed))),.resultId="result",
                         .state="failed",.errorCode="insufficient_details",.expiresAtMs=static_cast<long long>(h.h.clock.now)+1000};
  h.h.records->rows.emplace(std::pair(record.deviceId,record.requestId),record);
  const auto original=h.get(record.requestId,h.h.issue.credential);
  REQUIRE_EQ(original->getStatusCode(),drogon::k200OK);
  const auto replay=h.post(input,h.h.issue.credential);
  CHECK_EQ(replay->getStatusCode(),drogon::k200OK);
  CHECK_EQ(std::string(replay->body()),std::string(original->body()));
  auto changed=input;
  changed["program"]="Different input";
  CHECK_EQ(h.post(changed,h.h.issue.credential)->getStatusCode(),drogon::k409Conflict);
  auto newRequest=input;
  newRequest["requestId"]="12345678-1234-1234-1234-123456789abd";
  const auto refused=h.post(newRequest,h.h.issue.credential);
  CHECK_EQ(refused->getStatusCode(),drogon::k503ServiceUnavailable);
  CHECK_EQ(parse(std::string(refused->body()))["code"],"anonymous_ai_unavailable");
  CHECK_EQ(h.get(newRequest["requestId"].asString(),h.h.issue.credential)->getStatusCode(),drogon::k404NotFound);
  CHECK_EQ(h.h.records->rows.size(),1U);
  CHECK_EQ(h.h.model->calls.load(),0);
  CHECK_EQ(h.h.installationRepository.admissions,0);
}

TEST(gym_onboarding_conversation_photo_checks_pixels_before_claim) {
  HttpHarness h;
  auto body=parse(R"({"requestId":"12345678-1234-1234-1234-123456789abc","mode":"conversation","text":"Please read this","context":[],"image":{"mimeType":"image/png","data":"AAAA"}})");
  const auto result=h.post(body,h.h.issue.credential);
  CHECK_EQ(result->getStatusCode(),drogon::k400BadRequest);
  CHECK_EQ(parse(std::string(result->body()))["code"],"invalid_image");
  CHECK_EQ(h.h.model->calls.load(),0);
  CHECK(h.h.records->rows.empty());
}

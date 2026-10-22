#include "test/products/gym/onboarding/OnboardingFixture.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::gym;
using namespace wm::gym::onboardingtest;

namespace {

struct Messages : MessagesApi {
  std::vector<MessagesRequest> requests;
  MessagesReply reply;
  bool throws=false;
  bool configured() const override { return true; }
  MessagesReply send(const MessagesRequest& request) override {
    requests.push_back(request);
    if (throws) throw std::runtime_error("private provider body");
    return reply;
  }
};

struct Meter : UsageSink {
  std::vector<AiSpend> entries;
  void record(const AiSpend& spend) noexcept override { entries.push_back(spend); }
};

}

TEST(gym_anonymous_model_request_is_one_compact_structured_call_with_only_public_seeds) {
  const std::vector<Exercise> seeds{
      {ExerciseId{"bench-press"},"Bench Press",Pattern::press,Equipment::barbell,2.5,false},
      {ExerciseId{"private-movement"},"Private exercise name",Pattern::press,Equipment::barbell,2.5,true}};
  const auto input=*readOnboardingIn(parse(R"({"requestId":"12345678-1234-1234-1234-123456789abc","mode":"goal","goal":"Build strength","daysPerWeek":3,"equipment":"barbell"})"));
  const auto request=onboardingMessages(input,seeds);
  CHECK_EQ(request.model,"claude-sonnet-5");
  CHECK_EQ(request.maxTokens,2000);
  CHECK_EQ(request.effort,"low");
  CHECK_EQ(parse(request.user),parse(R"({"mode":"goal","goal":"Build strength","daysPerWeek":3,"equipment":"barbell","exercises":[["bench-press","Bench Press","barbell"]]})"));
  const auto body=messagesBody(request);
  CHECK_FALSE(body.isMember("tools"));
  CHECK_EQ(body["thinking"],parse(R"({"type":"adaptive"})"));
  CHECK_EQ(body["output_config"]["format"]["type"],"json_schema");
  const auto cost=anthropicReservationNanos(body);
  REQUIRE(cost);
  CHECK(*cost<50'000'000);
  CHECK_EQ(dump(body).find("Private exercise name"),std::string::npos);
}

TEST(gym_anonymous_photo_uses_inline_content_without_file_upload_or_tool_capability) {
  const OnboardingIn input{.mode="photo",.note="Keep this plan",.imageMimeType="image/png",.imageBase64="AAAA"};
  const auto request=onboardingMessages(input,{});
  CHECK_EQ(request.content,parse(R"([{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}},{"type":"text","text":"{\"exercises\":[],\"mode\":\"photo\",\"note\":\"Keep this plan\"}"}])"));
  CHECK_EQ(messagesBody(request)["messages"][0]["content"],request.content);
  const auto estimate=anthropicReservationNanos(messagesBody(request));
  REQUIRE(estimate);
  CHECK(*estimate<50'000'000);
}

TEST(gym_anonymous_model_reserves_selected_ceiling_and_settles_actual_cost_without_an_account) {
  Harness h;
  REQUIRE(h.issue.principal);
  fake::FakeAuthRepository accounts;
  fake::FakeSubscriptionRepository subscriptions;
  fake::FakeAiUsageRepository usage;
  Entitlements entitlements{subscriptions,usage,{},{},h.budgets};
  auto budget=std::make_shared<AiCallBudget>(h.budgets,entitlements,accounts,*h.failures);
  auto messages=std::make_shared<Messages>();
  auto meter=std::make_shared<Meter>();
  messages->reply=readMessagesReply(200,R"({"stop_reason":"end_turn","usage":{"input_tokens":100,"output_tokens":150,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"{\"routines\":[{\"name\":\"Push\",\"entries\":[{\"exerciseId\":\"bench-press\",\"sets\":[{\"reps\":8,\"weightKg\":null}],\"restSeconds\":120}]}]}"}]})");
  AnthropicOnboarding model{messages,budget,meter,h.failures};
  const OnboardingIn input{.mode="goal",.goal="Strength",.daysPerWeek=3,.equipment="gym"};
  const auto answer=model.generate(*h.issue.principal,"onb_fixture",input,h.catalog->seeds);
  CHECK(answer.refusal.empty());
  REQUIRE_EQ(answer.routines.size(),1U);
  REQUIRE_EQ(messages->requests.size(),1U);
  REQUIRE_EQ(h.budgetRepository.reservations.size(),1U);
  const auto& reservation=h.budgetRepository.reservations.begin()->second;
  CHECK_EQ(reservation.subject,(AiBudgetSubject{AiBudgetSubjectKind::Device,h.issue.principal->id()}));
  CHECK_EQ(reservation.tier,AiBudgetTier::Anonymous);
  CHECK_EQ(reservation.state,AiBudgetState::Settled);
  CHECK_EQ(reservation.actualNanos,std::optional<long long>{1'700'000});
  REQUIRE(reservation.outputBudget);
  CHECK_EQ(reservation.amountNanos,reservation.outputBudget->costNanos(messages->requests[0].maxTokens));
  REQUIRE_EQ(meter->entries.size(),1U);
  CHECK_FALSE(meter->entries[0].user);
  CHECK_EQ(meter->entries[0].operation,"coach.preview");
  CHECK_EQ(meter->entries[0].product,"gym");
  CHECK(h.failures->reports.empty());
}

TEST(gym_anonymous_failed_charged_output_is_settled_and_partial_routines_never_escape) {
  for (const auto& stop : {"max_tokens","refusal"}) {
    Harness h;
    REQUIRE(h.issue.principal);
    fake::FakeAuthRepository accounts;
    fake::FakeSubscriptionRepository subscriptions;
    fake::FakeAiUsageRepository usage;
    Entitlements entitlements{subscriptions,usage,{},{},h.budgets};
    auto budget=std::make_shared<AiCallBudget>(h.budgets,entitlements,accounts,*h.failures);
    auto messages=std::make_shared<Messages>();
    auto raw=parse(R"({"stop_reason":"max_tokens","usage":{"input_tokens":100,"output_tokens":2000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"{\"routines\":["}]})");
    raw["stop_reason"]=stop;
    messages->reply=readMessagesReply(200,dump(raw));
    AnthropicOnboarding model{messages,budget,nullptr,h.failures};
    const auto answer=model.generate(*h.issue.principal,"onb_failure",OnboardingIn{.mode="program",.program="Bench press"},h.catalog->seeds);
    CHECK_EQ(answer.refusal,std::string(stop)=="max_tokens"?"output_truncated":"model_refused");
    CHECK(answer.routines.empty());
    REQUIRE_EQ(h.budgetRepository.reservations.size(),1U);
    CHECK_EQ(h.budgetRepository.reservations.begin()->second.actualNanos,std::optional<long long>{20'200'000});
    CHECK_EQ(h.budgetRepository.reservations.begin()->second.state,AiBudgetState::Settled);
  }
}

TEST(gym_anonymous_transport_unknown_holds_reservation_and_budget_refusal_makes_no_call) {
  Harness h;
  REQUIRE(h.issue.principal);
  fake::FakeAuthRepository accounts;
  fake::FakeSubscriptionRepository subscriptions;
  fake::FakeAiUsageRepository usage;
  Entitlements entitlements{subscriptions,usage,{},{},h.budgets};
  auto budget=std::make_shared<AiCallBudget>(h.budgets,entitlements,accounts,*h.failures);
  auto messages=std::make_shared<Messages>();
  messages->reply=readMessagesReply(0,"");
  AnthropicOnboarding model{messages,budget,nullptr,h.failures};
  const OnboardingIn input{.mode="program",.program="Bench press"};
  const auto answer=model.generate(*h.issue.principal,"onb_unknown",input,h.catalog->seeds);
  CHECK_EQ(answer.refusal,"provider_failed");
  REQUIRE_EQ(h.budgetRepository.reservations.size(),1U);
  CHECK_EQ(h.budgetRepository.reservations.begin()->second.state,AiBudgetState::Uncertain);
  CHECK_FALSE(h.budgetRepository.reservations.begin()->second.actualNanos);
  h.budgetRepository.totals.subject.spentNanos=50'000'000;
  const auto denied=model.generate(*h.issue.principal,"onb_denied",input,h.catalog->seeds);
  CHECK_EQ(denied.refusal,"subject_exhausted");
  CHECK_EQ(messages->requests.size(),1U);
}

TEST(gym_anonymous_dialogue_preserves_prior_context_without_tools_and_retains_answer) {
  Harness h;
  fake::FakeAuthRepository accounts;
  fake::FakeSubscriptionRepository subscriptions;
  fake::FakeAiUsageRepository usage;
  Entitlements entitlements{subscriptions,usage,{},{},h.budgets};
  auto budget=std::make_shared<AiCallBudget>(h.budgets,entitlements,accounts,*h.failures);
  auto messages=std::make_shared<Messages>();
  messages->reply=readMessagesReply(200,R"({"stop_reason":"end_turn","usage":{"input_tokens":100,"output_tokens":40,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"{\"message\":\"Hi. What would you like to work on?\",\"routines\":[]}"}]})");
  const auto input=*readOnboardingIn(parse(R"({"requestId":"12345678-1234-1234-1234-123456789abc","mode":"conversation","text":"Hello","context":[{"role":"user","text":"I am new"}]})"));
  AnthropicOnboarding model{messages,budget,nullptr,h.failures};
  const auto answer=model.generate(*h.issue.principal,"onb_dialogue",input,h.catalog->seeds);
  CHECK(answer.refusal.empty());
  CHECK_EQ(answer.message,"Hi. What would you like to work on?");
  CHECK(answer.routines.empty());
  REQUIRE_EQ(messages->requests.size(),1U);
  CHECK_EQ(parse(messages->requests[0].user)["context"],input.context);
  CHECK_FALSE(messagesBody(messages->requests[0]).isMember("tools"));
  CHECK_EQ(messages->requests[0].schema["properties"]["message"]["type"],"string");
  CHECK(h.failures->reports.empty());
}

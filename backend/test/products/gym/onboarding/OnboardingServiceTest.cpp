#include "test/products/gym/onboarding/OnboardingFixture.h"
#include "platform/application/WriteObservation.h"
#include "test/testing.h"

#include <future>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::gym;
using namespace wm::gym::onboardingtest;

TEST(gym_onboarding_service_replays_pending_and_completed_and_never_reads_account_data) {
  Harness h;
  REQUIRE(h.issue.principal);
  std::promise<void> entered;
  std::promise<void> release;
  auto gate=release.get_future().share();
  h.model->before=[&]{entered.set_value();gate.wait();};
  OnboardingIn input{.requestId="12345678-1234-1234-1234-123456789abc",.mode="goal",.goal="Private goal",.daysPerWeek=3,.equipment="gym"};
  const auto first=h.service->start(*h.issue.principal,"127.0.0.1",input);
  entered.get_future().wait();
  const auto replay=h.service->start(*h.issue.principal,"127.0.0.1",input);
  input.goal="Changed private goal";
  const auto conflict=h.service->start(*h.issue.principal,"127.0.0.1",input);
  release.set_value();
  h.service->stop();
  REQUIRE(first.record);
  REQUIRE(replay.record);
  CHECK(first.created);
  CHECK_FALSE(replay.created);
  CHECK_EQ(first.record->resultId,replay.record->resultId);
  CHECK_EQ(replay.record->state,"pending");
  CHECK_EQ(conflict.refusal,"request_conflict");
  CHECK_EQ(h.model->calls.load(),1);
  CHECK_EQ(h.catalog->ownerReads.load(),0);
  CHECK_EQ(h.catalog->seedReads.load(),1);
  CHECK_EQ(h.installationRepository.admissions,1);
  const auto saved=h.service->get(*h.issue.principal,input.requestId);
  REQUIRE(saved);
  CHECK_EQ(saved->state,"completed");
  CHECK_EQ(saved->payload,parse(R"({"message":"","routines":[{"name":"Push","entries":[{"exerciseId":"bench-press","sets":[{"reps":8,"weightKg":null}],"restSeconds":120}]}]})"));
  input.goal="Private goal";
  const auto complete=h.service->start(*h.issue.principal,"127.0.0.1",input);
  REQUIRE(complete.record);
  CHECK_EQ(complete.record->payload,saved->payload);
  CHECK_EQ(h.model->calls.load(),1);
  CHECK_EQ(saved->inputHash.size(),64U);
}

TEST(gym_onboarding_service_replays_failures_without_spend_and_preserves_original_reset) {
  Harness h;
  REQUIRE(h.issue.principal);
  h.model->error="free_day_exhausted";
  OnboardingIn input{.requestId="12345678-1234-1234-1234-123456789abc",.mode="program",.program="Bench press 3x8"};
  std::promise<void> done;
  h.model->before=[&]{done.set_value();};
  h.service->start(*h.issue.principal,"127.0.0.1",input);
  done.get_future().wait();
  h.service->stop();
  const auto saved=h.service->get(*h.issue.principal,input.requestId);
  REQUIRE(saved);
  CHECK_EQ(saved->state,"failed");
  CHECK_EQ(saved->errorCode,"free_day_exhausted");
  const auto reset=AiBudgetPeriod::dayAt(h.clock.now)->endMs;
  h.clock.now=reset+100;
  const auto allowance=h.service->allowance(*h.issue.principal,&*saved);
  CHECK_EQ(allowance.code,AiBudgetCode::FreeDayExhausted);
  CHECK_EQ(allowance.budgetResetsAtMs,std::optional<long long>(reset));
  const auto replay=h.service->start(*h.issue.principal,"127.0.0.1",input);
  REQUIRE(replay.record);
  CHECK_EQ(replay.record->errorCode,"free_day_exhausted");
  CHECK_EQ(h.model->calls.load(),1);
}

TEST(gym_onboarding_unsupported_equipment_is_durable_without_model_or_ip_admission) {
  Harness h;
  REQUIRE(h.issue.principal);
  OnboardingIn input{.requestId="12345678-1234-1234-1234-123456789abc",.mode="goal",.goal="Build strength",.daysPerWeek=3,.equipment="bands"};
  const auto first=h.service->start(*h.issue.principal,"127.0.0.1",input);
  const auto second=h.service->start(*h.issue.principal,"127.0.0.1",input);
  REQUIRE(first.record);
  REQUIRE(second.record);
  CHECK_EQ(first.record->state,"failed");
  CHECK_EQ(first.record->errorCode,"unsupported_equipment");
  CHECK_EQ(second.record->errorCode,"unsupported_equipment");
  CHECK_EQ(h.model->calls.load(),0);
  CHECK_EQ(h.installationRepository.admissions,0);
}

TEST(gym_onboarding_ip_refusal_and_process_restart_never_redispatch_a_request) {
  Harness h;
  REQUIRE(h.issue.principal);
  h.installationRepository.code=AiInstallationCode::RateLimited;
  OnboardingIn input{.requestId="12345678-1234-1234-1234-123456789abc",.mode="program",.program="Bench press 3x8"};
  const auto first=h.service->start(*h.issue.principal,"127.0.0.1",input);
  REQUIRE(first.record);
  CHECK_EQ(first.record->errorCode,std::string(aiInstallationCodeName(AiInstallationCode::RateLimited)));
  h.service->stop();
  auto next=std::make_shared<OnboardingService>(h.records,h.model,h.catalog,h.installations,h.tokens,h.clock,h.failures);
  h.installationRepository.code=AiInstallationCode::Ok;
  const auto replay=next->start(*h.issue.principal,"127.0.0.1",input);
  REQUIRE(replay.record);
  CHECK_EQ(replay.record->state,"failed");
  CHECK_EQ(h.model->calls.load(),0);
  CHECK_EQ(h.installationRepository.admissions,1);
}

TEST(gym_onboarding_switch_off_preserves_results_without_claim_or_provider_dispatch) {
  Harness h;
  REQUIRE(h.issue.principal);
  const OnboardingIn input{.requestId="12345678-1234-1234-1234-123456789abc",.mode="program",.program="Bench press 3x8"};
  OnboardingRecord completed{.deviceId=h.issue.principal->id(),.requestId=input.requestId,
                            .inputHash=h.tokens.digestOf(dump(onboardingInput(input))),.resultId="result",.state="completed",
                            .payload=parse(R"({"routines":[]})"),.expiresAtMs=static_cast<long long>(h.clock.now)+1000};
  h.records->rows.emplace(std::pair(completed.deviceId,completed.requestId),completed);
  auto disabled=std::make_shared<AiInstallations>(h.installationRepository,h.budgets,h.tokens,h.clock,std::nullopt);
  OnboardingService service{h.records,h.model,h.catalog,disabled,h.tokens,h.clock,h.failures};
  auto newRequest=input;
  newRequest.requestId="12345678-1234-1234-1234-123456789abd";
  const auto refused=service.start(*h.issue.principal,"127.0.0.1",newRequest);
  CHECK_FALSE(refused.record);
  CHECK_EQ(refused.refusal,"anonymous_ai_unavailable");
  const auto recovered=service.get(*h.issue.principal,input.requestId);
  REQUIRE(recovered);
  CHECK_EQ(recovered->payload,completed.payload);
  const auto replay=service.start(*h.issue.principal,"127.0.0.1",input);
  REQUIRE(replay.record);
  CHECK_FALSE(replay.created);
  CHECK_EQ(replay.record->payload,completed.payload);
  auto conflict=input;
  conflict.program="Different input";
  CHECK_EQ(service.start(*h.issue.principal,"127.0.0.1",conflict).refusal,"request_conflict");
  CHECK_EQ(h.records->rows.size(),1U);
  CHECK_EQ(h.model->calls.load(),0);
  CHECK_EQ(h.installationRepository.admissions,0);
}

// A reply longer than the bound is kept, clipped after its last whole word, and logged as an expected outcome.
TEST(gym_onboarding_service_keeps_a_long_reply_clipped_without_an_issue) {
  Harness h;
  REQUIRE(h.issue.principal);
  std::string reply;
  while (reply.size()<=kOnboardingMessageBytes) reply+="Keep the bar close. ";
  h.model->message=reply;
  std::promise<void> answered;
  h.model->before=[&]{answered.set_value();};
  std::vector<WriteCompletion> generated;
  installWriteSink([&](const WriteCompletion& completion) {
    if (completion.operation=="gym.coach.onboarding.generate") generated.push_back(completion);
  });
  OnboardingIn input{.requestId="12345678-1234-1234-1234-123456789abc",.mode="conversation",.text="How do I deadlift?"};
  h.service->start(*h.issue.principal,"127.0.0.1",input);
  answered.get_future().wait();
  h.service->stop();
  installWriteSink({});
  const auto saved=h.service->get(*h.issue.principal,input.requestId);
  REQUIRE(saved);
  CHECK_EQ(saved->state,"completed");
  CHECK_EQ(saved->payload["message"].asString(),onboardingMessage(reply).text);
  CHECK(saved->payload["message"].asString().size()<=kOnboardingMessageBytes);
  REQUIRE_EQ(generated.size(),1U);
  CHECK_EQ(generated[0].outcome,"message_clipped");
  CHECK(h.failures->reports.empty());
}

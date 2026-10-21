#include "products/gym/onboarding/OnboardingService.h"

#include "platform/adapters/json/JsonText.h"
#include "platform/application/WriteObservation.h"

namespace wm::gym {

OnboardingService::OnboardingService(std::shared_ptr<OnboardingRepository> repository,
    std::shared_ptr<OnboardingModel> model, std::shared_ptr<CatalogRepository> catalog,
    std::shared_ptr<AiInstallations> installations, TokenGenerator& tokens, Clock& clock,
    std::shared_ptr<FailureReporter> failures)
    : repository_(std::move(repository)), model_(std::move(model)), catalog_(std::move(catalog)),
      installations_(std::move(installations)), tokens_(tokens), clock_(clock), failures_(std::move(failures)) {}

OnboardingService::~OnboardingService() { stop(); }
bool OnboardingService::configured() const { return model_ && model_->configured() && installations_; }
void OnboardingService::stop() { retention_.stop(); workers_.stopAndJoin(); }
void OnboardingService::startRetention() {
  retention_.start(30, 300, [this] { repository_->expire(clock_.nowMs()); });
}

OnboardingClaim OnboardingService::start(const AiInstallationPrincipal& installation,
                                        const std::string& address, OnboardingIn input) {
  if (installation.boundAccount()) return {std::nullopt, false, "device_bound"};
  const long long now = clock_.nowMs();
  const auto inputHash = tokens_.digestOf(dump(onboardingInput(input)));
  if (!installations_->anonymousEnabled()) {
    const auto existing = repository_->get(installation.id(), input.requestId, now);
    if (!existing) return {std::nullopt, false, "anonymous_ai_unavailable"};
    if (existing->inputHash != inputHash) return {std::nullopt, false, "request_conflict"};
    return {existing, false, {}};
  }
  OnboardingRecord proposed;
  proposed.deviceId = installation.id();
  proposed.requestId = input.requestId;
  proposed.inputHash = inputHash;
  proposed.resultId = "onb_" + tokens_.digestOf(installation.id() + ":" + input.requestId);
  proposed.createdAtMs = now;
  proposed.leaseUntilMs = now + kOnboardingLeaseMs;
  proposed.expiresAtMs = now + kOnboardingRetentionMs;
  auto result = repository_->claim(proposed);
  if (!result.created) return result;
  if (input.mode == "goal" && (input.equipment == "bands" || input.equipment == "other")) {
    proposed.state = "failed";
    proposed.errorCode = "unsupported_equipment";
    proposed.terminalAtMs = now;
    repository_->finish(proposed, now);
    return {proposed, true, {}};
  }
  const auto rate = installations_->admitGeneration(installation, input.requestId, address);
  if (rate != AiInstallationCode::Ok && rate != AiInstallationCode::Replay) {
    proposed.state = "failed";
    proposed.errorCode = std::string(aiInstallationCodeName(rate));
    proposed.terminalAtMs = now;
    repository_->finish(proposed, now);
    return {proposed, true, {}};
  }
  if (!configured() || !workers_.post([this, installation, input = std::move(input), proposed]() mutable {
        generate(installation, std::move(input), proposed);
      })) {
    proposed.state = "failed";
    proposed.errorCode = "unavailable";
    proposed.terminalAtMs = now;
    repository_->finish(proposed, now);
    return {proposed, true, {}};
  }
  return result;
}

std::optional<OnboardingRecord> OnboardingService::get(const AiInstallationPrincipal& installation,
                                                     const std::string& requestId) {
  return repository_->get(installation.id(), requestId, clock_.nowMs());
}

AiBudgetView OnboardingService::allowance(const AiInstallationPrincipal& installation,
                                         const OnboardingRecord* record) const {
  auto view = installations_->allowance(installation);
  if (!record || record->errorCode.empty()) return view;
  for (const auto code : {AiBudgetCode::SubjectExhausted, AiBudgetCode::FreeDayExhausted,
                         AiBudgetCode::FreeMonthExhausted, AiBudgetCode::ConcurrencyExhausted,
                         AiBudgetCode::DebtOutstanding, AiBudgetCode::DeviceBound,
                         AiBudgetCode::Unconfigured}) {
    if (record->errorCode != aiBudgetCodeName(code)) continue;
    view.code = code;
    view.budgetResetsAtMs.reset();
    if (code == AiBudgetCode::FreeDayExhausted)
      view.budgetResetsAtMs = AiBudgetPeriod::dayAt(record->terminalAtMs)->endMs;
    if (code == AiBudgetCode::FreeMonthExhausted)
      view.budgetResetsAtMs = AiBudgetPeriod::at(record->terminalAtMs)->endMs;
    return view;
  }
  return view;
}

void OnboardingService::generate(AiInstallationPrincipal installation, OnboardingIn input,
                                 OnboardingRecord record) {
  WriteObservation observation{"gym.coach.onboarding.generate", "gym", "coach", "", failures_.get()};
  WriteContext context(observation);
  try {
    std::string completed = "completed";
    if (workers_.stopping() || clock_.nowMs() >= static_cast<std::uint64_t>(record.leaseUntilMs)) {
      record.state = "failed";
      record.errorCode = "interrupted";
    } else {
      const auto seeds = catalog_->seedCatalog();
      const auto answer = model_->generate(installation, record.resultId, input, seeds);
      record.state = answer.refusal.empty() ? "completed" : "failed";
      record.errorCode = answer.refusal;
      if (answer.refusal.empty()) {
        const auto message = onboardingMessage(answer.message);
        record.payload = onboardingRoutines(answer.routines);
        record.payload["message"] = message.text;
        if (message.clipped) completed = "message_clipped";
      }
    }
    const bool saved = repository_->finish(record, clock_.nowMs());
    observation.finish(!saved ? "interrupted" : record.errorCode.empty() ? completed : record.errorCode);
  } catch (const std::exception& error) {
    observation.fail(error);
    try {
      record.state = "failed";
      record.errorCode = "internal_error";
      record.payload = Json::Value();
      repository_->finish(record, clock_.nowMs());
    } catch (...) {
      if (failures_) failures_->report("gym", "gym.coach.onboarding.persist", "terminal result unavailable");
    }
  } catch (...) {
    observation.failUnknown();
    try {
      record.state = "failed";
      record.errorCode = "internal_error";
      record.payload = Json::Value();
      repository_->finish(record, clock_.nowMs());
    } catch (...) {
      if (failures_) failures_->report("gym", "gym.coach.onboarding.persist", "terminal result unavailable");
    }
  }
}

}

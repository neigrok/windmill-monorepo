#pragma once

#include "products/gym/onboarding/Onboarding.h"
#include "platform/ai_installations/AiInstallations.h"
#include "platform/adapters/llm/AiCallBudget.h"
#include "platform/adapters/llm/AnthropicClient.h"

namespace wm::gym {

struct OnboardingAnswer {
  std::vector<OnboardingRoutine> routines;
  std::string refusal;
};

struct OnboardingModel {
  virtual ~OnboardingModel() = default;
  virtual bool configured() const = 0;
  virtual OnboardingAnswer generate(const AiInstallationPrincipal& installation, const std::string& resultId,
                                   const OnboardingIn& input, const std::vector<Exercise>& seeds) = 0;
};

MessagesRequest onboardingMessages(const OnboardingIn& input, const std::vector<Exercise>& seeds);

class AnthropicOnboarding : public OnboardingModel {
public:
  AnthropicOnboarding(std::shared_ptr<MessagesApi> messages, std::shared_ptr<AiCallBudget> budget,
                     std::shared_ptr<UsageSink> usage, std::shared_ptr<FailureReporter> failures);
  bool configured() const override;
  OnboardingAnswer generate(const AiInstallationPrincipal& installation, const std::string& resultId,
                           const OnboardingIn& input, const std::vector<Exercise>& seeds) override;

private:
  std::shared_ptr<MessagesApi> messages_;
  std::shared_ptr<AiCallBudget> budget_;
  std::shared_ptr<UsageSink> usage_;
  std::shared_ptr<FailureReporter> failures_;
};

}

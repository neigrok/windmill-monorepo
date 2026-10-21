#pragma once

#include "products/gym/onboarding/AnthropicOnboarding.h"
#include "products/gym/ports/CatalogRepository.h"
#include "platform/application/WorkerPool.h"
#include "platform/application/Heartbeat.h"
#include "platform/ports/Clock.h"
#include "platform/ports/TokenGenerator.h"

namespace wm::gym {

class OnboardingService {
public:
  OnboardingService(std::shared_ptr<OnboardingRepository> repository,
                    std::shared_ptr<OnboardingModel> model, std::shared_ptr<CatalogRepository> catalog,
                    std::shared_ptr<AiInstallations> installations, TokenGenerator& tokens, Clock& clock,
                    std::shared_ptr<FailureReporter> failures);
  ~OnboardingService();
  bool configured() const;
  OnboardingClaim start(const AiInstallationPrincipal& installation, const std::string& address,
                        OnboardingIn input);
  std::optional<OnboardingRecord> get(const AiInstallationPrincipal& installation,
                                    const std::string& requestId);
  AiBudgetView allowance(const AiInstallationPrincipal& installation, const OnboardingRecord* record = nullptr) const;
  void startRetention();
  void stop();

private:
  void generate(AiInstallationPrincipal installation, OnboardingIn input, OnboardingRecord record);
  std::shared_ptr<OnboardingRepository> repository_;
  std::shared_ptr<OnboardingModel> model_;
  std::shared_ptr<CatalogRepository> catalog_;
  std::shared_ptr<AiInstallations> installations_;
  TokenGenerator& tokens_;
  Clock& clock_;
  std::shared_ptr<FailureReporter> failures_;
  WorkerPool workers_{"gym-onboarding", 2, 2};
  Heartbeat retention_{"gym-coach-onboarding-retention", "gym"};
};

}

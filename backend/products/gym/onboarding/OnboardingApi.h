#pragma once

#include "products/gym/onboarding/OnboardingService.h"
#include "platform/ai_installations/AiInstallationApi.h"

namespace wm::gym {

class OnboardingApi {
public:
  OnboardingApi(std::shared_ptr<OnboardingService> service, std::shared_ptr<AiInstallationApi> installations,
                std::shared_ptr<FailureReporter> failures);
  void start(const drogon::HttpRequestPtr& request, std::function<void(const drogon::HttpResponsePtr&)>&& reply);
  void get(const drogon::HttpRequestPtr& request, std::function<void(const drogon::HttpResponsePtr&)>&& reply,
           const std::string& requestId);
  void stop();

private:
  std::shared_ptr<OnboardingService> service_;
  std::shared_ptr<AiInstallationApi> installations_;
  std::shared_ptr<FailureReporter> failures_;
  WorkerPool workers_{"gym-onboarding-http", 2, 16};
};

}

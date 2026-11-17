#pragma once

#include "platform/ai_passes/AiPasses.h"
#include "platform/adapters/http/WriteRoutes.h"
#include "platform/ai_installations/AiInstallationApi.h"
#include "platform/adapters/http/RateLimiter.h"
#include <set>

namespace wm {

inline const WriteRoutePolicy kAiPassRoutePolicy{"no-store", "ai-pass", {"anonymous_ai_unavailable", "unavailable"}};

class AiPassApi {
public:
  AiPassApi(std::shared_ptr<AiPasses> passes, std::shared_ptr<AuthService> auth,
            std::shared_ptr<AiInstallations> installations, std::shared_ptr<Entitlements> entitlements,
            std::shared_ptr<RateLimiter> limiter, Clock& clock, std::set<std::string> origins,
            AiInstallationProxy proxy);
  void sign(const drogon::HttpRequestPtr& request, std::function<void(const drogon::HttpResponsePtr&)>&& reply);

private:
  std::shared_ptr<AiPasses> passes_;
  std::shared_ptr<AuthService> auth_;
  std::shared_ptr<AiInstallations> installations_;
  std::shared_ptr<Entitlements> entitlements_;
  std::shared_ptr<RateLimiter> limiter_;
  Clock& clock_;
  std::set<std::string> origins_;
  AiInstallationProxy proxy_;
};

}

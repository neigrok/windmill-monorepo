#pragma once

#include "platform/application/AuthService.h"
#include "platform/application/AiBudgetService.h"
#include "platform/ports/AuthRepository.h"
#include "platform/ports/Clock.h"
#include "platform/ports/SubscriptionRepository.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// Paddle billing's HTTP edge: the webhook Paddle delivers to, which upserts the local mirror and funds AI allowances
// from verified payments, and the checkout door, which stays closed. The mirror decides no access: Windmill One is read
// from the subscription service's copy (platform/subscriptions).
class BillingApi {
public:
  BillingApi(SubscriptionRepository& subscriptions, std::shared_ptr<AuthService> auth, Clock& clock,
             std::string webhookSecret, std::string priceId = "", std::shared_ptr<AiBudgetService> budgets = nullptr,
             AuthRepository* accounts = nullptr, long long fundedPeriodNanos = 7'000'000'000);

  void webhook(const drogon::HttpRequestPtr& req, HttpCallback&& callback);         // POST /v1/paddle/webhook
  void startCheckout(const drogon::HttpRequestPtr& req, HttpCallback&& callback);   // POST /v1/billing/checkout

private:
  SubscriptionRepository& subscriptions_;
  std::shared_ptr<AuthService> auth_;
  Clock& clock_;
  std::string webhookSecret_;
  std::string priceId_;
  std::shared_ptr<AiBudgetService> budgets_;
  AuthRepository* accounts_;
  long long fundedPeriodNanos_;
};

}

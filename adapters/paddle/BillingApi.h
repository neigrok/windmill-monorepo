#pragma once

#include "adapters/paddle/PaddleApiClient.h"
#include "application/AuthService.h"
#include "ports/Clock.h"
#include "ports/SubscriptionRepository.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// Paddle billing's HTTP edge: the webhook Paddle delivers to, and the subscription a signed-in
// browser reads. Webhooks are the source of truth — every verified delivery upserts the local
// mirror — so the read answers from this database and never round-trips the Paddle API.
class BillingApi {
public:
  BillingApi(SubscriptionRepository& subscriptions, std::shared_ptr<AuthService> auth, Clock& clock,
             std::string webhookSecret, std::shared_ptr<PaddleApiClient> paddle = nullptr,
             std::string priceId = "");

  void webhook(const drogon::HttpRequestPtr& req, HttpCallback&& callback);         // POST /v1/paddle/webhook
  void mySubscription(const drogon::HttpRequestPtr& req, HttpCallback&& callback);  // GET  /v1/subscription
  void startCheckout(const drogon::HttpRequestPtr& req, HttpCallback&& callback);   // POST /v1/billing/checkout

private:
  SubscriptionRepository& subscriptions_;
  std::shared_ptr<AuthService> auth_;
  Clock& clock_;
  std::string webhookSecret_;
  std::shared_ptr<PaddleApiClient> paddle_;  // null when billing writes are unconfigured
  std::string priceId_;
};

}

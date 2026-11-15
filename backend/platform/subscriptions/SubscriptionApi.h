#pragma once

#include "platform/application/AuthService.h"
#include "platform/application/Entitlements.h"
#include "platform/ports/FailureReporter.h"
#include "platform/subscriptions/WindmillOne.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>

namespace wm::subscriptions {

// What a person's device asks about Windmill One (subscriptions.md §5.3). Every answer comes from the backend's copy of
// the account's entitlement, so it reads alike while the subscription service is down (INV-10).
class SubscriptionApi {
public:
  SubscriptionApi(std::shared_ptr<AuthService> auth, std::shared_ptr<Entitlements> entitlements, PaidLine line,
                  std::shared_ptr<FailureReporter> failures);

  // GET /v1/subscription: the caller's SubscriptionResponse.
  void get(const drogon::HttpRequestPtr& request, std::function<void(const drogon::HttpResponsePtr&)>&& reply);

private:
  std::shared_ptr<AuthService> auth_;
  std::shared_ptr<Entitlements> entitlements_;
  const PaidLine line_;
  std::shared_ptr<FailureReporter> failures_;
};

}

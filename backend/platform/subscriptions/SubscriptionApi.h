#pragma once

#include "platform/application/AuthService.h"
#include "platform/application/Entitlements.h"
#include "platform/application/WorkerPool.h"
#include "platform/ports/FailureReporter.h"
#include "platform/subscriptions/AppStoreClaim.h"
#include "platform/subscriptions/FeedFollower.h"
#include "platform/subscriptions/WindmillOne.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <chrono>
#include <cstddef>
#include <functional>
#include <memory>
#include <optional>

namespace wm::subscriptions {

// What a claim goes through while the feed is followed (§5.3): the service's claim door, the follower asked to bring the
// copy to the claim's seq within `wait`, and the threads a claim blocks on, apart from every IO loop.
struct ClaimForwarding {
  std::shared_ptr<AppStoreClaims> service;
  std::shared_ptr<FeedFollower> follower;
  std::shared_ptr<WorkerPool> workers;
  std::chrono::milliseconds wait{5'000};
};

// What a person's device asks about Windmill One (subscriptions.md §5.3). Every answer comes from the backend's copy of
// the account's entitlement, so it reads alike while the subscription service is down (INV-10).
class SubscriptionApi {
public:
  using Reply = std::function<void(const drogon::HttpResponsePtr&)>;

  // No `claims` while the follower is off: a claim is then refused before the service is asked.
  SubscriptionApi(std::shared_ptr<AuthService> auth, std::shared_ptr<Entitlements> entitlements, PaidLine line,
                  std::shared_ptr<FailureReporter> failures, std::optional<ClaimForwarding> claims = std::nullopt);

  // GET /v1/subscription: the caller's SubscriptionResponse.
  void get(const drogon::HttpRequestPtr& request, Reply&& reply);

  // POST /v1/subscription/app-store/claims: the caller's signed App Store transaction, forwarded to the service under
  // the caller's account and answered from the copy once it holds the claim, or the claim's refusal. Its line is the
  // route's `subscription.claim`, which this names the outcome of.
  void claimAppStore(const drogon::HttpRequestPtr& request, Reply&& reply);

  // A StoreKit 2 transaction is a few kilobytes signed; the service takes a body of at most 64 KiB.
  static constexpr std::size_t kSignedTransactionBytes = 32 * 1024;

private:
  std::shared_ptr<AuthService> auth_;
  std::shared_ptr<Entitlements> entitlements_;
  const PaidLine line_;
  std::shared_ptr<FailureReporter> failures_;
  const std::optional<ClaimForwarding> claims_;
};

}

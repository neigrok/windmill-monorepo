#pragma once

#include "platform/adapters/http/ReplyWait.h"
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

// What a claim may take once a worker takes it (§5.3): the service's answer, the follower bringing the copy to the claim,
// and the copy's read under every pooled connection's statement timeout.
inline constexpr std::chrono::seconds kClaimCopyWait{5};
inline constexpr std::chrono::seconds kClaimCopyRead{5};
inline constexpr std::chrono::seconds kClaimWork = kClaimAnswerWait + kClaimCopyWait + kClaimCopyRead;
// What a claim may wait to be taken. One taken later answers at once without asking the service, and every claim queued
// ahead of it was taken earlier, so each is answered within the two, inside the wait a reply has (ReplyWait.h).
inline constexpr std::chrono::seconds kClaimQueueWait{25};
static_assert(kClaimQueueWait + kClaimWork <= kVendorReplyWait, "every claim is answered before its reply's wait ends");

// The claims one account may have taken at once: one with the service, the rest waiting behind it.
inline constexpr std::size_t kClaimsPerAccount = 4;

// What a claim goes through while the feed is followed (§5.3): the service's claim door, the follower asked to bring the
// copy to the claim's seq within `wait`, at most kClaimCopyWait, and the threads a claim blocks on, apart from every IO
// loop. A claim not yet with the service when the process is told to stop answers at once.
struct ClaimForwarding {
  std::shared_ptr<AppStoreClaims> service;
  std::shared_ptr<FeedFollower> follower;
  std::shared_ptr<WorkerPool> workers;
  std::function<bool()> stopping = [] { return false; };
  std::chrono::milliseconds wait = kClaimCopyWait;
  std::function<std::chrono::steady_clock::time_point()> now = [] { return std::chrono::steady_clock::now(); };
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
  // the caller's account, one claim of an account at a time, and answered from the copy once it holds the claim (200),
  // as it stands once the wait for it runs out (202), or with the claim's refusal. Its line is the route's
  // `subscription.claim`, which this names the outcome of.
  void claimAppStore(const drogon::HttpRequestPtr& request, Reply&& reply);

private:
  struct Claims;  // the claims taken, one at a time per account, and the windows their failures report through

  std::shared_ptr<AuthService> auth_;
  std::shared_ptr<Entitlements> entitlements_;
  const PaidLine line_;
  std::shared_ptr<FailureReporter> failures_;
  std::shared_ptr<Claims> claims_;
};

}

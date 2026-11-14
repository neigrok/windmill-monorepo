#pragma once

#include "platform/subscriptions/Feed.h"

#include <trantor/net/EventLoopThread.h>

#include <mutex>
#include <optional>
#include <string>

namespace wm::subscriptions {

// Where the backend reaches the service's internal doors, and the bearer secret they ask for.
struct ServiceAddress {
  std::string url;
  std::string token;

  // SUBSCRIPTIONS_INTERNAL_URL and SUBSCRIPTIONS_INTERNAL_TOKEN, set but empty counting as unset: neither set is no
  // address, and one without the other throws std::invalid_argument naming the one missing.
  static std::optional<ServiceAddress> from(const char* url, const char* token);
};

// The backend's client of the subscription service's internal doors (§5.2), reached on the container network. Each
// call blocks its caller until the service answers or kTimeoutSeconds pass. No body, query or secret reaches a log.
class SubscriptionServiceClient : public SubscriptionFeed {
public:
  explicit SubscriptionServiceClient(const ServiceAddress& address);
  ~SubscriptionServiceClient() { stop(); }
  void stop();

  FeedPage page(Seq after, int limit) override;

  static constexpr double kTimeoutSeconds = 10.0;

private:
  std::string origin_;  // scheme://host[:port], what drogon dials
  std::string prefix_;  // a path the service is mounted under, "" in the usual case
  std::string token_;
  std::once_flag stopped_;
  trantor::EventLoopThread loop_;
};

}

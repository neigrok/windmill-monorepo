#pragma once

#include "platform/subscriptions/Feed.h"

#include <trantor/net/EventLoopThread.h>

#include <cstdint>
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
  // The URL's parts. The host is looked up at every read: trantor keeps each name it resolves for ten minutes in
  // drogon's client, and the service's address on the compose network changes whenever its container is recreated.
  bool https_ = false;
  std::string host_;
  std::uint16_t port_ = 80;
  std::string authority_;  // host[:port] as the URL writes it, every request's Host
  std::string prefix_;     // a path the service is mounted under, "" in the usual case
  std::string token_;
  std::once_flag stopped_;
  trantor::EventLoopThread loop_;
};

}

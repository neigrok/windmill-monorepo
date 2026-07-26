#pragma once

#include <trantor/net/EventLoopThread.h>

#include <functional>
#include <utility>
#include <vector>
#include <optional>
#include <string>

namespace wm {

// A checkout minted for one click: the transaction already carries the customer and the Windmill
// account, so nothing about identity is left for the browser to supply or get wrong.
struct PaddleCheckout {
  std::string transactionId;
  std::string checkoutUrl;
};

// Windmill calling Paddle's API server-side (the write direction; webhooks are the read direction).
// Mints a fresh transaction per click — a single-use checkout, so a link can never be shared into
// somebody else's session. An empty API key makes configured() false and every checkout a no-op.
class PaddleApiClient {
public:
  PaddleApiClient(std::string apiKey, const std::string& environment);

  bool configured() const { return !apiKey_.empty(); }

  // Find-or-create the Paddle customer for this (already verified) account email, then open a
  // transaction for `priceId` bound to it and stamped with custom_data.user_id. Paddle carries that
  // stamp onto the subscription, so the webhook can bind by our own id instead of matching email.
  void startCheckout(const std::string& email, const std::string& userId, const std::string& priceId,
                     std::function<void(std::optional<PaddleCheckout>)> done);

private:
  void request(int method, const std::string& path,
               const std::vector<std::pair<std::string, std::string>>& query, const std::string& body,
               std::function<void(std::optional<std::string>)> done);
  void createTransaction(const std::string& customerId, const std::string& userId,
                         const std::string& priceId,
                         std::function<void(std::optional<PaddleCheckout>)> done);

  std::string apiKey_;
  std::string host_;
  trantor::EventLoopThread loop_;
};

}

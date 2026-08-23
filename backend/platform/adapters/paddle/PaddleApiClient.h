#pragma once

#include <trantor/net/EventLoopThread.h>

#include <functional>
#include <utility>
#include <vector>
#include <optional>
#include <string>

namespace wm {

// A checkout minted for one click: the transaction already carries the customer and the Windmill account.
struct PaddleCheckout {
  std::string transactionId;
  std::string checkoutUrl;
};

// Windmill calling Paddle's API server-side. Mints a fresh transaction per click — a single-use
// checkout. An empty API key makes configured() false and every checkout a no-op.
class PaddleApiClient {
public:
  PaddleApiClient(std::string apiKey, const std::string& environment);

  bool configured() const { return !apiKey_.empty(); }

  // Find-or-create the Paddle customer for this (already verified) account email, then open a
  // transaction for `priceId` bound to it and stamped with custom_data.user_id.
  void startCheckout(const std::string& email, const std::string& userId, const std::string& priceId,
                     std::function<void(std::optional<PaddleCheckout>)> done);

private:
  // `op` names the operation for the call's log line — one path serves a customer lookup and a customer create.
  void request(int method, const std::string& op, const std::string& path,
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

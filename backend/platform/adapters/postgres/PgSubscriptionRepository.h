#pragma once

#include "platform/ports/SubscriptionRepository.h"

#include <string>

namespace wm {

class PgSubscriptionRepository : public SubscriptionRepository {
public:
  explicit PgSubscriptionRepository(std::string connString);

  void upsertCustomer(const PaddleCustomer& customer) override;
  void upsertSubscription(const PaddleSubscription& subscription) override;
  std::optional<PaddleSubscription> findFor(const UserId& user, const std::string& email) override;

private:
  std::string connString_;
};

}

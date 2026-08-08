#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "platform/ports/SubscriptionRepository.h"

#include <memory>
#include <string>

namespace wm {

class PgSubscriptionRepository : public SubscriptionRepository {
public:
  explicit PgSubscriptionRepository(std::shared_ptr<PgPool> pool);

  void upsertCustomer(const PaddleCustomer& customer) override;
  void upsertSubscription(const PaddleSubscription& subscription) override;
  std::optional<PaddleSubscription> findFor(const UserId& user, const std::string& email) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}

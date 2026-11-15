#pragma once

#include "platform/adapters/postgres/PgAuthRepository.h"
#include "platform/adapters/postgres/PgPool.h"
#include "platform/subscriptions/AccountUnbinds.h"

#include <functional>
#include <memory>

namespace wm::subscriptions {

// owed_subscription_unbinds (db/schema.sql), one row per erased account whose unbind the service has not taken.
class PgOwedUnbinds final : public OwedUnbinds {
public:
  explicit PgOwedUnbinds(std::shared_ptr<PgPool> pool);

  std::vector<OwedUnbind> due(std::int64_t nowMs, int limit) override;
  void keep(const OwedUnbind& owed) override;
  void settle(const UserId& account) override;

private:
  std::shared_ptr<PgPool> pool_;
};

// The erasure's share of an account (PgAuthRepository): the unbind it owes the service, recorded in the erasing
// transaction, so no outage of the service loses it. `owed` runs once that transaction commits.
AccountErasure unbindOnErasure(std::function<void()> owed);

}

#pragma once

#include "platform/adapters/postgres/PgAuthRepository.h"
#include "platform/adapters/postgres/PgPool.h"
#include "platform/subscriptions/AccountUnbinds.h"

#include <functional>
#include <memory>

namespace wm::subscriptions {

// owed_subscription_unbinds (db/schema.sql), one row per deleted account whose unbind the service has not taken, which
// the trigger on every delete of a users row writes in the deleting transaction.
class PgOwedUnbinds final : public OwedUnbinds {
public:
  explicit PgOwedUnbinds(std::shared_ptr<PgPool> pool);

  std::vector<OwedUnbind> due(std::int64_t nowMs, int limit) override;
  void keep(const OwedUnbind& owed) override;
  void settle(const UserId& account) override;

private:
  std::shared_ptr<PgPool> pool_;
};

// The erasure's share of an account (PgAuthRepository), whose users row's delete owes the service its unbind: `owed`
// runs once the erasing transaction commits, so the unbind is tried at once. Any other delete of a users row, as an
// empty account folded into another, owes it alike, and the sweep's minute pass tries it.
AccountErasure unbindOnErasure(std::function<void()> owed);

}

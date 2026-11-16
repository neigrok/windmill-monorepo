#include "platform/adapters/postgres/PgSubscriptionRepository.h"

#include "platform/adapters/postgres/PgPool.h"

#include <pqxx/pqxx>
#include <stdexcept>

namespace wm {

PgSubscriptionRepository::PgSubscriptionRepository(std::shared_ptr<PgPool> pool)
    : pool_(std::move(pool)) {}

void PgSubscriptionRepository::upsertCustomer(const PaddleCustomer& customer) {
  // Keyed on the Paddle id, so a redelivered customer.created and a later customer.updated both
  // land on one row — the email is simply refreshed to whatever Paddle last said.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec("INSERT INTO paddle_customers (customer_id, email) VALUES ($1, $2) "
           "ON CONFLICT (customer_id) DO UPDATE SET email = excluded.email, updated_at = now()",
           pqxx::params{customer.customerId, customer.email});
  txn.commit();
}

void PgSubscriptionRepository::upsertSubscription(const PaddleSubscription& subscription) {
  // Absent optionals land as SQL null: an empty scheduled change means nothing is pending, and an
  // empty user id means this event carried no binding.
  pqxx::params params;
  params.append(subscription.subscriptionId);
  params.append(subscription.customerId);
  if (subscription.userId.empty()) params.append();
  else params.append(subscription.userId);
  params.append(subscription.status);
  params.append(subscription.priceId);
  params.append(subscription.productId);
  if (subscription.scheduledChangeAt.empty()) params.append();
  else params.append(subscription.scheduledChangeAt);
  if (subscription.occurredAt.empty()) params.append();
  else params.append(subscription.occurredAt);

  // coalesce on user_id: only the checkout stamps it, so a later subscription.updated (which
  // carries no custom_data) must never erase the binding we already know.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  if (!subscription.userId.empty() &&
      txn.exec("SELECT id FROM users WHERE id=$1::uuid FOR KEY SHARE", pqxx::params{subscription.userId}).empty())
    throw std::runtime_error("account no longer exists");
  // The trailing WHERE is the staleness guard: a retry of an OLDER event must not overwrite state a
  // NEWER one wrote. A row with no recorded time, or an event carrying none, still applies.
  txn.exec("INSERT INTO paddle_subscriptions "
           "(subscription_id, customer_id, user_id, status, price_id, product_id, "
           "scheduled_change_at, occurred_at) "
           "VALUES ($1, $2, $3::uuid, $4, $5, $6, $7::timestamptz, $8::timestamptz) "
           "ON CONFLICT (subscription_id) DO UPDATE SET "
           "customer_id = excluded.customer_id, "
           "user_id = coalesce(excluded.user_id, paddle_subscriptions.user_id), "
           "status = excluded.status, price_id = excluded.price_id, "
           "product_id = excluded.product_id, "
           "scheduled_change_at = excluded.scheduled_change_at, "
           "occurred_at = excluded.occurred_at, updated_at = now() "
           "WHERE excluded.occurred_at IS NULL "
           "   OR paddle_subscriptions.occurred_at IS NULL "
           "   OR excluded.occurred_at >= paddle_subscriptions.occurred_at",
           params);
  txn.commit();
}

std::optional<PaddleCustomer> PgSubscriptionRepository::findCustomer(const std::string& customerId) {
  PgLease conn{*pool_};
  pqxx::read_transaction txn{*conn};
  const pqxx::result rows =
      txn.exec("SELECT customer_id, email FROM paddle_customers WHERE customer_id=$1", pqxx::params{customerId});
  if (rows.empty()) return std::nullopt;
  return PaddleCustomer{rows[0]["customer_id"].as<std::string>(), rows[0]["email"].as<std::string>()};
}

std::optional<PaddleSubscription> PgSubscriptionRepository::findSubscription(const std::string& subscriptionId) {
  PgLease conn{*pool_};
  pqxx::read_transaction txn{*conn};
  const pqxx::result rows = txn.exec(
      "SELECT subscription_id, customer_id, coalesce(user_id::text, '') AS user_id, status, price_id, product_id, "
      "coalesce(to_json(scheduled_change_at)#>>'{}', '') AS scheduled_change_at, "
      "coalesce(to_json(occurred_at)#>>'{}', '') AS occurred_at "
      "FROM paddle_subscriptions WHERE subscription_id=$1",
      pqxx::params{subscriptionId});
  if (rows.empty()) return std::nullopt;
  return PaddleSubscription{rows[0]["subscription_id"].as<std::string>(),
                            rows[0]["customer_id"].as<std::string>(),
                            rows[0]["user_id"].as<std::string>(),
                            rows[0]["status"].as<std::string>(),
                            rows[0]["price_id"].as<std::string>(),
                            rows[0]["product_id"].as<std::string>(),
                            rows[0]["scheduled_change_at"].as<std::string>(),
                            rows[0]["occurred_at"].as<std::string>()};
}

}

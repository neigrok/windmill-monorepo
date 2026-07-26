#include "platform/adapters/postgres/PgSubscriptionRepository.h"

#include "platform/adapters/postgres/PgConnection.h"

#include <pqxx/pqxx>

#include <string_view>

namespace wm {

namespace {
constexpr std::string_view kSubscriptionColumns =
    "s.subscription_id, s.customer_id, coalesce(s.user_id::text, '') AS user_id, s.status, "
    "s.price_id, s.product_id, "
    "coalesce(to_json(s.scheduled_change_at)#>>'{}', '') AS scheduled_change_at, "
    "coalesce(to_json(s.occurred_at)#>>'{}', '') AS occurred_at";

// Templated on the row type: pqxx names it row_ref on macOS and row on the CI's Linux build, so
// binding it concretely compiles on one and fails on the other.
template <typename Row>
PaddleSubscription subscriptionFrom(const Row& row) {
  return PaddleSubscription{row["subscription_id"].template as<std::string>(),
                            row["customer_id"].template as<std::string>(),
                            row["user_id"].template as<std::string>(),
                            row["status"].template as<std::string>(),
                            row["price_id"].template as<std::string>(),
                            row["product_id"].template as<std::string>(),
                            row["scheduled_change_at"].template as<std::string>(),
                            row["occurred_at"].template as<std::string>()};
}
}

PgSubscriptionRepository::PgSubscriptionRepository(std::string connString)
    : connString_(std::move(connString)) {}

void PgSubscriptionRepository::upsertCustomer(const PaddleCustomer& customer) {
  // Keyed on the Paddle id, so a redelivered customer.created and a later customer.updated both
  // land on one row — the email is simply refreshed to whatever Paddle last said.
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params(
      "INSERT INTO paddle_customers (customer_id, email) VALUES ($1, $2) "
      "ON CONFLICT (customer_id) DO UPDATE SET email = excluded.email, updated_at = now()",
      customer.customerId, customer.email);
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
  pqxx::work txn{pgThreadConnection(connString_)};
  // The trailing WHERE is the staleness guard: a retry of an OLDER event (Paddle retries for days)
  // must not overwrite state a NEWER one already wrote — that is how a canceled subscription would
  // spring back to active. A row with no recorded time, or an event carrying none, still applies.
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

std::optional<PaddleSubscription> PgSubscriptionRepository::findFor(const UserId& user,
                                                                    const std::string& email) {
  // Either binding may match, and an access-granting row wins over a merely newer one — see the
  // port for why (a planted row must not shadow a real subscription).
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kSubscriptionColumns) +
          " FROM paddle_subscriptions s "
          "LEFT JOIN paddle_customers c ON c.customer_id = s.customer_id "
          "WHERE s.user_id = $1::uuid OR c.email = $2 "
          "ORDER BY (s.status IN ('active', 'trialing', 'past_due')) DESC, s.created_at DESC "
          "LIMIT 1",
      user.str(), email);
  if (rows.empty()) return std::nullopt;
  return subscriptionFrom(rows[0]);
}

}

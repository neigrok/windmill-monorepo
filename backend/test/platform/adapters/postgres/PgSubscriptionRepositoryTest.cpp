#include "platform/adapters/postgres/PgSubscriptionRepository.h"

#include "platform/domain/Billing.h"
#include "test/PgTestPool.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <cstdlib>
#include <optional>
#include <string>

// Opt-in integration test: needs a live local Postgres with the schema applied and WM_PG_TEST set; otherwise every case reports skip. It seeds its own rows.
using namespace wm;

namespace {
const char* kNeedsPostgres = "WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7";

const std::string kMine = "44444444-4444-4444-4444-444444444444";
const std::string kStranger = "55555555-5555-5555-5555-555555555555";
const std::string kMyEmail = "billing-pgtest@example.com";

const std::string kSubscription = "sub_pgtest01";
const std::string kCustomer = "ctm_pgtest01";

const std::string kEarly = "2026-05-01T10:00:00Z";
const std::string kLate = "2026-05-08T10:00:00Z";

void reset() {
  PgLease c{*pgTestPool()};
  pqxx::work w{*c};
  w.exec("INSERT INTO users (id, email) VALUES ('" + kMine + "', '" + kMyEmail + "') "
         "ON CONFLICT (id) DO NOTHING");
  w.exec("DELETE FROM paddle_subscriptions WHERE subscription_id LIKE 'sub_pgtest%'");
  w.exec("DELETE FROM paddle_customers WHERE customer_id LIKE 'ctm_pgtest%'");
  w.commit();
}

PaddleSubscription event(const std::string& status, const std::string& occurredAt,
                         const std::string& userId = kMine,
                         const std::string& subscriptionId = kSubscription) {
  return PaddleSubscription{subscriptionId, kCustomer, userId,  status,
                            "pri_pgtest",   "pro_pgtest", "", occurredAt};
}

// Compared IN Postgres: `to_json` renders a timestamptz in the session's own timezone, so a string comparison here would assert the developer's TZ.
bool storedOccurredAtIs(const std::string& iso) {
  std::optional<std::string> value;
  if (!iso.empty()) value = iso;
  PgLease c{*pgTestPool()};
  pqxx::work w{*c};
  const pqxx::result rows = w.exec_params(
      "SELECT occurred_at IS NOT DISTINCT FROM $1::timestamptz FROM paddle_subscriptions "
      "WHERE subscription_id = $2",
      value, kSubscription);
  return rows.size() == 1 && rows[0][0].as<bool>();
}
}

// Paddle retries for days, so wire order is not event order: a replayed "active" landing after a real cancel must not reopen the paid door.
TEST(pg_subscription_a_retried_older_event_never_hands_back_the_access_a_cancel_took_away) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgSubscriptionRepository repo{pgTestPool()};

  repo.upsertSubscription(event("active", kEarly));
  repo.upsertSubscription(event("canceled", kLate));
  repo.upsertSubscription(event("active", kEarly));  // the retry of the first, days late

  const std::optional<PaddleSubscription> row = repo.findFor(UserId{kMine}, kMyEmail);
  REQUIRE(row.has_value());
  CHECK_EQ(row->subscriptionId, kSubscription);
  CHECK_EQ(row->customerId, kCustomer);
  CHECK_EQ(row->userId, kMine);
  CHECK_EQ(row->status, std::string("canceled"));
  CHECK_EQ(row->priceId, std::string("pri_pgtest"));
  CHECK_EQ(row->productId, std::string("pro_pgtest"));
  CHECK_EQ(row->scheduledChangeAt, std::string(""));
  CHECK_FALSE(grantsAccess(row->status));
  CHECK(storedOccurredAtIs(kLate));  // the newer event's own time, still standing

  repo.upsertSubscription(event("active", "2026-06-01T10:00:00Z"));
  const std::optional<PaddleSubscription> resumed = repo.findFor(UserId{kMine}, kMyEmail);
  REQUIRE(resumed.has_value());
  CHECK_EQ(resumed->status, std::string("active"));
  CHECK(grantsAccess(resumed->status));
  CHECK(storedOccurredAtIs("2026-06-01T10:00:00Z"));
}

// The comparison is `>=`, not `>`: Paddle stamps a transaction's events from one instant, so two deliveries can carry the identical occurred_at.
TEST(pg_subscription_a_second_event_stamped_at_the_same_instant_still_applies) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgSubscriptionRepository repo{pgTestPool()};

  repo.upsertSubscription(event("trialing", kLate));
  repo.upsertSubscription(event("active", kLate));

  const std::optional<PaddleSubscription> row = repo.findFor(UserId{kMine}, kMyEmail);
  REQUIRE(row.has_value());
  CHECK_EQ(row->status, std::string("active"));
  CHECK(storedOccurredAtIs(kLate));
}

// Both null arms of the guard: a row written before the column carries no time, and an event that carries none cannot be ordered. Either way the newer write must land.
TEST(pg_subscription_an_event_or_a_row_with_no_recorded_time_still_applies) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgSubscriptionRepository repo{pgTestPool()};

  repo.upsertSubscription(event("active", ""));
  CHECK(storedOccurredAtIs(""));
  repo.upsertSubscription(event("canceled", kEarly));
  const std::optional<PaddleSubscription> canceled = repo.findFor(UserId{kMine}, kMyEmail);
  REQUIRE(canceled.has_value());
  CHECK_EQ(canceled->status, std::string("canceled"));
  CHECK(storedOccurredAtIs(kEarly));

  repo.upsertSubscription(event("active", ""));
  const std::optional<PaddleSubscription> untimed = repo.findFor(UserId{kMine}, kMyEmail);
  REQUIRE(untimed.has_value());
  CHECK_EQ(untimed->status, std::string("active"));
  CHECK(storedOccurredAtIs(""));
}

// Only the checkout stamps custom_data, so a plain `user_id = excluded.user_id` would erase the binding on the first renewal.
TEST(pg_subscription_a_later_event_carrying_no_account_never_erases_the_one_already_bound) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgSubscriptionRepository repo{pgTestPool()};

  repo.upsertSubscription(event("active", kEarly, kMine));
  repo.upsertSubscription(event("past_due", kLate, ""));  // subscription.updated: no custom_data

  const std::optional<PaddleSubscription> row = repo.findFor(UserId{kMine}, kMyEmail);
  REQUIRE(row.has_value());
  CHECK_EQ(row->userId, kMine);
  CHECK_EQ(row->status, std::string("past_due"));
  CHECK(grantsAccess(row->status));
}

// custom_data rides in from a checkout anyone can open, so the read asks "any LIVE subscription" first and only falls back to the newest row for display.
TEST(pg_subscription_a_planted_dead_row_never_shadows_the_subscription_that_pays) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgSubscriptionRepository repo{pgTestPool()};

  repo.upsertSubscription(event("active", kEarly, kMine, "sub_pgtest01"));
  repo.upsertSubscription(event("canceled", kLate, kMine, "sub_pgtest02"));  // planted, and newer

  const std::optional<PaddleSubscription> row = repo.findFor(UserId{kMine}, kMyEmail);
  REQUIRE(row.has_value());
  CHECK_EQ(row->subscriptionId, std::string("sub_pgtest01"));
  CHECK_EQ(row->status, std::string("active"));
  CHECK(grantsAccess(row->status));
}

// The other binding: the Paddle customer's email, matched against the account's. An account with neither binding sees nothing.
TEST(pg_subscription_the_read_finds_a_subscription_bound_only_by_its_customer_s_email) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgSubscriptionRepository repo{pgTestPool()};

  repo.upsertCustomer(PaddleCustomer{kCustomer, kMyEmail});
  repo.upsertSubscription(event("active", kEarly, ""));

  const std::optional<PaddleSubscription> mine = repo.findFor(UserId{kMine}, kMyEmail);
  REQUIRE(mine.has_value());
  CHECK_EQ(mine->subscriptionId, kSubscription);
  CHECK_EQ(mine->userId, std::string(""));
  CHECK_EQ(mine->status, std::string("active"));

  CHECK_FALSE(repo.findFor(UserId{kStranger}, "stranger-pgtest@example.com").has_value());
}

#include "platform/adapters/postgres/PgAiUsageRepository.h"

#include "platform/domain/AiUsage.h"
#include "test/PgTestPool.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <cstdlib>
#include <string>
#include <vector>

// Opt-in integration test: needs a live local Postgres with the schema applied and WM_PG_TEST set; otherwise every case reports skip. It seeds its own rows.
using namespace wm;

namespace {
const char* kNeedsPostgres = "WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7";

const std::string kMine = "66666666-6666-6666-6666-666666666666";
const std::string kOther = "77777777-7777-7777-7777-777777777777";
const std::string kMyEmail = "ai-usage-pgtest@example.com";
const std::string kOtherEmail = "ai-usage-pgtest-other@example.com";

constexpr long long kFromMs = 1'767'225'600'000;  // 2026-01-01T00:00:00Z
constexpr long long kToMs = 1'769'904'000'000;    // 2026-02-01T00:00:00Z
constexpr long long kDayOneMs = 1'767'268'800'000;   // 2026-01-01T12:00:00Z
constexpr long long kDayTwoMs = 1'767'355'200'000;   // 2026-01-02T12:00:00Z
constexpr long long kOutsideMs = 1'764'590'400'000;  // 2025-12-01T12:00:00Z

void reset() {
  PgLease c{*pgTestPool()};
  pqxx::work w{*c};
  w.exec("INSERT INTO users (id, email) VALUES ('" + kMine + "', '" + kMyEmail + "'), ('" + kOther +
         "', '" + kOtherEmail + "') ON CONFLICT (id) DO NOTHING");
  w.exec("DELETE FROM ai_usage WHERE product LIKE 'pgtest-%'");
  w.commit();
}

// The adapter stamps `ts` with now(), and every read here is a window query, so a row has to be moved into the window afterwards.
void stampLatest(long long atMs) {
  PgLease c{*pgTestPool()};
  pqxx::work w{*c};
  w.exec_params("UPDATE ai_usage SET ts = to_timestamp($1::bigint / 1000.0) "
                "WHERE id = (SELECT max(id) FROM ai_usage WHERE product LIKE 'pgtest-%')",
                atMs);
  w.commit();
}

// `to_char` renders a timestamptz in the session's own timezone, so ask Postgres what day it calls that instant rather than hard-coding one.
std::string dayOf(long long atMs) {
  PgLease c{*pgTestPool()};
  pqxx::work w{*c};
  const pqxx::result rows =
      w.exec_params("SELECT to_char(to_timestamp($1::bigint / 1000.0), 'YYYY-MM-DD')", atMs);
  return rows[0][0].as<std::string>();
}

AiSpend spend(const std::string& product, const std::string& model, const std::string& user,
              const TokenUse& tokens, const std::string& outcome = AiOutcome::ok) {
  AiSpend row;
  if (!user.empty()) row.user = UserId{user};
  row.product = product;
  row.operation = "pgtest-op";
  row.model = model;
  row.runId = "run-pgtest";
  row.outcome = outcome;
  row.tokens = tokens;
  row.iteration = 2;
  return row;
}
}

TEST(pg_ai_usage_a_recorded_call_stores_every_count_and_the_cost_it_priced) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAiUsageRepository repo{pgTestPool()};

  repo.record(spend("pgtest-roadmap", "claude-sonnet-5", kMine, TokenUse{400, 1000, 8000, 2000}));

  PgLease c{*pgTestPool()};
  pqxx::work w{*c};
  const pqxx::result rows = w.exec(
      "SELECT user_id::text, product, operation, run_id, iteration, model, outcome, input_tokens, "
      "output_tokens, cache_read_tokens, cache_write_tokens, cost_nanos FROM ai_usage "
      "WHERE product LIKE 'pgtest-%'");
  REQUIRE_EQ(rows.size(), 1u);
  CHECK_EQ(rows[0][0].as<std::string>(), kMine);
  CHECK_EQ(rows[0][1].as<std::string>(), std::string("pgtest-roadmap"));
  CHECK_EQ(rows[0][2].as<std::string>(), std::string("pgtest-op"));
  CHECK_EQ(rows[0][3].as<std::string>(), std::string("run-pgtest"));
  CHECK_EQ(rows[0][4].as<int>(), 2);
  CHECK_EQ(rows[0][5].as<std::string>(), std::string("claude-sonnet-5"));
  CHECK_EQ(rows[0][6].as<std::string>(), std::string("ok"));
  CHECK_EQ(rows[0][7].as<long long>(), 400);
  CHECK_EQ(rows[0][8].as<long long>(), 1000);
  CHECK_EQ(rows[0][9].as<long long>(), 8000);
  CHECK_EQ(rows[0][10].as<long long>(), 2000);
  CHECK_FALSE(rows[0][11].is_null());
  CHECK_EQ(rows[0][11].as<long long>(), *costNanos("claude-sonnet-5", TokenUse{400, 1000, 8000, 2000}));
}

TEST(pg_ai_usage_an_anonymous_call_and_an_unpriced_model_both_store_the_absence_honestly) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAiUsageRepository repo{pgTestPool()};

  repo.record(spend("pgtest-roadmap", "claude-haiku-4-5", "", TokenUse{300, 100, 0, 0}));
  repo.record(spend("pgtest-roadmap", "some-model-we-never-priced", kMine, TokenUse{500, 500, 0, 0},
                    AiOutcome::truncated));

  PgLease c{*pgTestPool()};
  pqxx::work w{*c};
  const pqxx::result rows = w.exec(
      "SELECT user_id IS NULL, cost_nanos IS NULL, coalesce(cost_nanos, -1), outcome "
      "FROM ai_usage WHERE product LIKE 'pgtest-%' ORDER BY id");
  REQUIRE_EQ(rows.size(), 2u);
  CHECK(rows[0][0].as<bool>());
  CHECK_FALSE(rows[0][1].as<bool>());
  CHECK_EQ(rows[0][2].as<long long>(), 800'000);  // 300 × 1000 + 100 × 5000 — not zero, which is why nanos
  CHECK_EQ(rows[0][3].as<std::string>(), std::string("ok"));
  CHECK_FALSE(rows[1][0].as<bool>());
  CHECK(rows[1][1].as<bool>());
  CHECK_EQ(rows[1][3].as<std::string>(), std::string("truncated"));
}

TEST(pg_ai_usage_a_row_the_database_refuses_is_swallowed_rather_than_thrown_at_the_product) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAiUsageRepository repo{pgTestPool()};

  // user_id is a uuid column and this is not a uuid: the insert cannot succeed.
  AiSpend broken = spend("pgtest-roadmap", "claude-sonnet-5", "not-a-uuid", TokenUse{1, 1, 0, 0});
  repo.record(broken);

  PgLease c{*pgTestPool()};
  pqxx::work w{*c};
  const pqxx::result rows = w.exec("SELECT count(*) FROM ai_usage WHERE product LIKE 'pgtest-%'");
  REQUIRE_EQ(rows.size(), 1u);
  CHECK_EQ(rows[0][0].as<long long>(), 0);

  repo.record(spend("pgtest-roadmap", "claude-sonnet-5", kMine, TokenUse{1, 1, 0, 0}));
  const pqxx::result after = w.exec("SELECT count(*) FROM ai_usage WHERE product LIKE 'pgtest-%'");
  CHECK_EQ(after[0][0].as<long long>(), 1);
}

// The budget read: one account, one rolling window, optionally one product.
TEST(pg_ai_usage_the_budget_read_sums_one_account_s_window_and_one_product_of_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAiUsageRepository repo{pgTestPool()};

  repo.record(spend("pgtest-roadmap", "claude-sonnet-5", kMine, TokenUse{1000, 1000, 0, 0}));
  stampLatest(kDayOneMs);
  repo.record(spend("pgtest-journal", "claude-sonnet-5", kMine, TokenUse{1000, 0, 0, 0}));
  stampLatest(kDayTwoMs);
  repo.record(spend("pgtest-roadmap", "claude-sonnet-5", kMine, TokenUse{1000, 1000, 0, 0}));
  stampLatest(kOutsideMs);  // before the window: never counted
  repo.record(spend("pgtest-roadmap", "claude-sonnet-5", kOther, TokenUse{1000, 1000, 0, 0}));
  stampLatest(kDayOneMs);  // someone else's spend: never counted
  repo.record(spend("pgtest-roadmap", "unpriced-model", kMine, TokenUse{9999, 9999, 0, 0}));
  stampLatest(kDayOneMs);  // unpriced: charged the DEAREST rate we know, never nothing

  // 9999 in + 9999 out at the fable rate ($10/$50 per MTok): the ceiling's read takes the floor column, while the dashboard's read shows the nullable truth.
  const long long floor = 9999LL * 10'000 + 9999LL * 50'000;

  CHECK_EQ(repo.spentSinceNanos(UserId{kMine}, "", kFromMs), 21'000'000 + floor);
  CHECK_EQ(repo.spentSinceNanos(UserId{kMine}, "pgtest-roadmap", kFromMs), 18'000'000 + floor);
  CHECK_EQ(repo.spentSinceNanos(UserId{kMine}, "pgtest-journal", kFromMs), 3'000'000);
  CHECK_EQ(repo.spentSinceNanos(UserId{kMine}, "pgtest-nothing", kFromMs), 0);
  CHECK_EQ(repo.spentSinceNanos(UserId{kOther}, "", kFromMs), 18'000'000);
  CHECK_EQ(repo.spentSinceNanos(UserId{kMine}, "", kToMs), 0);
}

// Every aggregate row carries its own unpricedCalls, which is what lets the page mark a total as a floor.
TEST(pg_ai_usage_the_summary_carries_unpriced_counts_on_every_aggregate_row) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAiUsageRepository repo{pgTestPool()};

  repo.record(spend("pgtest-roadmap", "claude-sonnet-5", kMine, TokenUse{1000, 1000, 500, 200}));
  stampLatest(kDayOneMs);
  repo.record(spend("pgtest-roadmap", "unpriced-a", kMine, TokenUse{10, 10, 0, 0}));
  stampLatest(kDayOneMs);
  repo.record(spend("pgtest-journal", "claude-haiku-4-5", "", TokenUse{300, 100, 0, 0}));
  stampLatest(kDayTwoMs);
  repo.record(spend("pgtest-journal", "unpriced-b", kOther, TokenUse{0, 0, 0, 0}));
  stampLatest(kDayTwoMs);
  repo.record(spend("pgtest-roadmap", "claude-sonnet-5", kMine, TokenUse{99'999, 0, 0, 0}));
  stampLatest(kOutsideMs);  // outside the window entirely

  const long long sonnet = *costNanos("claude-sonnet-5", TokenUse{1000, 1000, 500, 200});
  const long long haiku = *costNanos("claude-haiku-4-5", TokenUse{300, 100, 0, 0});

  const UsageSummary summary = repo.summary(kFromMs, kToMs);
  CHECK_EQ(summary.costNanos, sonnet + haiku);
  CHECK_EQ(summary.calls, 4);
  CHECK_EQ(summary.unpricedCalls, 2);
  CHECK_EQ(summary.inputTokens, 1000 + 10 + 300);
  CHECK_EQ(summary.outputTokens, 1000 + 10 + 100);
  CHECK_EQ(summary.cacheReadTokens, 500);
  CHECK_EQ(summary.cacheWriteTokens, 200);
  CHECK_EQ(summary.anonymousCostNanos, haiku);

  REQUIRE_EQ(summary.byProduct.size(), 2u);
  CHECK_EQ(summary.byProduct[0].product, std::string("pgtest-roadmap"));
  CHECK_EQ(summary.byProduct[0].costNanos, sonnet);
  CHECK_EQ(summary.byProduct[0].calls, 2);
  CHECK_EQ(summary.byProduct[0].unpricedCalls, 1);
  CHECK_EQ(summary.byProduct[1].product, std::string("pgtest-journal"));
  CHECK_EQ(summary.byProduct[1].costNanos, haiku);
  CHECK_EQ(summary.byProduct[1].calls, 2);
  CHECK_EQ(summary.byProduct[1].unpricedCalls, 1);

  REQUIRE_EQ(summary.daily.size(), 2u);
  CHECK_EQ(summary.daily[0].day, dayOf(kDayOneMs));
  CHECK_EQ(summary.daily[0].costNanos, sonnet);
  CHECK_EQ(summary.daily[0].calls, 2);
  CHECK_EQ(summary.daily[0].unpricedCalls, 1);
  CHECK_EQ(summary.daily[1].day, dayOf(kDayTwoMs));
  CHECK_EQ(summary.daily[1].costNanos, haiku);
  CHECK_EQ(summary.daily[1].calls, 2);
  CHECK_EQ(summary.daily[1].unpricedCalls, 1);

  REQUIRE_EQ(summary.unpricedModels.size(), 2u);
  CHECK_EQ(summary.unpricedModels[0], std::string("unpriced-a"));
  CHECK_EQ(summary.unpricedModels[1], std::string("unpriced-b"));
}

// The ranked table is a list of PEOPLE: anonymous spend belongs in the total and nowhere near this query.
TEST(pg_ai_usage_the_ranked_table_names_people_and_never_the_anonymous_canvas) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAiUsageRepository repo{pgTestPool()};

  repo.record(spend("pgtest-roadmap", "claude-opus-5", kMine, TokenUse{1000, 1000, 0, 0}));
  stampLatest(kDayOneMs);
  repo.record(spend("pgtest-journal", "claude-sonnet-5", kMine, TokenUse{1000, 0, 0, 0}));
  stampLatest(kDayOneMs);
  repo.record(spend("pgtest-journal", "unpriced-c", kMine, TokenUse{5, 5, 0, 0}));
  stampLatest(kDayOneMs);
  repo.record(spend("pgtest-journal", "claude-sonnet-5", kOther, TokenUse{1000, 0, 0, 0}));
  stampLatest(kDayTwoMs);
  repo.record(spend("pgtest-roadmap", "claude-opus-5", "", TokenUse{9000, 9000, 0, 0}));
  stampLatest(kDayOneMs);  // the biggest spender in the window, and not a person

  const std::vector<UserSpend> spenders = repo.topSpenders(kFromMs, kToMs, 10);
  REQUIRE_EQ(spenders.size(), 2u);

  CHECK_EQ(spenders[0].user, UserId{kMine});
  CHECK_EQ(spenders[0].email, kMyEmail);
  CHECK_EQ(spenders[0].costNanos, 30'000'000 + 3'000'000);
  CHECK_EQ(spenders[0].calls, 3);
  CHECK_EQ(spenders[0].unpricedCalls, 1);
  CHECK_EQ(spenders[0].topProduct, std::string("pgtest-roadmap"));

  CHECK_EQ(spenders[1].user, UserId{kOther});
  CHECK_EQ(spenders[1].email, kOtherEmail);
  CHECK_EQ(spenders[1].costNanos, 3'000'000);
  CHECK_EQ(spenders[1].calls, 1);
  CHECK_EQ(spenders[1].unpricedCalls, 0);
  CHECK_EQ(spenders[1].topProduct, std::string("pgtest-journal"));

  const std::vector<UserSpend> top = repo.topSpenders(kFromMs, kToMs, 1);
  REQUIRE_EQ(top.size(), 1u);
  CHECK_EQ(top[0].user, UserId{kMine});
}

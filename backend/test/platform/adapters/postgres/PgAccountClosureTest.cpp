#include "platform/adapters/postgres/PgAuthRepository.h"
#include "platform/adapters/postgres/PgRetentionStore.h"
#include "test/PgTestPool.h"
#include "test/testing.h"

#include <atomic>
#include <barrier>
#include <chrono>
#include <future>
#include <fstream>
#include <iterator>
#include <thread>

using namespace wm;

namespace {
struct ClosureDatabase {
  std::shared_ptr<PgOAuthRepository> oauth = std::make_shared<PgOAuthRepository>(pgTestPool());
  PgAuthRepository auth{pgTestPool(), nullptr, {}, oauth};
  UserId account{"a1100000-0000-4000-8000-000000000001"};
  UserId other{"a1100000-0000-4000-8000-000000000002"};
  UnixMs now = 1700000000000;
  AccountClosure operation{"a2200000-0000-4000-8000-000000000001", std::string(64, 'a'), now};

  ClosureDatabase() {
    PgLease connection{*pgTestPool()};
    pqxx::work tx{*connection};
    tx.exec("DROP TRIGGER IF EXISTS closure_test_fault ON users");
    tx.exec("DROP FUNCTION IF EXISTS closure_test_fault()");
    tx.exec_params("DELETE FROM account_closures WHERE account_id IN ($1::uuid,$2::uuid)", account.str(), other.str());
    tx.exec_params("DELETE FROM users WHERE id IN ($1::uuid,$2::uuid)", account.str(), other.str());
    tx.exec_params("INSERT INTO users(id,email) VALUES($1::uuid,'closure-pg@example.com'),($2::uuid,'other-closure-pg@example.com')",
        account.str(), other.str());
    tx.exec("INSERT INTO oauth_clients(client_id,redirect_uris) VALUES('closure-test-client',ARRAY['https://client.example/callback']) ON CONFLICT DO NOTHING");
    tx.commit();
    auth.insertSession("closure-session", account, now + 1000000, "", "", now);
    auth.insertSession("closure-other", other, now + 1000000, "", "", now);
    oauth->insertCode("closure-code", {"closure-test-client", account, "https://client.example/callback", "challenge", "resource", "", now + 1000000}, "closure-session", now);
    oauth->insertToken("closure-token", "closure-refresh", {"closure-test-client", account, "resource", "", now + 1000000}, now + 2000000, now);
  }

  ~ClosureDatabase() {
    PgLease connection{*pgTestPool()};
    pqxx::work tx{*connection};
    tx.exec("DROP TRIGGER IF EXISTS closure_test_fault ON users");
    tx.exec("DROP FUNCTION IF EXISTS closure_test_fault()");
    tx.exec_params("DELETE FROM account_closures WHERE account_id IN ($1::uuid,$2::uuid)", account.str(), other.str());
    tx.exec_params("DELETE FROM users WHERE id IN ($1::uuid,$2::uuid)", account.str(), other.str());
    tx.exec("DELETE FROM oauth_clients WHERE client_id='closure-test-client'");
    tx.commit();
  }

  struct At : Clock {
    UnixMs ms;
    explicit At(UnixMs ms) : ms(ms) {}
    std::uint64_t nowMs() override { return ms; }
  };

  AccountCloseResult close(PgAuthRepository& repository, const AccountClosure& closure, const std::string& session, UnixMs at) {
    At clock{at};
    return repository.closeWithReceipt(account, closure, session, clock);
  }

  ClosureReceipt expected() const {
    return {ClosureOutcome::closed, now + AuthPolicy::closeGraceMs, now + AuthPolicy::closeReceiptLifetimeMs};
  }

  std::vector<long long> rows() {
    PgLease connection{*pgTestPool()};
    pqxx::work tx{*connection};
    const auto rows = tx.exec_params(
        "SELECT (SELECT count(*) FROM sessions WHERE user_id=$1::uuid),"
        "(SELECT count(*) FROM oauth_tokens WHERE user_id=$1::uuid),"
        "(SELECT count(*) FROM oauth_codes WHERE user_id=$1::uuid),"
        "(SELECT count(*) FROM oauth_grants WHERE user_id=$1::uuid),"
        "(SELECT count(*) FROM account_closures WHERE account_id=$1::uuid)", account.str());
    std::vector<long long> result;
    for (const auto& field : rows[0]) result.push_back(field.as<long long>());
    return result;
  }
};
}

TEST(pg_account_closure_is_atomic_and_a_new_repository_recovers_the_same_result) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset");
  ClosureDatabase h;
  const auto first = h.close(h.auth, h.operation, "closure-session", h.now);
  CHECK_EQ(first.receipt, h.expected());
  CHECK_EQ(first.revokedSessions, (std::vector<std::string>{"closure-session"}));
  CHECK_EQ(h.rows(), (std::vector<long long>{0, 0, 0, 0, 1}));
  CHECK_EQ(h.auth.findUserById(h.account)->closesAt, std::optional<UnixMs>{h.expected().closesAt});
  CHECK(h.auth.findSession("closure-other").has_value());
  PgAuthRepository restarted{pgTestPool(), nullptr, {}, h.oauth};
  CHECK_EQ(restarted.closureReceipt(h.account, h.operation, h.now + 10000), h.expected());
  const auto retry = h.close(restarted, h.operation, "closure-session", h.now + 10000);
  CHECK_EQ(retry.receipt, h.expected());
  CHECK(retry.revokedSessions.empty());
  auto conflicting = h.operation;
  conflicting.proofDigest = std::string(64, 'b');
  CHECK_EQ(h.close(restarted, conflicting, "closure-session", h.now).receipt, ClosureReceipt{});
  CHECK_EQ(restarted.closureReceipt(h.other, h.operation, h.now), ClosureReceipt{});
  CHECK_EQ(h.rows(), (std::vector<long long>{0, 0, 0, 0, 1}));
}

TEST(pg_account_closure_failure_rolls_back_receipt_credentials_and_account_together) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset");
  ClosureDatabase h;
  {
    PgLease connection{*pgTestPool()};
    pqxx::work tx{*connection};
    tx.exec("CREATE FUNCTION closure_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private injected closure fault'; END $$");
    tx.exec("CREATE TRIGGER closure_test_fault BEFORE UPDATE OF deleted_at ON users FOR EACH ROW EXECUTE FUNCTION closure_test_fault()");
    tx.commit();
  }
  bool failed = false;
  try { h.close(h.auth, h.operation, "closure-session", h.now); }
  catch (const pqxx::sql_error&) { failed = true; }
  CHECK(failed);
  CHECK_EQ(h.rows(), (std::vector<long long>{1, 1, 1, 1, 0}));
  CHECK_FALSE(h.auth.findUserById(h.account)->deletedAt.has_value());
  CHECK_EQ(h.auth.closureReceipt(h.account, h.operation, h.now), ClosureReceipt{});
  {
    PgLease connection{*pgTestPool()};
    pqxx::work tx{*connection};
    tx.exec("DROP TRIGGER closure_test_fault ON users");
    tx.commit();
  }
  CHECK_EQ(h.close(h.auth, h.operation, "closure-session", h.now).receipt, h.expected());
}

TEST(pg_account_closure_serializes_pre_authenticated_operations_without_extending_grace) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset");
  ClosureDatabase h;
  h.auth.insertSession("closure-second", h.account, h.now + 1000000, "", "", h.now);
  auto otherOperation = h.operation;
  otherOperation.operationId = "a2200000-0000-4000-8000-000000000002";
  std::barrier start{3};
  auto first = std::async(std::launch::async, [&] {
    start.arrive_and_wait();
    return h.close(h.auth, h.operation, "closure-session", h.now);
  });
  auto second = std::async(std::launch::async, [&] {
    start.arrive_and_wait();
    return h.close(h.auth, otherOperation, "closure-second", h.now + 1000);
  });
  start.arrive_and_wait();
  const auto one = first.get();
  const auto two = second.get();
  const bool firstWon = one.receipt.outcome == ClosureOutcome::closed;
  CHECK_EQ(firstWon ? two.receipt : one.receipt, (ClosureReceipt{ClosureOutcome::unauthorized}));
  const auto winner = firstWon ? one.receipt : two.receipt;
  CHECK_EQ(h.auth.findUserById(h.account)->closesAt, std::optional<UnixMs>{winner.closesAt});
  CHECK_EQ(h.rows(), (std::vector<long long>{0, 0, 0, 0, 1}));
  CHECK_EQ(h.auth.markUserDeleted(h.account, h.now + 2000, closesAt(h.now + 2000)), winner.closesAt);
  CHECK_EQ(h.auth.findUserById(h.account)->closesAt, std::optional<UnixMs>{winner.closesAt});
}

TEST(pg_account_closure_legacy_first_preserves_deadline_and_refuses_a_second_operation) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset");
  ClosureDatabase h;
  h.auth.revokeAllSessions(h.account);
  h.oauth->revokeAllGrants(h.account);
  CHECK_EQ(h.auth.markUserDeleted(h.account, h.now, closesAt(h.now)), closesAt(h.now));
  CHECK_EQ(h.close(h.auth, h.operation, "closure-session", h.now + 1000).receipt,
      (ClosureReceipt{ClosureOutcome::unauthorized}));
  CHECK_EQ(h.auth.markUserDeleted(h.account, h.now + 2000, closesAt(h.now + 2000)), closesAt(h.now));
  CHECK_EQ(h.rows(), (std::vector<long long>{0, 0, 0, 0, 0}));
}

TEST(pg_account_closure_historical_receipt_does_not_reclose_a_restored_account_and_survives_erasure) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset");
  ClosureDatabase h;
  CHECK_EQ(h.close(h.auth, h.operation, "closure-session", h.now).receipt, h.expected());
  CHECK(h.auth.reviveUser(h.account, h.now + 1000));
  h.auth.insertSession("closure-restored", h.account, h.now + 1000000, "", "", h.now + 1000);
  CHECK_EQ(h.close(h.auth, h.operation, "closure-restored", h.now + 1000).receipt, h.expected());
  CHECK_FALSE(h.auth.findUserById(h.account)->deletedAt.has_value());
  CHECK(h.auth.findSession("closure-restored").has_value());
  auto next = h.operation;
  next.operationId = "a2200000-0000-4000-8000-000000000003";
  next.requestedAt = h.now + 2000;
  const auto closedAgain = h.close(h.auth, next, "closure-restored", h.now + 2000);
  CHECK_EQ(closedAgain.receipt, (ClosureReceipt{ClosureOutcome::closed, closesAt(h.now + 2000), h.now + 2000 + AuthPolicy::closeReceiptLifetimeMs}));
  CHECK_EQ(h.auth.closureReceipt(h.account, h.operation, h.now + 3000), h.expected());
  CHECK(h.auth.eraseAccount(h.account, closedAgain.receipt.closesAt));
  CHECK_FALSE(h.auth.findUserById(h.account).has_value());
  CHECK_EQ(h.auth.closureReceipt(h.account, h.operation, closedAgain.receipt.closesAt), h.expected());
  CHECK_EQ(h.auth.closureReceipt(h.account, next, closedAgain.receipt.closesAt), closedAgain.receipt);
}

TEST(pg_account_closure_expiry_and_retention_never_admit_an_old_operation_again) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset");
  ClosureDatabase h;
  CHECK_EQ(h.close(h.auth, h.operation, "closure-session", h.now).receipt, h.expected());
  CHECK(h.auth.reviveUser(h.account, h.now + 1000));
  const auto expiredAt = h.expected().expiresAt;
  h.auth.insertSession("closure-restored", h.account, expiredAt + 1000000, "", "", expiredAt);
  CHECK_EQ(h.auth.closureReceipt(h.account, h.operation, expiredAt - 1), h.expected());
  CHECK_EQ(h.auth.closureReceipt(h.account, h.operation, expiredAt), ClosureReceipt{});
  CHECK_EQ(h.close(h.auth, h.operation, "closure-restored", expiredAt).receipt, ClosureReceipt{});
  PgRetentionStore retention{pgTestPool()};
  const auto report = retention.purge(RetentionWindows{0, 0, 0, 10000}, expiredAt);
  CHECK_EQ(report.accountClosures, 1);
  CHECK_EQ(h.close(h.auth, h.operation, "closure-restored", expiredAt + 1).receipt, ClosureReceipt{});
  CHECK_FALSE(h.auth.findUserById(h.account)->deletedAt.has_value());
  CHECK(h.auth.findSession("closure-restored").has_value());
  CHECK_EQ(h.rows(), (std::vector<long long>{1, 0, 0, 0, 0}));
}

TEST(pg_account_closure_rejects_consumed_oauth_code_and_refresh_even_after_restoration) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset");
  ClosureDatabase h;
  const auto code = h.oauth->takeCode("closure-code");
  const auto refresh = h.oauth->rotateRefreshToken("closure-refresh", h.now);
  REQUIRE(code.has_value());
  REQUIRE_EQ(refresh.outcome, RefreshOutcome::rotated);
  REQUIRE(refresh.grant.has_value());
  const StoredToken exchange{code->clientId, code->user, code->resource, code->scope,
                            h.now + 1000000, code->accountGeneration};
  CHECK_EQ(h.close(h.auth, h.operation, "closure-session", h.now).receipt, h.expected());
  CHECK_FALSE(h.oauth->insertCode("revoked-consent", *code, "closure-session", h.now));
  CHECK_FALSE(h.oauth->insertToken("late-code", "late-code-refresh", exchange, h.now + 2000000, h.now));
  CHECK_FALSE(h.oauth->insertToken("late-refresh", "late-refresh-refresh", *refresh.grant, h.now + 2000000));
  CHECK(h.auth.reviveUser(h.account, h.now + 1000));
  CHECK_FALSE(h.oauth->insertToken("late-code", "late-code-refresh", exchange, h.now + 2000000, h.now + 1000));
  CHECK_FALSE(h.oauth->insertToken("late-refresh", "late-refresh-refresh", *refresh.grant, h.now + 2000000));
  CHECK_EQ(h.rows(), (std::vector<long long>{0, 0, 0, 0, 1}));
  CHECK_FALSE(h.oauth->findAccessToken("late-code"));
  CHECK_FALSE(h.oauth->findAccessToken("late-refresh"));
  CHECK_EQ(h.oauth->rotateRefreshToken("late-code-refresh", h.now + 1000).outcome, RefreshOutcome::unknown);
  CHECK_FALSE(h.oauth->insertCode("revoked-consent", *code, "closure-session", h.now + 1000));
  h.auth.insertSession("restored-consent", h.account, h.now + 1000000, "", "", h.now + 1000);
  CHECK(h.oauth->insertCode("new-consent", *code, "restored-consent", h.now + 1000));
  const auto newCode = h.oauth->takeCode("new-consent");
  REQUIRE(newCode.has_value());
  CHECK_EQ(newCode->accountGeneration, code->accountGeneration + 1);
  const StoredToken newExchange{newCode->clientId, newCode->user, newCode->resource, newCode->scope,
                               h.now + 1000000, newCode->accountGeneration};
  CHECK(h.oauth->insertToken("new-token", "new-refresh", newExchange, h.now + 2000000, h.now + 1000));
  const auto token = h.oauth->findAccessToken("new-token");
  REQUIRE(token.has_value());
  CHECK_EQ(token->accountGeneration, newCode->accountGeneration);
  CHECK_EQ(h.rows(), (std::vector<long long>{1, 1, 0, 1, 1}));
}

TEST(pg_account_closure_and_concurrent_oauth_insert_leave_no_usable_late_token) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset");
  ClosureDatabase h;
  const auto code = h.oauth->takeCode("closure-code");
  REQUIRE(code.has_value());
  const StoredToken exchange{code->clientId, code->user, code->resource, code->scope,
                            h.now + 1000000, code->accountGeneration};
  std::barrier start{3};
  auto close = std::async(std::launch::async, [&] {
    start.arrive_and_wait();
    return h.close(h.auth, h.operation, "closure-session", h.now);
  });
  auto mint = std::async(std::launch::async, [&] {
    start.arrive_and_wait();
    return h.oauth->insertToken("concurrent-token", "concurrent-refresh", exchange, h.now + 2000000, h.now);
  });
  start.arrive_and_wait();
  CHECK_EQ(close.get().receipt, h.expected());
  mint.get();
  CHECK_EQ(h.rows(), (std::vector<long long>{0, 0, 0, 0, 1}));
  CHECK_FALSE(h.oauth->findAccessToken("concurrent-token"));
  CHECK(h.auth.reviveUser(h.account, h.now + 1000));
  CHECK_FALSE(h.oauth->findAccessToken("concurrent-token"));
  CHECK_EQ(h.oauth->rotateRefreshToken("concurrent-refresh", h.now + 1000).outcome, RefreshOutcome::unknown);
}

TEST(pg_account_closure_generation_guards_legacy_race_rows_after_restoration) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset");
  ClosureDatabase h;
  h.auth.revokeAllSessions(h.account);
  h.oauth->revokeAllGrants(h.account);
  CHECK(h.oauth->insertToken("legacy-late", "legacy-refresh",
      {"closure-test-client", h.account, "resource", "", h.now + 1000000}, h.now + 2000000, h.now));
  CHECK_EQ(h.auth.markUserDeleted(h.account, h.now, closesAt(h.now)), closesAt(h.now));
  CHECK_FALSE(h.oauth->findAccessToken("legacy-late"));
  CHECK_EQ(h.oauth->rotateRefreshToken("legacy-refresh", h.now).outcome, RefreshOutcome::unknown);
  CHECK(h.auth.reviveUser(h.account, h.now + 1000));
  CHECK_FALSE(h.oauth->findAccessToken("legacy-late"));
  CHECK_EQ(h.oauth->rotateRefreshToken("legacy-refresh", h.now + 1000).outcome, RefreshOutcome::unknown);
}

TEST(pg_account_closure_schema_fences_existing_closed_accounts_idempotently) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset");
  ClosureDatabase h;
  h.auth.revokeAllSessions(h.account);
  std::ifstream file{WM_SCHEMA_SQL};
  REQUIRE(file.is_open());
  const std::string schema{std::istreambuf_iterator<char>{file}, std::istreambuf_iterator<char>{}};
  {
    PgLease connection{*pgTestPool()};
    pqxx::work tx{*connection};
    tx.exec_params("UPDATE users SET deleted_at=to_timestamp($2::double precision / 1000.0), "
                   "closes_at=to_timestamp($3::double precision / 1000.0), oauth_generation=0 WHERE id=$1::uuid",
                   h.account.str(), h.now, closesAt(h.now));
    tx.exec(schema);
    const auto first = tx.exec_params("SELECT oauth_generation FROM users WHERE id IN ($1::uuid,$2::uuid) ORDER BY id",
                                     h.account.str(), h.other.str());
    CHECK_EQ(first[0][0].as<int>(), 1);
    CHECK_EQ(first[1][0].as<int>(), 0);
    tx.exec_params("UPDATE users SET oauth_generation=7 WHERE id=$1::uuid", h.other.str());
    tx.exec(schema);
    const auto second = tx.exec_params("SELECT oauth_generation FROM users WHERE id IN ($1::uuid,$2::uuid) ORDER BY id",
                                      h.account.str(), h.other.str());
    CHECK_EQ(second[0][0].as<int>(), 1);
    CHECK_EQ(second[1][0].as<int>(), 7);
    tx.commit();
  }
  CHECK_FALSE(h.oauth->findAccessToken("closure-token"));
  CHECK_EQ(h.oauth->rotateRefreshToken("closure-refresh", h.now).outcome, RefreshOutcome::unknown);
  CHECK(h.auth.reviveUser(h.account, h.now + 1000));
  CHECK_FALSE(h.oauth->findAccessToken("closure-token"));
  CHECK_EQ(h.oauth->rotateRefreshToken("closure-refresh", h.now + 1000).outcome, RefreshOutcome::unknown);
  const auto code = h.oauth->takeCode("closure-code");
  REQUIRE(code.has_value());
  CHECK_FALSE(h.oauth->insertToken("pre-migration-exchange", "pre-migration-refresh",
      {code->clientId, code->user, code->resource, code->scope, h.now + 1000000, code->accountGeneration},
      h.now + 2000000, h.now + 1000));
}

TEST(pg_account_closure_held_at_the_lock_past_the_window_never_commits_after_a_stale_answer) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset");
  ClosureDatabase h;
  struct Moving : Clock {
    std::atomic<UnixMs> ms{0};
    std::uint64_t nowMs() override { return ms.load(); }
  } clock;
  clock.ms = h.now;
  PgLease blocker{*pgTestPool()};
  pqxx::work hold{*blocker};
  hold.exec_params("SELECT 1 FROM users WHERE id = $1::uuid FOR UPDATE", h.account.str());
  auto held = std::async(std::launch::async, [&] {
    return h.auth.closeWithReceipt(h.account, h.operation, "closure-session", clock);
  });
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
  for (bool waiting = false; !waiting;) {
    REQUIRE(std::chrono::steady_clock::now() < deadline);
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
    PgLease connection{*pgTestPool()};
    pqxx::work tx{*connection};
    waiting = tx.exec("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()")[0][0]
        .as<long long>() > 0;
  }
  clock.ms = h.now + AuthPolicy::closeRequestWindowMs;
  CHECK_EQ(h.auth.closureReceipt(h.account, h.operation, clock.ms), ClosureReceipt{});
  hold.commit();
  CHECK_EQ(held.get().receipt, ClosureReceipt{});
  CHECK_EQ(h.close(h.auth, h.operation, "closure-session", clock.ms).receipt, ClosureReceipt{});
  CHECK_EQ(h.rows(), (std::vector<long long>{1, 1, 1, 1, 0}));
  CHECK_FALSE(h.auth.findUserById(h.account)->deletedAt.has_value());
}

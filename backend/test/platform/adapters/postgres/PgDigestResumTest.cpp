#include "platform/application/sync/DigestResum.h"

#include "platform/application/WorkerPool.h"
#include "platform/application/sync/Admission.h"
#include "platform/application/sync/SyncService.h"
#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/Jcs.h"
#include "test/platform/Fakes.h"
#include "test/platform/adapters/postgres/PgSyncWorld.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <optional>
#include <string>
#include <vector>

// §6.12 from scratch over Postgres: a stored digest that no longer matches the scope's rows is rewritten to
// the sum a boot page carries, the rest of the row stays, and a digest that already matches is left alone.

using namespace wm;
using namespace wm::sync;

namespace {

constexpr Ms kNow = 1'000'000;

test::PgWorld& world() {
  static test::PgWorld pg;
  return pg;
}

Json::Value dayPut(const std::string& day, int score) {
  const std::string stamp = std::to_string(kNow) + ":1:r_aaaaaaaaaaaa";
  return parseJson(R"({"scope":"self/probe","d":[{"t":"day","id":")" + day + R"(","life":["alive",")" + stamp +
                   R"("],"f":{"score":[)" + std::to_string(score) + R"(,")" + stamp + R"("]}}]})");
}

// Ann's probe scope with three days admitted, and the digest a whole boot page sums to.
struct Seeded {
  UserId ann;
  ScopeKey scope;
  ScopeRow row;
  Digest256 booted;
};

Seeded seedThreeDays() {
  world().seed(parseJson(R"({"epoch": "ep-1", "clock": {"ms": 0, "counter": 0}, "accounts": {"A": {"name": "Ann"}}})"));
  Admission admission(world().catalog(), world().store(), world().feed, world().clock(), world().failures);
  wm::fake::FakeClock clock;
  clock.now = kNow;
  SyncService service(world().catalog(), world().store(), admission, clock);
  const UserId ann = world().account("A");
  BlockingThread::Mark blocking;
  for (const char* day : {"2026-01-01", "2026-01-02", "2026-01-03"}) admission.admit(ServerOrigin{ann, std::nullopt}, dayPut(day, 3), kNow);
  const Json::Value page = service.pull(Credential::sent(ann), jcs(parseJson(R"({"scopes":[{"scope":"self/probe","cursor":null}]})"))).body["pages"][0];
  const std::vector<Json::Value> rows(page["rows"].begin(), page["rows"].end());
  const ScopeKey scope = ScopeKey::product(ann, "probe");
  const std::unique_ptr<SyncTxn> txn = world().store().begin(TxnMode::snapshot);
  return Seeded{ann, scope, *world().store().scope(*txn, scope, RowLock::none), scopeDigest(rows)};
}

std::string storedDigestHex(const ScopeKey& scope) {
  const std::unique_ptr<SyncTxn> txn = world().store().begin(TxnMode::snapshot);
  return world().store().scope(*txn, scope, RowLock::none)->digest.hex();
}

}

TEST(a_stale_digest_is_rewritten_to_the_sum_a_boot_page_carries_and_a_second_resum_moves_nothing) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const Seeded seeded = seedThreeDays();
  CHECK_EQ(seeded.row.digest.hex(), seeded.booted.hex());
  {
    const std::unique_ptr<SyncTxn> txn = world().store().begin(TxnMode::write);
    sqlOf(*txn).exec("update sync_scopes set digest = decode(repeat('ff', 32), 'hex') where key = $1", pqxx::params{seeded.scope.text()});
    txn->commit();
  }
  DigestResum resum(world().catalog(), world().store());

  const std::optional<Resum> first = resum.resum(seeded.scope);
  REQUIRE(first.has_value());
  CHECK_EQ(first->moved(), true);
  CHECK_EQ(first->stored.hex(), std::string(64, 'f'));
  CHECK_EQ(first->summed.hex(), seeded.booted.hex());
  CHECK_EQ(storedDigestHex(seeded.scope), seeded.booted.hex());

  const std::optional<Resum> second = resum.resum(seeded.scope);
  REQUIRE(second.has_value());
  CHECK_EQ(second->moved(), false);
  CHECK_EQ(second->stored.hex(), seeded.booted.hex());
  CHECK_EQ(second->summed.hex(), seeded.booted.hex());

  const std::unique_ptr<SyncTxn> txn = world().store().begin(TxnMode::snapshot);
  const ScopeRow after = *world().store().scope(*txn, seeded.scope, RowLock::none);
  CHECK_EQ(after.seq, seeded.row.seq);
  CHECK_EQ(after.seq, Seq{3});
  CHECK_EQ(after.counters, seeded.row.counters);
  CHECK_EQ(after.open, seeded.row.open);
  CHECK_EQ(after.dead, false);
}

TEST(a_digest_that_already_matches_its_rows_is_reported_unmoved_and_left_alone) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const Seeded seeded = seedThreeDays();
  DigestResum resum(world().catalog(), world().store());

  const std::optional<Resum> outcome = resum.resum(seeded.scope);
  REQUIRE(outcome.has_value());
  CHECK_EQ(outcome->moved(), false);
  CHECK_EQ(outcome->stored.hex(), seeded.booted.hex());
  CHECK_EQ(outcome->summed.hex(), seeded.booted.hex());
  CHECK_EQ(storedDigestHex(seeded.scope), seeded.booted.hex());
  CHECK_EQ(resum.resum(ScopeKey::product(world().account("B"), "probe")).has_value(), false);
}

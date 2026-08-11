#include "products/journal/application/EchoSweep.h"

#include "test/platform/Fakes.h"
#include "test/products/journal/Fakes.h"
#include "test/testing.h"

#include <cstdint>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::fake;

namespace {

constexpr std::uint64_t kNow = 1'700'000'000'000;
constexpr std::uint64_t kDay = 24ull * 60 * 60 * 1000;

const std::string kOldDay = "2026-01-01";
const std::string kNewDay = "2026-05-01";
const std::string kOldLine = "i want to learn kotlin properly this time, not just skimming it.";
const std::string kNewLine = "i like kotlin now and the work is finally fun to sit down with.";

// A user whose tonight genuinely reaches back: one older page already derived, one page due, and
// the two lines share a subject and an anchor word. Everything else in a test varies around this.
void armReachingBack(FakeEchoRepository& echoes, FakeEmbedder& embedder) {
  echoes.addUser(uid("u1"));
  echoes.plantSpan(uid("u1"), ld(kOldDay), 11, kOldLine, embedder.embed({kOldLine})[0]);
  echoes.addDuePage(uid("u1"), ld(kNewDay), kNewLine);
}

// The background AI bucket the sweep asks about, as a test holds it. Empty means every account is
// under its ceiling, which is the ordinary night every test but one below wants; `spend` plants a
// journal bill big enough to close the bucket.
struct SweepLedger {
  FakeSubscriptionRepository subscriptions;
  FakeAiUsageRepository usage;
  Entitlements entitlements{subscriptions, usage};

  void spend(long long nanos) { usage.spentByProduct["journal"] = nanos; }
};

EchoSweep sweepOver(FakeEchoRepository& echoes, FakeEmbedder& embedder, FakeCurator& curator,
                    FakeClock& clock, SweepLedger& ledger) {
  return EchoSweep{echoes,             embedder,          curator, clock,
                   ledger.entitlements, SelectionRules{}, SweepBudget{}};
}

}

TEST(a_page_that_reaches_back_writes_an_echo_pointing_at_the_older_passage) {
  FakeEchoRepository echoes;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  armReachingBack(echoes, embedder);

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, embedder, curator, clock, ledger);
  const EchoSweepReport report = sweep.run(kNow - kDay);

  CHECK_EQ(report.usersScanned, 1);
  CHECK_EQ(report.pagesDerived, 1);
  CHECK_EQ(report.pagesFailed, 0);
  CHECK_EQ(report.echoesWritten, 1);

  const std::vector<EchoRow> rows = echoes.rowsOn(uid("u1"), ld(kNewDay));
  REQUIRE_EQ(rows.size(), std::size_t{1});
  CHECK_EQ(rows[0].matchSpanId, std::int64_t{11});
  CHECK(rows[0].matchDay == ld(kOldDay));
  CHECK(rows[0].matchIsSelf);
}

TEST(an_unwired_embedder_makes_the_whole_pass_a_no_op) {
  FakeEchoRepository echoes;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  armReachingBack(echoes, embedder);
  embedder.isConfigured = false;

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, embedder, curator, clock, ledger);
  const EchoSweepReport report = sweep.run(kNow - kDay);

  CHECK_EQ(report.usersScanned, 0);   // not a single user is scanned
  CHECK_EQ(report.pagesDerived, 0);
  CHECK_EQ(curator.calls, 0);
  CHECK_EQ(echoes.outcomes.size(), std::size_t{0});
}

TEST(an_unwired_curator_makes_the_whole_pass_a_no_op) {
  FakeEchoRepository echoes;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  armReachingBack(echoes, embedder);
  curator.isConfigured = false;

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, embedder, curator, clock, ledger);
  const EchoSweepReport report = sweep.run(kNow - kDay);

  CHECK_EQ(report.usersScanned, 0);
  CHECK_EQ(report.pagesDerived, 0);
  CHECK_EQ(echoes.outcomes.size(), std::size_t{0});
}

// The distinction the whole failure taxonomy exists for. A page the curator never answered for is
// owed another night; a page it answered "nothing here" for is finished. Storing them the same way
// loses the first one to a transient blip at 02:14, permanently.
TEST(a_failed_curate_is_recorded_as_a_failure_and_never_as_an_empty_page) {
  FakeEchoRepository echoes;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  armReachingBack(echoes, embedder);
  curator.callSucceeds = false;
  curator.failure = "rate_limited";

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, embedder, curator, clock, ledger);
  const EchoSweepReport report = sweep.run(kNow - kDay);

  CHECK_EQ(report.pagesFailed, 1);
  CHECK_EQ(report.pagesDerived, 0);
  CHECK_EQ(report.echoesWritten, 0);
  REQUIRE_EQ(echoes.outcomes.size(), std::size_t{1});
  CHECK(echoes.outcomes[0].status == CurationStatus::rateLimited);
  CHECK(!isSuccess(echoes.outcomes[0].status));
}

// The other half of that taxonomy, and the opposite ruling. A vendor that DECLINED to judge a body
// will decline the same body tomorrow, so a page it refused is finished: asking again bills every
// six hours, forever, for an echo that can never arrive.
TEST(a_refused_page_is_finished_rather_than_asked_again_every_night) {
  FakeEchoRepository echoes;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  armReachingBack(echoes, embedder);
  curator.callSucceeds = false;
  curator.failure = "refused";

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, embedder, curator, clock, ledger);
  const EchoSweepReport report = sweep.run(kNow - kDay);

  CHECK_EQ(report.pagesRefused, 1);
  CHECK_EQ(report.pagesFailed, 0);      // never blended into the number that means "still owed"
  CHECK_EQ(report.pagesDerived, 0);
  CHECK_EQ(report.echoesWritten, 0);
  REQUIRE_EQ(echoes.outcomes.size(), std::size_t{1});
  CHECK(echoes.outcomes[0].status == CurationStatus::refused);
  CHECK(!isSuccess(echoes.outcomes[0].status));
  CHECK(isSettled(echoes.outcomes[0].status));

  // The whole point: the next pass does not spend a second call on it.
  const EchoSweepReport again = sweep.run(kNow - kDay);
  CHECK_EQ(curator.calls, 1);
  CHECK_EQ(again.pagesRefused, 0);
  CHECK_EQ(echoes.outcomes.size(), std::size_t{1});
}

// A page that had echoes and then drew a refusal on its edited body ends EMPTY rather than keeping
// them: its spans were replaced before the curator was asked, so the old rows point at identities
// that no longer exist, and a page the vendor will not judge carries none.
TEST(a_refusal_leaves_the_page_carrying_no_echoes_at_all) {
  FakeEchoRepository echoes;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  armReachingBack(echoes, embedder);

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, embedder, curator, clock, ledger);
  sweep.run(kNow - kDay);
  REQUIRE_EQ(echoes.rowsOn(uid("u1"), ld(kNewDay)).size(), std::size_t{1});

  curator.callSucceeds = false;
  curator.failure = "refused";
  echoes.addDuePage(uid("u1"), ld(kNewDay), kNewLine);
  sweep.run(kNow - kDay);

  CHECK_EQ(echoes.rowsOn(uid("u1"), ld(kNewDay)).size(), std::size_t{0});
}

TEST(a_curator_that_finds_nothing_finishes_the_page_rather_than_failing_it) {
  FakeEchoRepository echoes;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  armReachingBack(echoes, embedder);
  curator.keepEverything = false;   // it answered; it just kept nothing

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, embedder, curator, clock, ledger);
  const EchoSweepReport report = sweep.run(kNow - kDay);

  CHECK_EQ(report.pagesFailed, 0);
  CHECK_EQ(report.pagesDerived, 1);
  CHECK_EQ(report.echoesWritten, 0);
  CHECK(echoes.outcomes[0].status == CurationStatus::emptyOk);
  CHECK(isSuccess(echoes.outcomes[0].status));
}

TEST(a_short_embedder_result_is_a_failed_call_not_a_page_with_fewer_passages) {
  FakeEchoRepository echoes;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  armReachingBack(echoes, embedder);
  embedder.failNext = true;

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, embedder, curator, clock, ledger);
  const EchoSweepReport report = sweep.run(kNow - kDay);

  CHECK_EQ(report.pagesFailed, 1);
  CHECK_EQ(curator.calls, 0);   // nothing is spent downstream of a failed embed
  CHECK(echoes.outcomes[0].status == CurationStatus::transport);
}

// Reconciliation, exercised through the whole pass rather than in isolation: the older page keeps
// its identity when its body is re-derived, so the echo aimed at it still resolves.
TEST(re_deriving_the_older_page_keeps_the_identity_the_echo_points_at) {
  FakeEchoRepository echoes;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  armReachingBack(echoes, embedder);

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, embedder, curator, clock, ledger);
  sweep.run(kNow - kDay);
  CHECK_EQ(echoes.rowsOn(uid("u1"), ld(kNewDay))[0].matchSpanId, std::int64_t{11});

  // Someone opens the January page and adds a line above the one that echoes.
  echoes.due.clear();
  echoes.addDuePage(uid("u1"), ld(kOldDay), "slept badly last night.\n" + kOldLine);
  sweep.run(kNow - kDay);

  const std::vector<KnownSpan> after = echoes.spansOf(uid("u1"), ld(kOldDay));
  REQUIRE_EQ(after.size(), std::size_t{2});
  // The inserted line minted a fresh identity; the echoing line kept the one it had.
  CHECK_EQ(after[1].spanId, std::int64_t{11});
}

TEST(a_pairing_the_reader_waved_away_is_never_proposed_again) {
  FakeEchoRepository echoes;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  armReachingBack(echoes, embedder);

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, embedder, curator, clock, ledger);
  sweep.run(kNow - kDay);
  const std::vector<EchoRow> first = echoes.rowsOn(uid("u1"), ld(kNewDay));
  REQUIRE_EQ(first.size(), std::size_t{1});

  echoes.plantDismissal(uid("u1"), first[0].triggerSpanId, first[0].matchSpanId);
  echoes.addDuePage(uid("u1"), ld(kNewDay), kNewLine);   // the page comes round again
  sweep.run(kNow - kDay);

  CHECK_EQ(echoes.rowsOn(uid("u1"), ld(kNewDay)).size(), std::size_t{0});
}

TEST(a_page_within_the_gap_is_too_near_to_echo) {
  FakeEchoRepository echoes;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  echoes.addUser(uid("u1"));
  echoes.plantSpan(uid("u1"), ld("2026-04-28"), 11, kOldLine, embedder.embed({kOldLine})[0]);
  echoes.addDuePage(uid("u1"), ld(kNewDay), kNewLine);   // three days later

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, embedder, curator, clock, ledger);
  const EchoSweepReport report = sweep.run(kNow - kDay);

  CHECK_EQ(report.pagesDerived, 1);
  CHECK_EQ(report.echoesWritten, 0);
  CHECK_EQ(curator.calls, 0);   // nothing survived retrieval, so nothing was paid for
}

TEST(an_empty_page_is_finished_without_spending_anything) {
  FakeEchoRepository echoes;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  echoes.addUser(uid("u1"));
  echoes.addDuePage(uid("u1"), ld(kNewDay), "   \n  ");

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, embedder, curator, clock, ledger);
  const EchoSweepReport report = sweep.run(kNow - kDay);

  CHECK_EQ(report.pagesDerived, 1);
  CHECK_EQ(report.passagesEmbedded, 0);
  CHECK_EQ(curator.calls, 0);
  CHECK(echoes.outcomes[0].status == CurationStatus::emptyOk);
}

// A three-hundred-page cleanup pass must drain over several nights rather than bill in one.
TEST(a_night_stops_at_the_page_budget_and_says_how_much_it_left) {
  FakeEchoRepository echoes;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  echoes.addUser(uid("u1"));
  for (int i = 1; i <= 12; ++i) {
    const std::string day = "2026-06-" + std::string(i < 10 ? "0" : "") + std::to_string(i);
    echoes.addDuePage(uid("u1"), ld(day), kNewLine);
  }

  SweepLedger ledger;
  EchoSweep sweep{echoes,              embedder,         curator, clock,
                  ledger.entitlements, SelectionRules{}, SweepBudget{5, 20}};
  const EchoSweepReport report = sweep.run(kNow - kDay);

  CHECK_EQ(report.pagesDerived, 5);
  CHECK_EQ(report.pagesOverBudget, 7);
}

// --- The background AI bucket -----------------------------------------------------------------

// The bug this bucket exists to make impossible: a six-hourly pass nobody asked for spending the
// allowance the question they DID ask is then refused for. It is asked once per user, and it is the
// journal bucket, never the account's own.
TEST(a_user_whose_background_bucket_is_dry_is_skipped_not_failed) {
  FakeEchoRepository echoes;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  armReachingBack(echoes, embedder);

  SweepLedger ledger;
  ledger.spend(kSweepMonthlyAiNanos);   // the $2 bucket, exactly spent
  EchoSweep sweep = sweepOver(echoes, embedder, curator, clock, ledger);
  const EchoSweepReport report = sweep.run(kNow - kDay);

  CHECK_EQ(report.usersScanned, 1);
  CHECK_EQ(report.usersOverAiBudget, 1);
  CHECK_EQ(curator.calls, 0);        // refused before anything was bought
  CHECK_EQ(report.pagesDerived, 0);
  // SKIPPED, not failed. Nothing was written, so no stamp advanced and no outcome was recorded —
  // the page is still owed, and the next pass with room in the bucket picks it up untouched.
  CHECK_EQ(report.pagesFailed, 0);
  CHECK_EQ(echoes.outcomes.size(), std::size_t{0});
  CHECK_EQ(echoes.rowsOn(uid("u1"), ld(kNewDay)).size(), std::size_t{0});
}

TEST(a_user_with_room_in_the_background_bucket_sweeps_and_is_billed_by_name) {
  FakeEchoRepository echoes;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  armReachingBack(echoes, embedder);

  SweepLedger ledger;
  ledger.spend(kSweepMonthlyAiNanos - 1);   // a nano left is still a nano
  EchoSweep sweep = sweepOver(echoes, embedder, curator, clock, ledger);
  const EchoSweepReport report = sweep.run(kNow - kDay);

  CHECK_EQ(report.usersOverAiBudget, 0);
  CHECK_EQ(report.pagesDerived, 1);
  CHECK_EQ(curator.calls, 1);
  // The call was attributed to the account whose night it was, which is the whole reason the port
  // widened — a background spend with nobody attached to it can never be held to an account.
  REQUIRE_EQ(curator.billed.size(), std::size_t{1});
  CHECK(curator.billed[0] == uid("u1"));
  // And it asked the JOURNAL bucket, not the account's every-product total.
  REQUIRE_EQ(ledger.usage.asked.size(), std::size_t{1});
  CHECK_EQ(ledger.usage.asked[0].product, std::string("journal"));
  CHECK(ledger.usage.asked[0].user == uid("u1"));
}

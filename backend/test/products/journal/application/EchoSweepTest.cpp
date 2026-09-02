#include "products/journal/application/EchoSweep.h"

#include "test/platform/Fakes.h"
#include "test/products/journal/Fakes.h"
#include "test/testing.h"

#include <algorithm>
#include <cstdint>
#include <iterator>
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

// A user whose tonight genuinely reaches back: one older page derived, one page due, the two lines sharing a subject and an anchor word.
void armReachingBack(FakeEchoRepository& echoes, FakeEmbedder& embedder) {
  echoes.addUser(uid("u1"));
  echoes.plantSpan(uid("u1"), ld(kOldDay), 11, kOldLine, embedder.embed({kOldLine})[0]);
  echoes.addDuePage(uid("u1"), ld(kNewDay), kNewLine);
}

// The background AI bucket. Empty means every account is under its ceiling; `spend` plants a journal bill big enough to close it.
struct SweepLedger {
  FakeSubscriptionRepository subscriptions;
  FakeAiUsageRepository usage;
  Entitlements entitlements{subscriptions, usage};

  void spend(long long nanos) { usage.spentByProduct["journal"] = nanos; }
};

// The rule segmenter by default; `sweepCutBy` is the overload for tests that hand the sweep a segmenter of their own.
EchoSweep sweepOver(FakeEchoRepository& echoes, FakeEmbedder& embedder, FakeCurator& curator,
                    FakeClock& clock, SweepLedger& ledger) {
  static FakeSegmenter rule;
  return EchoSweep{echoes,  rule,                embedder,         curator,
                   clock,   ledger.entitlements, SelectionRules{}, SweepBudget{}};
}

EchoSweep sweepOver(FakeEchoRepository& echoes, FakeSegmenter& segmenter, FakeEmbedder& embedder,
                    FakeCurator& curator, FakeClock& clock, SweepLedger& ledger) {
  return EchoSweep{echoes,  segmenter,           embedder,         curator,
                   clock,   ledger.entitlements, SelectionRules{}, SweepBudget{}};
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

  CHECK_EQ(report.usersScanned, 0);
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
  CHECK_EQ(report.pagesFailed, 0);
  CHECK_EQ(report.pagesDerived, 0);
  CHECK_EQ(report.echoesWritten, 0);
  REQUIRE_EQ(echoes.outcomes.size(), std::size_t{1});
  CHECK(echoes.outcomes[0].status == CurationStatus::refused);
  CHECK(!isSuccess(echoes.outcomes[0].status));
  CHECK(isSettled(echoes.outcomes[0].status));

  const EchoSweepReport again = sweep.run(kNow - kDay);
  CHECK_EQ(curator.calls, 1);
  CHECK_EQ(again.pagesRefused, 0);
  CHECK_EQ(echoes.outcomes.size(), std::size_t{1});
}

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
  curator.keepEverything = false;

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
  CHECK_EQ(curator.calls, 0);
  CHECK(echoes.outcomes[0].status == CurationStatus::transport);
}

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

  echoes.due.clear();
  echoes.addDuePage(uid("u1"), ld(kOldDay), "slept badly last night.\n" + kOldLine);
  sweep.run(kNow - kDay);

  const std::vector<StoredSpan> after = echoes.spansOf(uid("u1"), ld(kOldDay));
  REQUIRE_EQ(after.size(), std::size_t{2});
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
  echoes.addDuePage(uid("u1"), ld(kNewDay), kNewLine);
  const int judged = curator.calls;
  sweep.run(kNow - kDay);

  // A dismissed pairing is dropped before the curator, so the vendor is not asked about it again.
  CHECK_EQ(curator.calls, judged);
  // And never served again.
  CHECK_EQ(echoes.echoesFor(uid("u1"), ld(kOldDay), ld(kNewDay)).empty(), true);
  // The row stays: the quality signal reads the pairing's score and curator version off it.
  CHECK_EQ(echoes.rowsOn(uid("u1"), ld(kNewDay)).size(), std::size_t{1});
}

TEST(a_page_within_the_gap_is_too_near_to_echo) {
  FakeEchoRepository echoes;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  echoes.addUser(uid("u1"));
  echoes.plantSpan(uid("u1"), ld("2026-04-28"), 11, kOldLine, embedder.embed({kOldLine})[0]);
  echoes.addDuePage(uid("u1"), ld(kNewDay), kNewLine);

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, embedder, curator, clock, ledger);
  const EchoSweepReport report = sweep.run(kNow - kDay);

  CHECK_EQ(report.pagesDerived, 1);
  CHECK_EQ(report.echoesWritten, 0);
  CHECK_EQ(curator.calls, 0);
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
  FakeSegmenter segmenter;
  EchoSweep sweep{echoes,  segmenter,           embedder,         curator,
                  clock,   ledger.entitlements, SelectionRules{}, SweepBudget{5, 20}};
  const EchoSweepReport report = sweep.run(kNow - kDay);

  CHECK_EQ(report.pagesDerived, 5);
  CHECK_EQ(report.pagesOverBudget, 7);
}

// --- The background AI bucket -----------------------------------------------------------------

TEST(a_user_whose_background_bucket_is_dry_is_skipped_not_failed) {
  FakeEchoRepository echoes;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  armReachingBack(echoes, embedder);

  SweepLedger ledger;
  ledger.spend(kSweepMonthlyAiNanos);
  EchoSweep sweep = sweepOver(echoes, embedder, curator, clock, ledger);
  const EchoSweepReport report = sweep.run(kNow - kDay);

  CHECK_EQ(report.usersScanned, 1);
  CHECK_EQ(report.usersOverAiBudget, 1);
  CHECK_EQ(curator.calls, 0);
  CHECK_EQ(report.pagesDerived, 0);
  // SKIPPED, not failed: nothing was written, no stamp advanced, so the page is still owed.
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
  ledger.spend(kSweepMonthlyAiNanos - 1);
  EchoSweep sweep = sweepOver(echoes, embedder, curator, clock, ledger);
  const EchoSweepReport report = sweep.run(kNow - kDay);

  CHECK_EQ(report.usersOverAiBudget, 0);
  CHECK_EQ(report.pagesDerived, 1);
  CHECK_EQ(curator.calls, 1);
  REQUIRE_EQ(curator.billed.size(), std::size_t{1});
  CHECK(curator.billed[0] == uid("u1"));
  REQUIRE_EQ(ledger.usage.asked.size(), std::size_t{1});
  CHECK_EQ(ledger.usage.asked[0].product, std::string("journal"));
  CHECK(ledger.usage.asked[0].user == uid("u1"));
}

// A page whose passages moved is chased back through every page holding an echo INTO it, so those pages re-derive against text that still exists.
TEST(the_reverse_edge_re_derives_the_page_pointing_at_the_one_that_moved) {
  FakeEchoRepository echoes;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  FakeSegmenter segmenter;

  const std::string february = "2026-02-01";
  const std::string februaryLine = "kotlin again today, and it still feels like the right call.";
  echoes.addUser(uid("u1"));
  echoes.plantSpan(uid("u1"), ld(kOldDay), 11, kOldLine, embedder.embed({kOldLine})[0]);
  echoes.addDuePage(uid("u1"), ld(kOldDay), kOldLine);
  echoes.plantPage(uid("u1"), ld(february), februaryLine);
  echoes.plantSpan(uid("u1"), ld(february), 21, februaryLine, embedder.embed({februaryLine})[0]);
  CuratedEchoes standing;
  standing.curatorVersion = "fake-curator-v1";
  standing.rows.push_back(EchoRow{21, ld(kOldDay), 11, 0.8f, 0.9f, true});
  echoes.replaceEchoes(uid("u1"), ld(february), standing);
  echoes.inbound[FakeEchoRepository::pageKey(uid("u1"), ld(kOldDay))] = {ld(february)};

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, segmenter, embedder, curator, clock, ledger);
  const EchoSweepReport report = sweep.run(kNow - kDay);

  CHECK_EQ(report.inboundEnqueued, 1);
  // REQUIRE, not CHECK: with nothing to index a crash here would take every later case in this binary down.
  REQUIRE_EQ(echoes.spansOf(uid("u1"), ld(february)).size(), std::size_t{1});
  CHECK_EQ(echoes.spansOf(uid("u1"), ld(february))[0].text, februaryLine);
  CHECK_EQ(echoes.spansOf(uid("u1"), ld(february))[0].spanId, std::int64_t{21});
  // Its body never moved, so the segmenter is not asked again — the units come back off storage.
  CHECK_EQ(segmenter.calls, 1);
}

TEST(a_segmenter_that_fails_leaves_the_page_owed_and_its_passages_alone) {
  FakeEchoRepository echoes;
  FakeSegmenter segmenter;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  armReachingBack(echoes, embedder);
  segmenter.callSucceeds = false;
  segmenter.failure = "rate_limited";

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, segmenter, embedder, curator, clock, ledger);
  const EchoSweepReport report = sweep.run(kNow - kDay);

  // A failed CUT is a failed call: nothing is written, the page's stamps never move, and the next pass owes it.
  CHECK_EQ(report.pagesFailed, 1);
  CHECK_EQ(report.pagesDerived, 0);
  CHECK_EQ(echoes.spansOf(uid("u1"), ld(kNewDay)).empty(), true);
  CHECK_EQ(curator.calls, 0);
  REQUIRE_EQ(echoes.outcomes.size(), std::size_t{1});
  CHECK_EQ(echoes.outcomes[0].error, std::string{"segmenter: rate_limited"});
}

TEST(a_unit_the_model_invented_never_becomes_a_passage_of_the_writers) {
  FakeEchoRepository echoes;
  FakeSegmenter segmenter;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  armReachingBack(echoes, embedder);
  segmenter.units = {kNewLine, "and i have never been happier about it"};

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, segmenter, embedder, curator, clock, ledger);
  const EchoSweepReport report = sweep.run(kNow - kDay);

  CHECK_EQ(report.unitsDiscarded, 1);
  REQUIRE_EQ(echoes.spansOf(uid("u1"), ld(kNewDay)).size(), std::size_t{1});
  CHECK_EQ(echoes.spansOf(uid("u1"), ld(kNewDay))[0].text, kNewLine);
}

TEST(a_pairing_the_curator_now_refuses_is_taken_off_the_page) {
  FakeEchoRepository echoes;
  FakeSegmenter segmenter;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  armReachingBack(echoes, embedder);

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, segmenter, embedder, curator, clock, ledger);
  sweep.run(kNow - kDay);
  REQUIRE_EQ(echoes.rowsOn(uid("u1"), ld(kNewDay)).size(), std::size_t{1});

  // The same page, asked again of a curator that now refuses.
  curator.keepEverything = false;
  echoes.addDuePage(uid("u1"), ld(kNewDay), kNewLine);
  sweep.run(kNow - kDay);

  CHECK_EQ(echoes.rowsOn(uid("u1"), ld(kNewDay)).size(), std::size_t{0});
}

// A pairing this pass never raised is not one it rejected: silence must never read as a refusal.
TEST(a_pairing_this_pass_never_asked_about_survives_it) {
  FakeEchoRepository echoes;
  FakeSegmenter segmenter;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  armReachingBack(echoes, embedder);

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, segmenter, embedder, curator, clock, ledger);
  sweep.run(kNow - kDay);
  const std::vector<EchoRow> first = echoes.rowsOn(uid("u1"), ld(kNewDay));
  REQUIRE_EQ(first.size(), std::size_t{1});

  // A passage RETRIEVAL never hands over: inside minDayGap, so no rule ever looks at it and no fate
  // is recorded for it. That is the silence the additive rule protects — unlike "selection examined
  // it and said no", which is a judgement and does retract.
  const std::string recent = "kotlin again, only three days ago";
  echoes.plantSpan(uid("u1"), ld("2026-04-29"), 77, recent, embedder.embed({recent})[0]);
  REQUIRE(daysBetween(ld("2026-04-29"), ld(kNewDay)) < SelectionRules{}.minDayGap);
  CuratedEchoes standing;
  standing.curatorVersion = "fake-curator-v1";
  standing.rows.push_back(EchoRow{first[0].triggerSpanId, ld("2026-04-29"), 77, 0.7f, 0.8f, true});
  echoes.replaceEchoes(uid("u1"), ld(kNewDay), standing);

  curator.keepEverything = false;
  echoes.addDuePage(uid("u1"), ld(kNewDay), kNewLine);
  sweep.run(kNow - kDay);

  const std::vector<EchoRow> after = echoes.rowsOn(uid("u1"), ld(kNewDay));
  REQUIRE_EQ(after.size(), std::size_t{1});
  CHECK_EQ(after[0].matchSpanId, std::int64_t{77});
}

TEST(a_rejudge_takes_every_page_and_re_cuts_none_of_them) {
  FakeEchoRepository echoes;
  FakeSegmenter segmenter;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  armReachingBack(echoes, embedder);
  // armReachingBack plants January's PASSAGE but not its page body; a re-judge reads bodies, so the
  // older page has to exist as a page for this to be the two-page account it describes.
  echoes.plantPage(uid("u1"), ld(kOldDay), kOldLine);

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, segmenter, embedder, curator, clock, ledger);
  sweep.run(kNow - kDay);
  REQUIRE_EQ(echoes.rowsOn(uid("u1"), ld(kNewDay)).size(), std::size_t{1});

  // Nothing is owed now: an ordinary pass does nothing at all, which is exactly the state a
  // deployed algorithm change leaves behind.
  const EchoSweepReport quiet = sweep.run(kNow - kDay);
  CHECK_EQ(quiet.pagesDerived, 0);

  const int cuts = segmenter.calls;
  curator.keepEverything = false;
  const EchoSweepReport forced = sweep.run(kNow - kDay, true);

  // Every page of this account, taken whether or not the stamps owed them.
  CHECK_EQ(forced.pagesDerived, 2);
  // And re-cut none of them: a re-judge asks what a page reaches, never what it says.
  CHECK_EQ(segmenter.calls, cuts);
  // Which is what finally retracts the pairing the curator now refuses.
  CHECK_EQ(echoes.rowsOn(uid("u1"), ld(kNewDay)).size(), std::size_t{0});
}

// Selection can refuse a pairing the curator is never asked about: no shared uncommon word, or the
// same sentence said again.
TEST(a_pairing_selection_itself_now_refuses_is_taken_off_the_page) {
  FakeEchoRepository echoes;
  FakeSegmenter segmenter;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  armReachingBack(echoes, embedder);
  echoes.plantPage(uid("u1"), ld(kOldDay), kOldLine);

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, segmenter, embedder, curator, clock, ledger);
  sweep.run(kNow - kDay);
  REQUIRE_EQ(echoes.rowsOn(uid("u1"), ld(kNewDay)).size(), std::size_t{1});

  // The same night, with the older passage rewritten to share no uncommon word with tonight. The
  // pairing is now dropped at the anchor rule, so the curator is never asked about it.
  const std::string bland = "the piano needed tuning again";
  echoes.spans[uid("u1").str()].clear();
  // The page itself carries the rewrite, not only its passage: a body and a cut that disagree is a
  // page owed a re-cut, which is a different test from this one.
  echoes.plantPage(uid("u1"), ld(kOldDay), bland);
  echoes.plantSpan(uid("u1"), ld(kOldDay), 11, bland, embedder.embed({bland})[0]);
  echoes.addDuePage(uid("u1"), ld(kNewDay), kNewLine);
  const int judged = curator.calls;
  sweep.run(kNow - kDay, true);

  CHECK_EQ(curator.calls, judged);   // nothing was proposed, so nothing was sent
  CHECK_EQ(echoes.rowsOn(uid("u1"), ld(kNewDay)).size(), std::size_t{0});
}

// The day collapse is forward-only and persistence is additive, so a page that stored two echoes into
// ONE past day before `maxPerMatchDay` existed would keep both rows forever — two cards where the
// write side has always addressed one. The loser is retracted, but only once its day is represented.
TEST(a_second_echo_into_the_same_past_day_is_taken_off_the_page) {
  FakeEchoRepository echoes;
  FakeSegmenter segmenter;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;

  // One past day carrying two passages tonight can reach, and both of them stored as echoes by an
  // older build that had no per-day rule.
  const std::string first = "i want to learn kotlin properly this time, not just skimming it.";
  const std::string second = "kotlin keeps coming up and i keep putting it off, which is the problem.";
  echoes.addUser(uid("u1"));
  echoes.plantPage(uid("u1"), ld(kOldDay), first + "\n" + second);
  echoes.plantSpan(uid("u1"), ld(kOldDay), 11, first, embedder.embed({first})[0]);
  echoes.plantSpan(uid("u1"), ld(kOldDay), 12, second, embedder.embed({second})[0],
                   static_cast<int>(first.size()) + 1);
  echoes.addDuePage(uid("u1"), ld(kNewDay), kNewLine);

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, segmenter, embedder, curator, clock, ledger);
  sweep.run(kNow - kDay);

  const std::vector<EchoRow> rows = echoes.rowsOn(uid("u1"), ld(kNewDay));
  REQUIRE_EQ(rows.size(), std::size_t{1});
  CHECK_EQ(rows[0].matchDay, ld(kOldDay));
}

// --- What a repeat derivation is allowed to buy -------------------------------------------------

// A vector the fake embedder would never return, so a stored one that survives a pass proves the
// pass reused it rather than buying it again.
std::vector<float> marker() {
  std::vector<float> planted(26, 0.0f);
  planted[0] = 1.0f;
  return planted;
}

// Setting mood or energy saves IMMEDIATELY (pageStore.js `set` → `scheduleSave(0)`) with the body
// untouched, so the page HLC moves and not one byte does. `bodyMoved` used to be a stamp
// comparison, which called that a moved body and re-cut identical bytes; it compares the body's
// CONTENT now, so this page reaches storage having bought nothing at all.
TEST(a_save_that_moved_no_bytes_buys_neither_a_cut_nor_an_embedding) {
  FakeEchoRepository echoes;
  FakeSegmenter segmenter;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  echoes.addUser(uid("u1"));
  echoes.plantSpan(uid("u1"), ld(kNewDay), 21, kNewLine, marker(), 0, kNewLine);
  echoes.addDuePage(uid("u1"), ld(kNewDay), kNewLine, /*bodyMoved=*/false);

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, segmenter, embedder, curator, clock, ledger);
  const EchoSweepReport report = sweep.run(kNow - kDay);

  CHECK_EQ(segmenter.calls, 0);
  CHECK_EQ(embedder.calls, 0);
  CHECK_EQ(curator.calls, 0);
  CHECK_EQ(report.passagesEmbedded, 0);
  CHECK_EQ(report.pagesDerived, 1);   // and the page is settled rather than left owed

  // The stored vector is the planted one, so nothing re-embedded it behind the reuse.
  const std::vector<StoredSpan> after = echoes.spansOf(uid("u1"), ld(kNewDay));
  REQUIRE_EQ(after.size(), std::size_t{1});
  CHECK_EQ(after[0].spanId, std::int64_t{21});
  CHECK_EQ(after[0].vector, marker());
  // And the pass claims it cut exactly the bytes it was handed, so the next one reads it back.
  CHECK(echoes.cutFromTheseBytes(uid("u1"), ld(kNewDay), kNewLine));
}

// The honest residual, and the reason this is not the whole saving: the curator is asked whenever
// selection proposes anything, and it does not care whether the body moved. A page that reaches
// back still buys one curator call per derivation to re-decide pairings it ruled on minutes
// earlier. Only a verdict cache removes that, and there is none.
TEST(a_save_that_moved_no_bytes_still_pays_the_curator_on_a_page_that_reaches_back) {
  FakeEchoRepository echoes;
  FakeSegmenter segmenter;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  echoes.addUser(uid("u1"));
  echoes.plantSpan(uid("u1"), ld(kOldDay), 11, kOldLine, embedder.embed({kOldLine})[0]);
  echoes.plantSpan(uid("u1"), ld(kNewDay), 21, kNewLine, embedder.embed({kNewLine})[0], 0, kNewLine);
  embedder.calls = 0;
  embedder.asked.clear();
  echoes.addDuePage(uid("u1"), ld(kNewDay), kNewLine, /*bodyMoved=*/false);

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, segmenter, embedder, curator, clock, ledger);
  const EchoSweepReport report = sweep.run(kNow - kDay);

  CHECK_EQ(segmenter.calls, 0);
  CHECK_EQ(embedder.calls, 0);
  CHECK_EQ(curator.calls, 1);
  CHECK_EQ(report.echoesWritten, 1);
}

// The append case: reconciliation runs BEFORE the embedder, so the sentence that did not move keeps
// the vector storage holds and only the new one is bought. The embed round trip sits between the
// save and the echo appearing, so this is latency as much as bill.
TEST(a_carried_passage_is_not_embedded_again_and_only_the_new_one_is) {
  FakeEchoRepository echoes;
  FakeSegmenter segmenter;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;

  const std::string kept = "i want to learn kotlin properly this time, not just skimming it.";
  const std::string added = "and tonight i finally sat down with it for an hour.";
  segmenter.units = {kept, added};

  echoes.addUser(uid("u1"));
  echoes.plantSpan(uid("u1"), ld(kNewDay), 21, kept, marker(), 0, kept);
  echoes.addDuePage(uid("u1"), ld(kNewDay), kept + "\n" + added);   // the writer appended a line

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, segmenter, embedder, curator, clock, ledger);
  const EchoSweepReport report = sweep.run(kNow - kDay);

  CHECK_EQ(segmenter.calls, 1);   // the bytes DID move, so the cut is bought — that is unavoidable
  CHECK_EQ(embedder.calls, 1);
  REQUIRE_EQ(embedder.asked.size(), std::size_t{1});
  CHECK_EQ(embedder.asked[0], added);          // the new sentence, and nothing else
  CHECK_EQ(report.passagesEmbedded, 1);        // while the page ends holding two passages

  const std::vector<StoredSpan> after = echoes.spansOf(uid("u1"), ld(kNewDay));
  REQUIRE_EQ(after.size(), std::size_t{2});
  CHECK_EQ(after[0].spanId, std::int64_t{21});   // identity carried
  CHECK_EQ(after[0].vector, marker());           // and its vector carried with it
  CHECK_EQ(after[1].text, added);
  CHECK(after[1].vector != marker());
}

// Reuse is gated on the embedding version and must be: a cosine between two embedding spaces is
// meaningless, so a vector held under an older embedder is bought again however unchanged the text.
TEST(a_vector_held_under_another_embedding_version_is_never_reused) {
  FakeEchoRepository echoes;
  FakeSegmenter segmenter;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  echoes.addUser(uid("u1"));
  echoes.plantSpan(uid("u1"), ld(kNewDay), 21, kNewLine, marker(), 0, kNewLine, "fake-embedder-v0");
  echoes.addDuePage(uid("u1"), ld(kNewDay), kNewLine, /*bodyMoved=*/false);

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, segmenter, embedder, curator, clock, ledger);
  const EchoSweepReport report = sweep.run(kNow - kDay);

  CHECK_EQ(segmenter.calls, 0);   // the BYTES still did not move, so the cut is still not bought
  CHECK_EQ(embedder.calls, 1);
  REQUIRE_EQ(embedder.asked.size(), std::size_t{1});
  CHECK_EQ(embedder.asked[0], kNewLine);
  CHECK_EQ(report.passagesEmbedded, 1);

  const std::vector<StoredSpan> after = echoes.spansOf(uid("u1"), ld(kNewDay));
  REQUIRE_EQ(after.size(), std::size_t{1});
  CHECK_EQ(after[0].spanId, std::int64_t{21});          // identity is carried across the space
  CHECK(after[0].vector != marker());                   // the vector is not
  CHECK_EQ(after[0].embedVersion, std::string("fake-embedder-v1"));
}

// The reverse edge reaches pages nothing else looked at, and `pageAt` used to assume their bytes
// had not moved. A page the writer edited but whose own derivation the per-user budget deferred
// arrives here with a stale cut: trusting `false` read the OLD units back, settled the page on
// them, and recorded a body digest claiming they were cut from bytes nobody cut — which then reads
// as unchanged forever, so the appended sentence is never cut, never embedded and never an echo.
TEST(the_reverse_edge_re_cuts_a_page_whose_body_moved_instead_of_settling_the_old_units) {
  FakeEchoRepository echoes;
  FakeSegmenter segmenter;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;

  // Distinct from kOldLine, which is the due page's own body: the two must not share a passage, or
  // the count below cannot tell whose embedding it is looking at.
  const std::string wasCut = "the piano needed tuning again and i did nothing about it.";
  const std::string added = "and tonight i finally sat down with it for an hour.";
  const std::string edited = wasCut + "\n" + added;

  // The page being derived, and a NEWER page reaching back into it — which is the direction the
  // reverse edge walks. That newer page was edited after its cut, and nothing else will look at it:
  // its own derivation is not what this pass was given.
  echoes.addUser(uid("u1"));
  echoes.addDuePage(uid("u1"), ld(kOldDay), kOldLine);
  echoes.plantSpan(uid("u1"), ld(kNewDay), 21, wasCut, embedder.embed({wasCut})[0], 0, wasCut);
  echoes.plantPage(uid("u1"), ld(kNewDay), edited);
  echoes.inbound[FakeEchoRepository::pageKey(uid("u1"), ld(kOldDay))] = {ld(kNewDay)};
  embedder.asked.clear();   // planting a vector is not something the sweep bought
  embedder.calls = 0;

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, segmenter, embedder, curator, clock, ledger);
  const EchoSweepReport report = sweep.run(kNow - kDay);

  REQUIRE_EQ(report.inboundEnqueued, 1);   // the walk did reach the edited page
  // Two cuts, not one: the due page, and the edited page the walk brought in. Assuming
  // body-unmoved here bought only one, settled the edited page on units it no longer contains,
  // and then CLAIMED those units were cut from the new bytes — a claim that reads as unchanged
  // forever, so the added sentence would never be cut, embedded or echoed.
  CHECK_EQ(segmenter.calls, 2);
  CHECK(echoes.cutFromTheseBytes(uid("u1"), ld(kNewDay), edited));
  CHECK_EQ(echoes.pageAt(uid("u1"), ld(kNewDay))->bodyMoved, false);   // and it is quiet now
  // The sentence the writer added is a passage, which is the whole point of re-cutting.
  const std::vector<StoredSpan> after = echoes.spansOf(uid("u1"), ld(kNewDay));
  REQUIRE_EQ(after.size(), std::size_t{2});
  CHECK_EQ(after[0].spanId, std::int64_t{21});   // the untouched passage kept its identity
  CHECK_EQ(after[1].text, added);
  // And the carried passage was not bought again — the reorder holds on this path too. Counted
  // rather than sized, because the due page that started the walk did its own embedding first.
  CHECK_EQ(std::count(embedder.asked.begin(), embedder.asked.end(), added), std::ptrdiff_t{1});
  CHECK_EQ(std::count(embedder.asked.begin(), embedder.asked.end(), wasCut), std::ptrdiff_t{0});
}

// The rejudge door asks what a page reaches, not what it says — but a page whose stored cut is not
// of its current bytes is cut again rather than settled on units the page no longer contains.
TEST(a_rejudge_re_cuts_only_the_page_whose_stored_cut_is_of_other_bytes) {
  FakeEchoRepository echoes;
  FakeSegmenter segmenter;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;

  const std::string settled = "i want to learn kotlin properly this time, not just skimming it.";
  const std::string moved = "the piano needed tuning again, and i did nothing about it.";
  echoes.addUser(uid("u1"));
  echoes.plantSpan(uid("u1"), ld(kOldDay), 11, settled, embedder.embed({settled})[0], 0, settled);
  echoes.plantPage(uid("u1"), ld(kOldDay), settled);          // cut matches the body
  echoes.plantSpan(uid("u1"), ld(kNewDay), 21, settled, embedder.embed({settled})[0], 0, settled);
  echoes.plantPage(uid("u1"), ld(kNewDay), moved);            // cut does NOT match the body

  SweepLedger ledger;
  EchoSweep sweep = sweepOver(echoes, segmenter, embedder, curator, clock, ledger);
  sweep.run(kNow - kDay, /*rejudgeAll=*/true);

  CHECK_EQ(segmenter.calls, 1);   // the moved page only, never the settled one
  CHECK(echoes.cutFromTheseBytes(uid("u1"), ld(kNewDay), moved));
  CHECK(echoes.cutFromTheseBytes(uid("u1"), ld(kOldDay), settled));
}

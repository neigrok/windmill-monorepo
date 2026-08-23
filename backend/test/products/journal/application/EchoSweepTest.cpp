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

  const std::vector<KnownSpan> after = echoes.spansOf(uid("u1"), ld(kOldDay));
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

  // Never PROPOSED again — the pairing is dropped before the curator, so the vendor is not asked a
  // second time about something the reader has already answered.
  CHECK_EQ(curator.calls, judged);
  // And never SERVED again, which is the promise that matters: the reader told it to fade.
  CHECK_EQ(echoes.echoesFor(uid("u1"), ld(kOldDay), ld(kNewDay)).empty(), true);
  // The row itself stays, deliberately. Persistence is additive, and a dismissal is not a refusal:
  // journal_echo is where the quality signal copies the pairing's score and curator version from
  // (ECHOES.md, "Dismissals"), so deleting it would throw the dataset away with the echo.
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

// RETRACTION. Persistence is additive so a re-derivation cannot destroy a chain the reader has
// walked — and until 2026-08-23 that made a stored pairing permanent. A reader reported two false
// positives, the curator's prompt was fixed and a floor added, the archive was re-judged, and both
// echoes stayed on the page: nothing in the pipeline could un-say anything.
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

  // The same page, asked again of a curator that now says no — a fixed prompt, a raised floor.
  curator.keepEverything = false;
  echoes.addDuePage(uid("u1"), ld(kNewDay), kNewLine);
  sweep.run(kNow - kDay);

  CHECK_EQ(echoes.rowsOn(uid("u1"), ld(kNewDay)).size(), std::size_t{0});
}

// The other half, and the reason the additive rule exists: a pairing this pass never RAISED is not
// a pairing this pass rejected. The curator is not deterministic and retrieval's candidate set
// moves, so silence about a row must never read as a refusal of it.
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

  // A pairing from an older night, aimed at a passage that still exists but that tonight's
  // retrieval no longer surfaces: nobody asks about it, so nobody may retract it.
  // Deliberately shares no anchor with tonight, so selection never raises it and the curator is
  // never asked — which is exactly the silence the additive rule protects.
  const std::string unrelated = "the piano needed tuning again";
  echoes.plantSpan(uid("u1"), ld("2025-01-01"), 77, unrelated, embedder.embed({unrelated})[0]);
  CuratedEchoes standing;
  standing.curatorVersion = "fake-curator-v1";
  standing.rows.push_back(EchoRow{first[0].triggerSpanId, ld("2025-01-01"), 77, 0.7f, 0.8f, true});
  echoes.replaceEchoes(uid("u1"), ld(kNewDay), standing);

  curator.keepEverything = false;
  echoes.addDuePage(uid("u1"), ld(kNewDay), kNewLine);
  sweep.run(kNow - kDay);

  const std::vector<EchoRow> after = echoes.rowsOn(uid("u1"), ld(kNewDay));
  REQUIRE_EQ(after.size(), std::size_t{1});
  CHECK_EQ(after[0].matchSpanId, std::int64_t{77});
}

// The operator's re-judge. Three version strings reopen an archive when a prompt, a model or a knob
// moves; nothing reopens one when the code that judges it changes, and a retraction rule that
// nothing re-runs removes nothing.
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

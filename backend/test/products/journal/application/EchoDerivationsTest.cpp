#include "products/journal/application/EchoDerivations.h"

#include "test/platform/Fakes.h"
#include "test/products/journal/Fakes.h"
#include "test/testing.h"

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::fake;

namespace {

const std::string kOldDay = "2026-01-01";
const std::string kNewDay = "2026-05-01";
const std::string kOldLine = "i want to learn kotlin properly this time, not just skimming it.";
const std::string kNewLine = "i like kotlin now and the work is finally fun to sit down with.";

// One older page already derived, one page owed a derivation, and two lines that share a subject and an anchor word.
void armReachingBack(FakeEchoRepository& echoes, FakeEmbedder& embedder) {
  echoes.addUser(uid("u1"));
  echoes.plantSpan(uid("u1"), ld(kOldDay), 11, kOldLine, embedder.embed({kOldLine})[0]);
  echoes.addDuePage(uid("u1"), ld(kNewDay), kNewLine);
}

struct LiveStack {
  FakeEchoRepository echoes;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  FakeSubscriptionRepository subscriptions;
  FakeAiUsageRepository usage;
  Entitlements entitlements{subscriptions, usage};
  FakeSegmenter segmenter;
  EchoSweep sweep{echoes,  segmenter,    embedder,         curator,
                  clock,   entitlements, SelectionRules{}, SweepBudget{}};

  void spend(long long nanos) { usage.spentByProduct["journal"] = nanos; }
};

constexpr std::uint64_t kQuietMs = 8'000;

LiveDerivationRules rules() {
  return LiveDerivationRules{kQuietMs, 400, 4, 24ull * 60 * 60 * 1000};
}

}

TEST(a_save_derives_the_page_once_the_writer_has_gone_quiet) {
  LiveStack stack;
  armReachingBack(stack.echoes, stack.embedder);
  EchoDerivations live{stack.sweep, stack.clock, rules()};

  live.pageSaved(uid("u1"), ld(kNewDay), kNewLine.size());

  const EchoLiveReport early = live.drain(stack.clock.now + kQuietMs - 1);
  CHECK_EQ(early.derived, 0);
  CHECK_EQ(stack.curator.calls, 0);

  const EchoLiveReport report = live.drain(stack.clock.now + kQuietMs);
  CHECK_EQ(report.derived, 1);
  CHECK_EQ(report.failed, 0);
  CHECK_EQ(report.deferred, 0);
  CHECK_EQ(stack.curator.calls, 1);

  const std::vector<EchoRow> rows = stack.echoes.rowsOn(uid("u1"), ld(kNewDay));
  REQUIRE_EQ(rows.size(), std::size_t{1});
  CHECK_EQ(rows[0].matchSpanId, std::int64_t{11});
  CHECK(rows[0].matchDay == ld(kOldDay));
}

// Each save pushes the quiet deadline out again, so the page is derived once the writer actually stops.
TEST(rapid_successive_saves_coalesce_into_a_single_derivation) {
  LiveStack stack;
  armReachingBack(stack.echoes, stack.embedder);
  EchoDerivations live{stack.sweep, stack.clock, rules()};

  for (int save = 0; save < 6; ++save) {
    stack.clock.now += 2'000;
    live.pageSaved(uid("u1"), ld(kNewDay), kNewLine.size() + static_cast<std::size_t>(save));
    CHECK_EQ(live.drain(stack.clock.now).derived, 0);
  }
  CHECK_EQ(stack.curator.calls, 0);   // not one of the six bought anything

  const EchoLiveReport report = live.drain(stack.clock.now + kQuietMs);
  CHECK_EQ(report.derived, 1);
  CHECK_EQ(stack.curator.calls, 1);
}

// An evening of steady writing never goes quiet, and a page that has grown by a paragraph is answered without waiting for a pause.
TEST(a_paragraph_of_new_text_is_derived_without_waiting_for_the_quiet_time) {
  LiveStack stack;
  armReachingBack(stack.echoes, stack.embedder);
  EchoDerivations live{stack.sweep, stack.clock, rules()};

  live.pageSaved(uid("u1"), ld(kNewDay), 100);
  stack.clock.now += 1'000;
  live.pageSaved(uid("u1"), ld(kNewDay), 100 + 400);

  const EchoLiveReport report = live.drain(stack.clock.now);   // no quiet time waited at all
  CHECK_EQ(report.derived, 1);
  CHECK_EQ(stack.curator.calls, 1);
}

// The cap DEFERS: nothing is written past it, so the page's stamps never advance and it is still owed.
TEST(the_per_page_daily_cap_defers_to_the_repair_pass_rather_than_spending) {
  LiveStack stack;
  armReachingBack(stack.echoes, stack.embedder);
  EchoDerivations live{stack.sweep, stack.clock, rules()};

  for (int round = 0; round < 5; ++round) {
    stack.echoes.addDuePage(uid("u1"), ld(kNewDay), kNewLine);   // the body moved again
    live.pageSaved(uid("u1"), ld(kNewDay), kNewLine.size());
    stack.clock.now += kQuietMs;
    const EchoLiveReport report = live.drain(stack.clock.now);
    if (round < 4) {
      CHECK_EQ(report.derived, 1);
      CHECK_EQ(report.deferred, 0);
    } else {
      CHECK_EQ(report.derived, 0);
      CHECK_EQ(report.deferred, 1);
    }
  }
  CHECK_EQ(stack.curator.calls, 4);
  CHECK(stack.echoes.duePage(uid("u1"), ld(kNewDay), 0, PipelineVersions{}).has_value());

  stack.clock.now += 24ull * 60 * 60 * 1000;
  live.pageSaved(uid("u1"), ld(kNewDay), kNewLine.size());
  CHECK_EQ(live.drain(stack.clock.now + kQuietMs).derived, 1);
  CHECK_EQ(stack.curator.calls, 5);
}

// ---- fairness: one account can no longer own the drain thread -----------------------------

// Every date is a valid page, so one account writing distinct days could enqueue as many entries as it liked.
TEST(an_account_may_hold_only_a_few_pages_in_the_queue_at_once) {
  LiveStack stack;
  stack.echoes.addUser(uid("u1"));
  stack.echoes.plantSpan(uid("u1"), ld(kOldDay), 11, kOldLine, stack.embedder.embed({kOldLine})[0]);
  EchoDerivations live{stack.sweep, stack.clock, rules()};

  for (int day = 1; day <= 8; ++day) {
    const std::string iso = "2026-06-0" + std::to_string(day);
    stack.echoes.addDuePage(uid("u1"), ld(iso), kNewLine);
    live.pageSaved(uid("u1"), ld(iso), kNewLine.size());
  }

  const EchoLiveReport report = live.drain(stack.clock.now + kQuietMs);

  CHECK_EQ(report.derived, 5);     // the five the queue would hold
  CHECK_EQ(report.queueFull, 3);   // and the three it refused to hold
  CHECK_EQ(stack.echoes.derived.size(), std::size_t{5});
  CHECK(stack.echoes.duePage(uid("u1"), ld("2026-06-06"), 0, PipelineVersions{}).has_value());
  CHECK(stack.echoes.duePage(uid("u1"), ld("2026-06-07"), 0, PipelineVersions{}).has_value());
  CHECK(stack.echoes.duePage(uid("u1"), ld("2026-06-08"), 0, PipelineVersions{}).has_value());
}

// Dealt round-robin, a second writer waits behind one page, never five.
TEST(one_accounts_flood_does_not_go_ahead_of_another_writers_page) {
  LiveStack stack;
  for (const char* who : {"u1", "u2"}) {
    stack.echoes.addUser(uid(who));
    stack.echoes.plantSpan(uid(who), ld(kOldDay), 11, kOldLine, stack.embedder.embed({kOldLine})[0]);
  }
  EchoDerivations live{stack.sweep, stack.clock, rules()};

  for (int day = 1; day <= 5; ++day) {
    const std::string iso = "2026-06-0" + std::to_string(day);
    stack.echoes.addDuePage(uid("u1"), ld(iso), kNewLine);
    live.pageSaved(uid("u1"), ld(iso), kNewLine.size());
  }
  stack.echoes.addDuePage(uid("u2"), ld(kNewDay), kNewLine);
  live.pageSaved(uid("u2"), ld(kNewDay), kNewLine.size());

  const EchoLiveReport report = live.drain(stack.clock.now + kQuietMs);

  CHECK_EQ(report.derived, 6);
  REQUIRE_EQ(stack.echoes.derived.size(), std::size_t{6});
  const std::string theirs = uid("u2").str() + "|" + kNewDay;
  CHECK(stack.echoes.derived[0] == theirs || stack.echoes.derived[1] == theirs);
}

// The embedder is CPU we pay for on every derivation, before the curator's dollars are metered, so the account has a day's worth too.
TEST(an_account_may_only_buy_so_many_derivations_in_a_day) {
  LiveStack stack;
  stack.echoes.addUser(uid("u1"));
  stack.echoes.plantSpan(uid("u1"), ld(kOldDay), 11, kOldLine, stack.embedder.embed({kOldLine})[0]);
  LiveDerivationRules capped = rules();
  capped.perUserDaily = 2;
  EchoDerivations live{stack.sweep, stack.clock, capped};

  for (int day = 1; day <= 5; ++day) {
    const std::string iso = "2026-06-0" + std::to_string(day);
    stack.echoes.addDuePage(uid("u1"), ld(iso), kNewLine);
    live.pageSaved(uid("u1"), ld(iso), kNewLine.size());
  }

  const EchoLiveReport report = live.drain(stack.clock.now + kQuietMs);

  CHECK_EQ(report.derived, 2);
  CHECK_EQ(report.deferred, 3);
  CHECK_EQ(stack.curator.calls, 2);

  stack.clock.now += 24ull * 60 * 60 * 1000;
  live.pageSaved(uid("u1"), ld("2026-06-03"), kNewLine.size());
  CHECK_EQ(live.drain(stack.clock.now + kQuietMs).derived, 1);
}

// The per-user AI ceiling applies to a save-triggered derivation as to a swept one. Over it, SKIPPED: nothing bought, nothing written, no stamp advanced.
TEST(a_user_over_the_background_ai_budget_is_skipped_with_the_page_still_due) {
  LiveStack stack;
  armReachingBack(stack.echoes, stack.embedder);
  stack.spend(kSweepMonthlyAiNanos);
  EchoDerivations live{stack.sweep, stack.clock, rules()};

  live.pageSaved(uid("u1"), ld(kNewDay), kNewLine.size());
  const EchoLiveReport report = live.drain(stack.clock.now + kQuietMs);

  CHECK_EQ(report.skippedOverBudget, 1);
  CHECK_EQ(report.derived, 0);
  CHECK_EQ(report.failed, 0);
  CHECK_EQ(stack.curator.calls, 0);
  CHECK_EQ(stack.echoes.outcomes.size(), std::size_t{0});   // no stamp moved
  CHECK(stack.echoes.duePage(uid("u1"), ld(kNewDay), 0, PipelineVersions{}).has_value());

  stack.spend(0);
  live.pageSaved(uid("u1"), ld(kNewDay), kNewLine.size());
  CHECK_EQ(live.drain(stack.clock.now + 2 * kQuietMs).derived, 1);
}

// A vendor blip costs the page a derivation, never its echoes: the stamps stay where they were and the page is still owed.
TEST(a_failed_curate_leaves_the_page_still_due) {
  LiveStack stack;
  armReachingBack(stack.echoes, stack.embedder);
  stack.curator.callSucceeds = false;
  stack.curator.failure = "rate_limited";
  EchoDerivations live{stack.sweep, stack.clock, rules()};

  live.pageSaved(uid("u1"), ld(kNewDay), kNewLine.size());
  const EchoLiveReport report = live.drain(stack.clock.now + kQuietMs);

  CHECK_EQ(report.failed, 1);
  CHECK_EQ(report.derived, 0);
  REQUIRE_EQ(stack.echoes.outcomes.size(), std::size_t{1});
  CHECK(stack.echoes.outcomes[0].status == CurationStatus::rateLimited);
  CHECK(!isSuccess(stack.echoes.outcomes[0].status));
  CHECK(stack.echoes.duePage(uid("u1"), ld(kNewDay), 0, PipelineVersions{}).has_value());
  CHECK_EQ(stack.echoes.rowsOn(uid("u1"), ld(kNewDay)).size(), std::size_t{0});
}

// A second debounced save carrying nothing new never enters the pipeline: the page is no longer owed.
TEST(a_page_already_derived_is_not_bought_a_second_time) {
  LiveStack stack;
  armReachingBack(stack.echoes, stack.embedder);
  EchoDerivations live{stack.sweep, stack.clock, rules()};

  live.pageSaved(uid("u1"), ld(kNewDay), kNewLine.size());
  CHECK_EQ(live.drain(stack.clock.now + kQuietMs).derived, 1);

  stack.clock.now += 60'000;
  live.pageSaved(uid("u1"), ld(kNewDay), kNewLine.size());
  const EchoLiveReport report = live.drain(stack.clock.now + kQuietMs);

  CHECK_EQ(report.alreadyDerived, 1);
  CHECK_EQ(report.derived, 0);
  CHECK_EQ(stack.curator.calls, 1);
}

namespace {
struct RecordingWatcher : PageWatcher {
  struct Saved {
    UserId user;
    LocalDate day;
    std::size_t bodyBytes = 0;
  };
  std::vector<Saved> saves;

  void pageSaved(const UserId& user, const LocalDate& day, std::size_t bodyBytes) override {
    saves.push_back(Saved{user, day, bodyBytes});
  }
};

Page pageOf(const std::string& body, std::uint64_t stampMs) {
  Page page{uid("u1"), ld(kNewDay)};
  page.body = body;
  page.stamp = hlc(stampMs);
  return page;
}
}

TEST(a_winning_save_announces_the_page_and_a_stale_one_announces_nothing) {
  FakeJournalRepository pages;
  RecordingWatcher watcher;
  PageService service{pages, &watcher};

  service.write(pageOf("first light", 1'000));
  service.write(pageOf("first light, and then some", 2'000));
  service.write(pageOf("a body that lost the race", 1'500));   // stale: stored row wins

  REQUIRE_EQ(watcher.saves.size(), std::size_t{2});
  CHECK(watcher.saves[0].user == uid("u1"));
  CHECK(watcher.saves[0].day == ld(kNewDay));
  CHECK_EQ(watcher.saves[0].bodyBytes, std::string("first light").size());
  CHECK_EQ(watcher.saves[1].bodyBytes, std::string("first light, and then some").size());
}

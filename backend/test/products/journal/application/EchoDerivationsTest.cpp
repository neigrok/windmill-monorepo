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

// The same reaching-back user EchoSweepTest arms: one older page already derived, one page owed a
// derivation, and two lines that share a subject and an anchor word.
void armReachingBack(FakeEchoRepository& echoes, FakeEmbedder& embedder) {
  echoes.addUser(uid("u1"));
  echoes.plantSpan(uid("u1"), ld(kOldDay), 11, kOldLine, embedder.embed({kOldLine})[0]);
  echoes.addDuePage(uid("u1"), ld(kNewDay), kNewLine);
}

// Everything a live derivation needs, held together so a test varies one knob and reads the rest.
struct LiveStack {
  FakeEchoRepository echoes;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  FakeSubscriptionRepository subscriptions;
  FakeAiUsageRepository usage;
  Entitlements entitlements{subscriptions, usage};
  EchoSweep sweep{echoes, embedder, curator, clock, entitlements, SelectionRules{}, SweepBudget{}};

  void spend(long long nanos) { usage.spentByProduct["journal"] = nanos; }
};

constexpr std::uint64_t kQuietMs = 8'000;

LiveDerivationRules rules() {
  return LiveDerivationRules{kQuietMs, 400, 4, 24ull * 60 * 60 * 1000};
}

}

// The whole point of the wave: the writer's own save is what produces the echo, and it produces it
// seconds later rather than at some point in the next six hours.
TEST(a_save_derives_the_page_once_the_writer_has_gone_quiet) {
  LiveStack stack;
  armReachingBack(stack.echoes, stack.embedder);
  EchoDerivations live{stack.sweep, stack.clock, rules()};

  live.pageSaved(uid("u1"), ld(kNewDay), kNewLine.size());

  // Still typing: nothing has been bought yet.
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

// Ten minutes of typing is one derivation, not ten. Each save pushes the quiet deadline out again,
// so the page is derived once the writer actually stops.
TEST(rapid_successive_saves_coalesce_into_a_single_derivation) {
  LiveStack stack;
  armReachingBack(stack.echoes, stack.embedder);
  EchoDerivations live{stack.sweep, stack.clock, rules()};

  // Six saves two seconds apart, none of them adding a paragraph.
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

// The other half of the debounce: an evening of steady writing never goes quiet, and a page that has
// grown by a paragraph is worth answering about without waiting for a pause that may never come.
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

// The cap DEFERS, and deferring is not failing. Nothing is written past it, so the page's stamps
// never advance and it is still owed — the repair pass picks it up exactly as it picks up a page a
// vendor blip failed.
TEST(the_per_page_daily_cap_defers_to_the_repair_pass_rather_than_spending) {
  LiveStack stack;
  armReachingBack(stack.echoes, stack.embedder);
  EchoDerivations live{stack.sweep, stack.clock, rules()};

  // Five rounds of write-then-go-quiet on the same page. Four are bought; the fifth is deferred.
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
  // Still owed: the deferred round left the page on the repair pass's list, untouched.
  CHECK(stack.echoes.duePage(uid("u1"), ld(kNewDay), 0).has_value());

  // A day later the window has rolled and the page can be derived live again.
  stack.clock.now += 24ull * 60 * 60 * 1000;
  live.pageSaved(uid("u1"), ld(kNewDay), kNewLine.size());
  CHECK_EQ(live.drain(stack.clock.now + kQuietMs).derived, 1);
  CHECK_EQ(stack.curator.calls, 5);
}

// The per-user AI ceiling applies to a save-triggered derivation exactly as it applies to a swept
// one — a writer typing all evening is still a background spend. Over it, SKIPPED: nothing bought,
// nothing written, no stamp advanced, page still owed.
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
  CHECK(stack.echoes.duePage(uid("u1"), ld(kNewDay), 0).has_value());

  // And it did not count against the page's daily cap: nothing was bought to count.
  stack.spend(0);
  live.pageSaved(uid("u1"), ld(kNewDay), kNewLine.size());
  CHECK_EQ(live.drain(stack.clock.now + 2 * kQuietMs).derived, 1);
}

// A vendor blip costs the page a derivation, never its echoes. The stamps stay where they were, so
// the page is still owed and the repair pass will try it again.
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
  CHECK(stack.echoes.duePage(uid("u1"), ld(kNewDay), 0).has_value());
  CHECK_EQ(stack.echoes.rowsOn(uid("u1"), ld(kNewDay)).size(), std::size_t{0});
}

// A second debounced save that carried nothing new costs nothing at all: the page is no longer owed,
// so the pipeline is never entered and the curator is never asked.
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

// The write path's half of the trigger, asserted through PageService itself: a save that WON the
// last-writer-wins guard announces itself, and one that lost changed nothing and announces nothing.
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

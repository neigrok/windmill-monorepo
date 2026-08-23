#include "products/journal/application/NudgeSweep.h"

#include "test/platform/Fakes.h"
#include "test/products/journal/Fakes.h"
#include "test/testing.h"

#include <cstdint>
#include <string>

using namespace wm;
using namespace wm::fake;

namespace {

constexpr std::uint64_t kNow = 1'700'000'000'000;
constexpr std::uint64_t kDay = 24ull * 60 * 60 * 1000;
const std::string kSlotDay = "2026-07-27";

// One user the sweep will find due: an enabled, materialised schedule whose instant arrived a minute ago, and no page yet for the day.
void armSendableUser(FakeNudgeRepository& nudges) {
  nudges.armDue(uid("u1"), Email{"writer@example.com"}, ld(kSlotDay), kNow - 60'000);
}

}

TEST(a_due_writer_who_has_not_written_is_nudged_once_and_the_day_is_closed_delivered) {
  FakeNudgeRepository nudges;
  armSendableUser(nudges);
  FakeNudgeMail email;
  FakeTokens tokens;
  FakeClock clock;

  NudgeSweep sweep(nudges, email, tokens, clock, MailArming(true, "u1"), "https://windmill.works");
  const MailSweepReport report = sweep.run(kNow, false);

  CHECK(report.ran);
  CHECK_EQ(report.due, 1);
  CHECK_EQ(report.claimed, 1);
  CHECK_EQ(report.sent, 1);
  CHECK_EQ(report.skipped, 0);
  CHECK_EQ(report.held, 0);
  CHECK_EQ(report.failed, 0);
  CHECK_EQ(report.wouldSend, 0);
  CHECK_EQ(report.errors, 0);

  REQUIRE_EQ(nudges.claims.size(), std::size_t{1});
  CHECK_EQ(nudges.claims[0].user, uid("u1"));
  CHECK(nudges.claims[0].slotDay == ld(kSlotDay));
  CHECK_EQ(nudges.claims[0].decision.outcome, NudgeOutcome::send);
  CHECK_EQ(nudges.claims[0].decision.reason, NudgeSkipReason::none);

  REQUIRE_EQ(email.sent.size(), std::size_t{1});
  CHECK_EQ(email.sent[0].to, Email{"writer@example.com"});
  const JournalNudgeMail& mail = email.sent[0].mail;
  CHECK_EQ(mail.settingsUrl, std::string("https://windmill.works/#/settings/nudges"));
  CHECK_EQ(mail.pauseUrl, std::string("https://windmill.works/journal/nudge/pause?t=s1"));
  CHECK_EQ(mail.unsubscribeUrl,
           std::string("https://windmill.works/v1/journal/nudge/unsubscribe?t=s1"));

  CHECK_EQ(nudges.pauseDigests[uid("u1").str()], std::string("d1"));
  REQUIRE_EQ(nudges.closes.size(), std::size_t{1});
  CHECK_EQ(nudges.closes[0].user, uid("u1"));
  CHECK(nudges.closes[0].slotDay == ld(kSlotDay));
  CHECK_EQ(nudges.closes[0].outcome, DayOutcome::delivered);
}

TEST(a_writer_who_already_wrote_today_is_skipped_with_no_mail) {
  FakeNudgeRepository nudges;
  armSendableUser(nudges);
  nudges.markWrote(uid("u1"), ld(kSlotDay));
  FakeNudgeMail email;
  FakeTokens tokens;
  FakeClock clock;

  NudgeSweep sweep(nudges, email, tokens, clock, MailArming(true, "u1"), "https://windmill.works");
  const MailSweepReport report = sweep.run(kNow, false);

  CHECK_EQ(report.sent, 0);
  CHECK_EQ(report.skipped, 1);
  CHECK_EQ(report.held, 0);
  CHECK_EQ(report.failed, 0);
  CHECK_EQ(email.sent.size(), std::size_t{0});

  REQUIRE_EQ(nudges.claims.size(), std::size_t{1});
  CHECK_EQ(nudges.claims[0].decision.outcome, NudgeOutcome::skip);
  CHECK_EQ(nudges.claims[0].decision.reason, NudgeSkipReason::alreadyWrote);
  CHECK_EQ(nudges.closes.size(), std::size_t{0});
  CHECK_EQ(nudges.pauseDigests.size(), std::size_t{0});
}

TEST(a_paused_writer_is_skipped_with_no_mail) {
  FakeNudgeRepository nudges;
  armSendableUser(nudges);
  nudges.pause(uid("u1"), kNow + kDay);   // paused a day into the future
  FakeNudgeMail email;
  FakeTokens tokens;
  FakeClock clock;

  NudgeSweep sweep(nudges, email, tokens, clock, MailArming(true, "u1"), "https://windmill.works");
  const MailSweepReport report = sweep.run(kNow, false);

  CHECK_EQ(report.sent, 0);
  CHECK_EQ(report.skipped, 1);
  CHECK_EQ(email.sent.size(), std::size_t{0});
  REQUIRE_EQ(nudges.claims.size(), std::size_t{1});
  CHECK_EQ(nudges.claims[0].decision.outcome, NudgeOutcome::skip);
  CHECK_EQ(nudges.claims[0].decision.reason, NudgeSkipReason::paused);
  CHECK_EQ(nudges.closes.size(), std::size_t{0});
}

TEST(a_writer_off_the_allowlist_has_the_send_held_and_the_day_closed_held) {
  FakeNudgeRepository nudges;
  armSendableUser(nudges);
  FakeNudgeMail email;
  FakeTokens tokens;
  FakeClock clock;

  // Feature on, but a list that does not name u1: the send is decided, claimed, then withheld.
  NudgeSweep sweep(nudges, email, tokens, clock, MailArming(true, "someone-else"),
                   "https://windmill.works");
  const MailSweepReport report = sweep.run(kNow, false);

  CHECK_EQ(report.sent, 0);
  CHECK_EQ(report.held, 1);
  CHECK_EQ(report.skipped, 0);
  CHECK_EQ(report.failed, 0);
  CHECK_EQ(email.sent.size(), std::size_t{0});

  // The ledger says what we DECIDED, not what the flag allowed.
  REQUIRE_EQ(nudges.claims.size(), std::size_t{1});
  CHECK_EQ(nudges.claims[0].decision.outcome, NudgeOutcome::send);
  REQUIRE_EQ(nudges.closes.size(), std::size_t{1});
  CHECK_EQ(nudges.closes[0].outcome, DayOutcome::held);
  CHECK_EQ(nudges.pauseDigests.size(), std::size_t{0});
}

TEST(two_sweeps_of_the_same_day_send_only_once) {
  FakeNudgeRepository nudges;
  armSendableUser(nudges);
  FakeNudgeMail email;
  FakeTokens tokens;
  FakeClock clock;

  NudgeSweep sweep(nudges, email, tokens, clock, MailArming(true, "u1"), "https://windmill.works");
  const MailSweepReport first = sweep.run(kNow, false);
  const MailSweepReport second = sweep.run(kNow, false);

  CHECK_EQ(first.sent, 1);
  CHECK_EQ(second.sent, 0);
  CHECK_EQ(email.sent.size(), std::size_t{1});
  CHECK_EQ(nudges.claims.size(), std::size_t{1});
  CHECK_EQ(nudges.closes.size(), std::size_t{1});
}

TEST(a_rehearsal_claims_and_sends_nothing) {
  FakeNudgeRepository nudges;
  armSendableUser(nudges);
  FakeNudgeMail email;
  FakeTokens tokens;
  FakeClock clock;

  NudgeSweep sweep(nudges, email, tokens, clock, MailArming(true, "u1"), "https://windmill.works");
  const MailSweepReport report = sweep.run(kNow, true);

  CHECK(report.ran);
  CHECK_EQ(report.due, 1);
  CHECK_EQ(report.wouldSend, 1);   // the rehearsal reports what a real run WOULD have sent…
  CHECK_EQ(report.sent, 0);        // …apart from what the provider accepted, which is nothing
  CHECK_EQ(report.claimed, 0);
  CHECK_EQ(report.skipped, 0);
  CHECK_EQ(report.held, 0);
  CHECK_EQ(report.failed, 0);
  CHECK_EQ(nudges.claims.size(), std::size_t{0});
  CHECK_EQ(email.sent.size(), std::size_t{0});
  CHECK_EQ(nudges.closes.size(), std::size_t{0});
  CHECK_EQ(nudges.pauseDigests.size(), std::size_t{0});
}

TEST(a_writer_whose_facts_cannot_be_read_costs_only_their_own_turn) {
  FakeNudgeRepository nudges;
  nudges.armDue(uid("u0"), Email{"broken@example.com"}, ld(kSlotDay), kNow - 120'000);
  nudges.unreadable.insert(uid("u0").str());
  armSendableUser(nudges);
  FakeNudgeMail email;
  FakeTokens tokens;
  FakeClock clock;

  NudgeSweep sweep(nudges, email, tokens, clock, MailArming(true, "u0,u1"), "https://windmill.works");
  const MailSweepReport report = sweep.run(kNow, false);

  CHECK(report.ran);
  CHECK_EQ(report.due, 2);
  CHECK_EQ(report.errors, 1);
  CHECK_EQ(report.claimed, 1);
  CHECK_EQ(report.sent, 1);
  CHECK_EQ(report.skipped, 0);
  CHECK_EQ(report.held, 0);
  CHECK_EQ(report.failed, 0);

  // Nudges stamp no load-failed reason, so the broken day is not claimed and is still due to the next pass.
  REQUIRE_EQ(nudges.claims.size(), std::size_t{1});
  CHECK_EQ(nudges.claims[0].user, uid("u1"));
  REQUIRE_EQ(email.sent.size(), std::size_t{1});
  CHECK_EQ(email.sent[0].to, Email{"writer@example.com"});
  REQUIRE_EQ(nudges.closes.size(), std::size_t{1});
  CHECK_EQ(nudges.closes[0].outcome, DayOutcome::delivered);
}

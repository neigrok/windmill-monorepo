#include "products/roadmap/application/ReminderSweep.h"

#include "test/platform/Fakes.h"
#include "test/products/roadmap/ReminderFakes.h"
#include "test/testing.h"

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

using namespace wm;
using namespace wm::fake;

namespace {

constexpr std::uint64_t kNow = 1'700'000'000'000;
constexpr std::uint64_t kDay = 24ull * 60 * 60 * 1000;
const std::string kSlotDate = "2026-07-28";

DueUser due(const char* user, const char* email) {
  DueUser row;
  row.user = UserId{std::string(user)};
  row.email = Email{email};
  row.slotDate = kSlotDate;
  row.slotInstantMs = kNow - 60'000;
  return row;
}

TreeReadiness readyTree(const char* id, const char* title, std::vector<ReadyStep> ready) {
  TreeReadiness tree;
  tree.id = TreeId{std::string(id)};
  tree.title = title;
  tree.lastActivityAtMs = kNow - 20 * kDay;
  tree.total = 12;
  tree.done = 5;
  tree.ready = std::move(ready);
  return tree;
}

void planOneSendableUser(FakeReminders& reminders) {
  reminders.due = {due("u1", "sailor@example.com")};
  reminders.lastActive["u1"] = kNow - 14 * kDay;
  reminders.born["u1"] = kNow - 90 * kDay;
  reminders.readiness["u1"] = {
      readyTree("t_a", "Learn to sail",
                {ReadyStep{NodeId{"rigging"}, "Rig the boat yourself", NodeColor::olive},
                 ReadyStep{NodeId{"tacking"}, "Tacking", NodeColor::gold}})};
}

}

TEST(a_sweep_decides_claims_and_only_then_mails) {
  FakeReminders reminders;
  planOneSendableUser(reminders);
  FakeReminderMail email;
  FakeTokens tokens;
  FakeClock clock;

  ReminderSweep sweep(reminders, email, tokens, clock, MailArming(true, "u1"),
                      "https://windmill.works");
  const MailSweepReport report = sweep.run(kNow, false);

  CHECK(report.ran);
  CHECK_EQ(report.due, 1);
  CHECK_EQ(report.claimed, 1);
  CHECK_EQ(report.sent, 1);
  CHECK_EQ(report.held, 0);
  CHECK_EQ(report.wouldSend, 0);
  CHECK_EQ(report.skipped, 0);
  CHECK_EQ(report.failed, 0);
  CHECK_EQ(report.errors, 0);
  CHECK_EQ(reminders.askedLimit, kSweepBatch);
  CHECK_EQ(reminders.locksTaken, 1);
  CHECK_EQ(reminders.locksReleased, 1);

  REQUIRE_EQ(reminders.claims.size(), std::size_t{1});
  CHECK_EQ(reminders.claims[0].user, UserId{"u1"});
  CHECK_EQ(reminders.claims[0].slotDate, kSlotDate);
  CHECK_EQ(reminders.claims[0].decision.outcome, ReminderOutcome::send);
  CHECK_EQ(reminders.claims[0].decision.content.treeId, TreeId{"t_a"});

  REQUIRE_EQ(email.sent.size(), std::size_t{1});
  CHECK_EQ(email.sent[0].to, Email{"sailor@example.com"});
  REQUIRE_EQ(reminders.closes.size(), std::size_t{1});
  CHECK_EQ(reminders.closes[0].user, UserId{"u1"});
  CHECK_EQ(reminders.closes[0].slotDate, kSlotDate);
  CHECK_EQ(reminders.closes[0].outcome, WeekOutcome::delivered);
}

TEST(the_mail_carries_the_links_the_counters_and_the_coloured_slots) {
  FakeReminders reminders;
  planOneSendableUser(reminders);
  FakeReminderMail email;
  FakeTokens tokens;
  FakeClock clock;

  ReminderSweep sweep(reminders, email, tokens, clock, MailArming(true, "u1"),
                      "https://windmill.works");
  sweep.run(kNow, false);

  REQUIRE_EQ(email.sent.size(), std::size_t{1});
  const ReminderMail& mail = email.sent[0].mail;
  CHECK_EQ(mail.treeName, std::string("Learn to sail"));
  // The OWNER's tree (#/app/:id), never the public share page (/t/:id).
  CHECK_EQ(mail.treeUrl, std::string("https://windmill.works/#/app/t_a"));
  // Hash-routed app: a bare /settings is a 404 on the static host.
  CHECK_EQ(mail.settingsUrl, std::string("https://windmill.works/#/settings"));
  // The secret rides in the fragment so it never reaches our logs; only its digest is at rest.
  CHECK_EQ(mail.pauseUrl, std::string("https://windmill.works/pause.html#t=s1"));
  // The same secret as a query on a real endpoint — the RFC 8058 one-click target, which becomes the List-Unsubscribe header.
  CHECK_EQ(mail.unsubscribeUrl, std::string("https://windmill.works/v1/reminders/unsubscribe?t=s1"));
  CHECK_EQ(reminders.pauseDigests["u1"], std::string("d1"));
  CHECK_EQ(mail.done, 5);
  CHECK_EQ(mail.total, 12);
  CHECK_EQ(mail.readyPhrase, std::string("2 steps"));
  CHECK_EQ(mail.moreOnTree, std::string(""));
  CHECK_EQ(mail.moreReady, std::string(""));
  CHECK_EQ(mail.steps[0].label, std::string("Rig the boat yourself"));
  CHECK_EQ(mail.steps[0].colorHex, std::string("#7D8C43"));
  CHECK_EQ(mail.steps[1].label, std::string("Tacking"));
  CHECK_EQ(mail.steps[1].colorHex, std::string("#C4972F"));
  CHECK_EQ(mail.steps[2].label, std::string(""));
  CHECK_EQ(mail.steps[2].colorHex, std::string(""));
}

TEST(the_mail_names_the_in_tree_remainder_and_the_other_trees_separately) {
  FakeReminders reminders;
  planOneSendableUser(reminders);
  reminders.readiness["u1"] = {
      readyTree("t_a", "Learn to sail",
                {ReadyStep{NodeId{"a"}, "A", NodeColor::olive},
                 ReadyStep{NodeId{"b"}, "B", NodeColor::gold},
                 ReadyStep{NodeId{"c"}, "C", NodeColor::sky},
                 ReadyStep{NodeId{"d"}, "D", NodeColor::plum},
                 ReadyStep{NodeId{"e"}, "E", NodeColor::brick}}),
      readyTree("t_b", "Ship it", {ReadyStep{NodeId{"one"}, "One", NodeColor::sky}})};
  FakeReminderMail email;
  FakeTokens tokens;
  FakeClock clock;

  ReminderSweep sweep(reminders, email, tokens, clock, MailArming(true, "u1"),
                      "https://windmill.works");
  sweep.run(kNow, false);

  REQUIRE_EQ(email.sent.size(), std::size_t{1});
  const ReminderMail& mail = email.sent[0].mail;
  CHECK_EQ(mail.readyPhrase, std::string("5 steps"));
  CHECK_EQ(mail.moreOnTree, std::string("…and 2 more on this tree"));
  CHECK_EQ(mail.moreReady, std::string("1 other tree has steps ready"));
}

TEST(a_rehearsal_decides_everything_and_commits_nothing) {
  FakeReminders reminders;
  planOneSendableUser(reminders);
  FakeReminderMail email;
  FakeTokens tokens;
  FakeClock clock;

  ReminderSweep sweep(reminders, email, tokens, clock, MailArming(true, "u1"),
                      "https://windmill.works");
  const MailSweepReport report = sweep.run(kNow, true);

  CHECK(report.ran);
  CHECK_EQ(report.due, 1);
  CHECK_EQ(report.claimed, 0);
  CHECK_EQ(report.sent, 0);
  CHECK_EQ(report.skipped, 0);
  CHECK_EQ(report.held, 0);       // nothing was withheld: nothing was ever going to be sent
  CHECK_EQ(report.wouldSend, 1);  // the number the rehearsal exists to report
  CHECK_EQ(reminders.claims.size(), std::size_t{0});
  CHECK_EQ(email.sent.size(), std::size_t{0});
  CHECK_EQ(reminders.closes.size(), std::size_t{0});
}

TEST(a_week_another_sweep_already_owns_is_dropped_in_silence) {
  FakeReminders reminders;
  planOneSendableUser(reminders);
  reminders.weeksOwnedElsewhere.insert("u1");
  FakeReminderMail email;
  FakeTokens tokens;
  FakeClock clock;

  ReminderSweep sweep(reminders, email, tokens, clock, MailArming(true, "u1"),
                      "https://windmill.works");
  const MailSweepReport report = sweep.run(kNow, false);

  CHECK_EQ(report.due, 1);
  CHECK_EQ(report.claimed, 0);
  CHECK_EQ(report.sent, 0);
  CHECK_EQ(report.skipped, 0);
  CHECK_EQ(reminders.claims.size(), std::size_t{1});  // it tried, and lost
  CHECK_EQ(email.sent.size(), std::size_t{0});
  CHECK_EQ(reminders.closes.size(), std::size_t{0});
}

TEST(a_skip_still_claims_its_week_so_the_ledger_stays_complete) {
  FakeReminders reminders;
  planOneSendableUser(reminders);
  reminders.readiness["u1"] = {readyTree("t_a", "Learn to sail", {})};
  FakeReminderMail email;
  FakeTokens tokens;
  FakeClock clock;

  ReminderSweep sweep(reminders, email, tokens, clock, MailArming(true, "u1"),
                      "https://windmill.works");
  const MailSweepReport report = sweep.run(kNow, false);

  CHECK_EQ(report.skipped, 1);
  CHECK_EQ(report.claimed, 1);
  CHECK_EQ(report.sent, 0);
  REQUIRE_EQ(reminders.claims.size(), std::size_t{1});
  CHECK_EQ(reminders.claims[0].decision.outcome, ReminderOutcome::skip);
  CHECK_EQ(reminders.claims[0].decision.reason, SkipReason::noReadySteps);
  CHECK_EQ(email.sent.size(), std::size_t{0});
  CHECK_EQ(reminders.closes.size(), std::size_t{0});
}

TEST(a_dark_engine_records_an_honest_send_holds_it_and_delivers_nothing) {
  FakeReminders reminders;
  planOneSendableUser(reminders);
  FakeReminderMail email;
  FakeTokens tokens;
  FakeClock clock;

  ReminderSweep sweep(reminders, email, tokens, clock, MailArming(false, "u1"),
                      "https://windmill.works");
  const MailSweepReport report = sweep.run(kNow, false);

  CHECK_FALSE(sweep.arming().enabled);
  CHECK_EQ(report.claimed, 1);
  CHECK_EQ(report.held, 1);
  CHECK_EQ(report.sent, 0);
  // The ledger says what we decided, not what the flag allowed.
  CHECK_EQ(reminders.claims[0].decision.outcome, ReminderOutcome::send);
  // And the week is CLOSED as held, so this row can never be read as a crash between the claim and the send.
  REQUIRE_EQ(reminders.closes.size(), std::size_t{1});
  CHECK_EQ(reminders.closes[0].outcome, WeekOutcome::held);
  CHECK_EQ(email.sent.size(), std::size_t{0});
  CHECK_EQ(reminders.pauseDigests.size(), std::size_t{0});
}

TEST(an_armed_engine_still_mails_only_the_allowlist) {
  FakeReminders reminders;
  planOneSendableUser(reminders);
  reminders.due.push_back(due("u2", "other@example.com"));
  reminders.lastActive["u2"] = kNow - 14 * kDay;
  reminders.born["u2"] = kNow - 90 * kDay;
  reminders.readiness["u2"] = {
      readyTree("t_b", "Ship it", {ReadyStep{NodeId{"one"}, "One", NodeColor::sky}})};
  FakeReminderMail email;
  FakeTokens tokens;
  FakeClock clock;

  ReminderSweep sweep(reminders, email, tokens, clock, MailArming(true, "u1"),
                      "https://windmill.works");
  const MailSweepReport report = sweep.run(kNow, false);

  CHECK_EQ(report.due, 2);
  CHECK_EQ(report.claimed, 2);
  CHECK_EQ(report.sent, 1);
  CHECK_EQ(report.held, 1);
  REQUIRE_EQ(email.sent.size(), std::size_t{1});
  CHECK_EQ(email.sent[0].to, Email{"sailor@example.com"});
}

TEST(a_refused_send_is_recorded_never_retried_and_leaves_the_old_pause_link_alive) {
  FakeReminders reminders;
  planOneSendableUser(reminders);
  reminders.pauseDigests["u1"] = "last-weeks-digest";
  FakeReminderMail email;
  email.failNext = true;
  FakeTokens tokens;
  FakeClock clock;

  ReminderSweep sweep(reminders, email, tokens, clock, MailArming(true, "u1"),
                      "https://windmill.works");
  const MailSweepReport report = sweep.run(kNow, false);

  CHECK_EQ(report.claimed, 1);
  CHECK_EQ(report.failed, 1);
  CHECK_EQ(report.sent, 0);
  CHECK_EQ(email.sent.size(), std::size_t{0});
  REQUIRE_EQ(reminders.closes.size(), std::size_t{1});
  CHECK_EQ(reminders.closes[0].outcome, WeekOutcome::refused);
  // The credential rotates only on a mail that actually left, or a pause link still in someone's inbox dies for a replacement that never arrived.
  CHECK_EQ(reminders.pauseDigests["u1"], std::string("last-weeks-digest"));
}

TEST(a_sweep_that_cannot_take_the_fleet_lock_touches_nothing) {
  FakeReminders reminders;
  planOneSendableUser(reminders);
  reminders.lockFree = false;
  FakeReminderMail email;
  FakeTokens tokens;
  FakeClock clock;

  ReminderSweep sweep(reminders, email, tokens, clock, MailArming(true, "u1"),
                      "https://windmill.works");
  const MailSweepReport report = sweep.run(kNow, false);

  CHECK_FALSE(report.ran);
  CHECK_EQ(report.due, 0);
  CHECK_EQ(reminders.locksReleased, 0);
  CHECK_EQ(reminders.claims.size(), std::size_t{0});
  CHECK_EQ(email.sent.size(), std::size_t{0});
}

TEST(a_user_whose_facts_cannot_be_read_still_claims_the_week_and_moves_on) {
  // The pointer only advances inside a claim and dueNow serves the oldest pointer first, so a turn that threw past the claim would return at the head of every future batch.
  FakeReminders reminders;
  planOneSendableUser(reminders);
  reminders.due.insert(reminders.due.begin(), due("u0", "broken@example.com"));
  reminders.unreadable.insert("u0");
  FakeReminderMail email;
  FakeTokens tokens;
  FakeClock clock;

  ReminderSweep sweep(reminders, email, tokens, clock, MailArming(true, "u0,u1"),
                      "https://windmill.works");
  const MailSweepReport report = sweep.run(kNow, false);

  CHECK_EQ(report.due, 2);
  CHECK_EQ(report.errors, 1);
  CHECK_EQ(report.claimed, 2);
  CHECK_EQ(report.skipped, 1);
  CHECK_EQ(report.sent, 1);

  REQUIRE_EQ(reminders.claims.size(), std::size_t{2});
  CHECK_EQ(reminders.claims[0].user, UserId{"u0"});
  CHECK_EQ(reminders.claims[0].slotDate, kSlotDate);
  CHECK_EQ(reminders.claims[0].decision.outcome, ReminderOutcome::skip);
  CHECK_EQ(reminders.claims[0].decision.reason, SkipReason::loadFailed);
  CHECK_EQ(reminders.claims[1].user, UserId{"u1"});

  REQUIRE_EQ(email.sent.size(), std::size_t{1});
  CHECK_EQ(email.sent[0].to, Email{"sailor@example.com"});
  CHECK_EQ(reminders.locksReleased, 1);  // and the fleet lock is still handed back
}

TEST(an_unreadable_user_in_a_rehearsal_commits_nothing_either) {
  FakeReminders reminders;
  planOneSendableUser(reminders);
  reminders.due.insert(reminders.due.begin(), due("u0", "broken@example.com"));
  reminders.unreadable.insert("u0");
  FakeReminderMail email;
  FakeTokens tokens;
  FakeClock clock;

  ReminderSweep sweep(reminders, email, tokens, clock, MailArming(true, "u0,u1"),
                      "https://windmill.works");
  const MailSweepReport report = sweep.run(kNow, true);

  CHECK_EQ(report.due, 2);
  CHECK_EQ(report.errors, 1);
  CHECK_EQ(report.skipped, 1);
  CHECK_EQ(report.wouldSend, 1);
  CHECK_EQ(report.claimed, 0);
  CHECK_EQ(reminders.claims.size(), std::size_t{0});
  CHECK_EQ(email.sent.size(), std::size_t{0});
}

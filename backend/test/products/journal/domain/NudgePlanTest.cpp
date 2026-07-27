#include "products/journal/domain/NudgePlan.h"

#include "test/testing.h"

#include <cstdint>
#include <string>

using namespace wm;

namespace {

constexpr std::uint64_t kNow = 1'700'000'000'000;

// A candidate that, left untouched, decides to SEND: the slot arrived a minute ago, nothing is
// written for the day, and no pause is in force. Each gate test flips exactly one fact.
NudgeCandidate sendable() {
  return NudgeCandidate{UserId{"u1"}, LocalDate{"2026-07-27"}, kNow - 60'000, kNow, false, false};
}

}

// ---- decide: each gate in isolation -------------------------------------------------------

TEST(a_fresh_slot_with_nothing_written_and_no_pause_sends) {
  const NudgeDecision decision = decide(sendable());

  CHECK_EQ(decision.outcome, NudgeOutcome::send);
  CHECK_EQ(decision.reason, NudgeSkipReason::none);
}

TEST(a_paused_candidate_is_skipped) {
  NudgeCandidate candidate = sendable();
  candidate.paused = true;

  const NudgeDecision decision = decide(candidate);

  CHECK_EQ(decision.outcome, NudgeOutcome::skip);
  CHECK_EQ(decision.reason, NudgeSkipReason::paused);
}

TEST(a_slot_missed_by_just_over_the_too_late_bound_is_skipped) {
  NudgeCandidate candidate = sendable();
  candidate.slotInstantMs = kNow - kNudgeTooLateMs - 1;   // one ms past the bound

  const NudgeDecision decision = decide(candidate);

  CHECK_EQ(decision.outcome, NudgeOutcome::skip);
  CHECK_EQ(decision.reason, NudgeSkipReason::tooLate);
}

TEST(a_slot_missed_by_exactly_the_too_late_bound_still_sends) {
  NudgeCandidate candidate = sendable();
  candidate.slotInstantMs = kNow - kNudgeTooLateMs;   // on the bound, not past it — nowMs > x is false

  const NudgeDecision decision = decide(candidate);

  CHECK_EQ(decision.outcome, NudgeOutcome::send);
  CHECK_EQ(decision.reason, NudgeSkipReason::none);
}

TEST(a_candidate_who_already_wrote_today_is_skipped) {
  NudgeCandidate candidate = sendable();
  candidate.wroteToday = true;

  const NudgeDecision decision = decide(candidate);

  CHECK_EQ(decision.outcome, NudgeOutcome::skip);
  CHECK_EQ(decision.reason, NudgeSkipReason::alreadyWrote);
}

// The whole point of mirroring the reminder gate MINUS its lapse branch: a slot that arrived on
// time for a page not yet written is a plain send, no matter how long the writer has been away.
// There is no dormancy fact to set here — that absence IS the guarantee.
TEST(a_long_silent_user_who_is_neither_late_nor_paused_still_sends) {
  NudgeCandidate candidate = sendable();
  candidate.slotInstantMs = kNow - 5 * 60'000;   // arrived five minutes ago, well inside the bound

  const NudgeDecision decision = decide(candidate);

  CHECK_EQ(decision.outcome, NudgeOutcome::send);
  CHECK_EQ(decision.reason, NudgeSkipReason::none);
}

// ---- decide: first-match-wins ordering ----------------------------------------------------

TEST(paused_wins_over_every_later_gate) {
  NudgeCandidate candidate = sendable();
  candidate.paused = true;
  candidate.slotInstantMs = kNow - kNudgeTooLateMs - 1;   // also too late
  candidate.wroteToday = true;                            // also already wrote

  const NudgeDecision decision = decide(candidate);

  CHECK_EQ(decision.reason, NudgeSkipReason::paused);
}

TEST(too_late_wins_over_already_wrote) {
  NudgeCandidate candidate = sendable();
  candidate.slotInstantMs = kNow - kNudgeTooLateMs - 1;   // too late
  candidate.wroteToday = true;                            // and already wrote

  const NudgeDecision decision = decide(candidate);

  CHECK_EQ(decision.reason, NudgeSkipReason::tooLate);
}

// ---- NudgeArming: the dark-launch truth table ---------------------------------------------

TEST(arming_off_reaches_nobody_even_the_listed) {
  const NudgeArming arming(false, "u1,u2");

  CHECK_FALSE(arming.allows(UserId{"u1"}));
  CHECK_FALSE(arming.allows(UserId{"u2"}));
  CHECK_FALSE(arming.allows(UserId{"stranger"}));
}

TEST(arming_on_with_an_empty_list_reaches_everybody) {
  const NudgeArming arming(true, "");

  CHECK(arming.allows(UserId{"u1"}));
  CHECK(arming.allows(UserId{"anyone-at-all"}));
}

TEST(arming_on_with_a_list_reaches_only_the_named) {
  const NudgeArming arming(true, "u1, u3");   // the stray space is trimmed on parse

  CHECK(arming.allows(UserId{"u1"}));
  CHECK(arming.allows(UserId{"u3"}));
  CHECK_FALSE(arming.allows(UserId{"u2"}));
}

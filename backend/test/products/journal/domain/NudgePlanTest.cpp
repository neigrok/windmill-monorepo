#include "products/journal/domain/NudgePlan.h"

#include "test/testing.h"

#include <cstdint>
#include <string>

using namespace wm;

namespace {

constexpr std::uint64_t kNow = 1'700'000'000'000;

// A candidate that, left untouched, decides to SEND. Each gate test flips exactly one fact.
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

// The reminder gate MINUS its lapse branch: a slot that arrived on time for a page not yet written is a plain send. There is no dormancy fact to set here.
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

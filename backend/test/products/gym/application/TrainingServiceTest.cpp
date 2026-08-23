#include "test/products/gym/application/GymServiceFixture.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

using namespace wm::gym;
using namespace wm::gym::fake;
using namespace wm::gym::servicetest;

namespace {
// Two stores that lose a race the service cannot lose on its own: each narrows a window to zero.
struct ClosedUnderTheLock : FakeLogRepository {
  using FakeLogRepository::FakeLogRepository;
  SetInsertOutcome insertSet(const Set&) override {
    return {std::nullopt, SetInsertError::finished};
  }
};

struct DiscardedUnderTheFinish : FakeLogRepository {
  using FakeLogRepository::FakeLogRepository;
  void close(const SessionId& id, std::uint64_t finishedAtMs, ClosedBy closedBy) override {
    FakeLogRepository::close(id, finishedAtMs, closedBy);
    std::erase_if(db.sessions, [&](const Session& session) { return session.id == id; });
  }
};
}

TEST(start_stores_and_returns_the_fresh_session) {
  Harness h;

  StartOutcome started = h.startAt(h.clock.now);

  CHECK(started.error == StartError::none);
  CHECK_EQ(*started.session, Session(sid(), uid(), h.clock.now));
  CHECK_EQ(h.repo.db.sessions, std::vector<Session>{Session(sid(), uid(), h.clock.now)});
}

TEST(start_refuses_a_session_that_begins_in_the_logs_future) {
  Harness h;

  StartOutcome ahead = h.startAt(h.clock.now + kMaxClockAheadMs + 60'000);

  CHECK(ahead.error == StartError::clockAhead);
  CHECK_FALSE(ahead.session.has_value());
  CHECK_EQ(ahead.clockAheadMs, kMaxClockAheadMs + 60'000);
  CHECK(h.repo.db.sessions.empty());

  StartOutcome live = h.startAt(h.clock.now);
  h.clock.now -= 60 * 60 * 1000;  // the server's clock now reads an hour BEHIND the open workout
  StartOutcome joined = h.startAt(h.clock.now + 24ull * 60 * 60 * 1000, "ses_00000002");
  CHECK(joined.error == StartError::none);
  CHECK_EQ(*joined.session, *live.session);
}

TEST(start_replay_converges_on_the_same_session) {
  Harness h;
  StartOutcome first = h.startAt(h.clock.now);

  StartOutcome replayed = h.startAt(h.clock.now);

  CHECK(replayed.error == StartError::none);
  CHECK_EQ(*replayed.session, *first.session);
  CHECK_EQ(h.repo.db.sessions.size(), static_cast<std::size_t>(1));
}

TEST(start_double_tap_with_two_ids_joins_the_first_taps_session) {
  Harness h;
  StartOutcome first = h.startAt(h.clock.now, "ses_00000001");

  StartOutcome second = h.startAt(h.clock.now + 5, "ses_00000002");   // the one-open index refuses it

  CHECK(second.error == StartError::none);
  CHECK_EQ(*second.session, *first.session);
  CHECK_EQ(h.repo.db.sessions.size(), static_cast<std::size_t>(1));
}

TEST(start_refuses_a_session_id_that_belongs_to_another_account) {
  Harness h;
  h.repo.db.sessions.push_back(Session{sid(), uid("u2"), h.clock.now - 5'000});   // another lifter's

  StartOutcome started = h.startAt(h.clock.now);

  CHECK(started.error == StartError::idTaken);
  CHECK_FALSE(started.session.has_value());
  CHECK_EQ(h.repo.db.sessions, std::vector<Session>{Session(sid(), uid("u2"), h.clock.now - 5'000)});
  CHECK_EQ(h.training.detail(uid(), sid()), std::optional<SessionDetail>());
}

TEST(start_replay_of_an_already_finished_start_returns_the_stored_session) {
  Harness h;
  h.startAt(h.clock.now);
  h.training.finish(uid(), sid(), h.clock.now + 1'000);

  StartOutcome replayed = h.startAt(h.clock.now);

  CHECK(replayed.error == StartError::none);
  CHECK_EQ(*replayed.session,
           Session(sid(), uid(), h.clock.now, std::optional<std::uint64_t>(h.clock.now + 1'000),
                   std::nullopt, std::nullopt, ClosedBy::finish));
  CHECK_EQ(h.repo.db.sessions.size(), static_cast<std::size_t>(1));
}

TEST(start_auto_closes_a_stale_setless_session_at_its_start_instant) {
  Harness h;
  const std::uint64_t firstStart = h.clock.now;
  h.startAt(firstStart, "ses_00000001");
  h.clock.now += kAutoCloseMs;

  StartOutcome second = h.startAt(h.clock.now, "ses_00000002");

  CHECK_EQ(second.session->id, sid("ses_00000002"));
  REQUIRE_EQ(h.repo.db.sessions.size(), static_cast<std::size_t>(2));
  CHECK_EQ(h.repo.db.sessions[0].finishedAtMs, std::optional<std::uint64_t>(firstStart));
}

TEST(start_auto_closes_a_stale_session_at_its_last_set_instant) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  const std::uint64_t lastSetAt = h.clock.now + 60'000;
  h.training.append(uid(), sid(), h.bench("set_00000001", 80.0, lastSetAt));
  h.clock.now = lastSetAt + kAutoCloseMs;

  h.startAt(h.clock.now, "ses_00000002");

  CHECK_EQ(h.repo.db.sessions[0].finishedAtMs, std::optional<std::uint64_t>(lastSetAt));
}

TEST(start_leaves_a_live_open_session_alone_and_joins_it) {
  Harness h;
  StartOutcome first = h.startAt(h.clock.now, "ses_00000001");
  h.clock.now += kAutoCloseMs - 1;   // one ms shy of stale

  StartOutcome second = h.startAt(h.clock.now, "ses_00000002");

  CHECK_EQ(*second.session, *first.session);
  CHECK_EQ(h.repo.db.sessions[0].finishedAtMs, std::optional<std::uint64_t>());
}

TEST(start_that_will_not_join_is_refused_while_another_session_is_open) {
  Harness h;
  StartOutcome live = h.startAt(h.clock.now, "ses_00000001");

  StartOutcome backfill = h.startExactly(h.clock.now - kAutoCloseMs, "ses_00000002");

  CHECK(backfill.error == StartError::alreadyOpen);
  CHECK(!backfill.session.has_value());
  // The refusal touches nothing: the live session is still the only row, and still open.
  CHECK_EQ(h.repo.db.sessions, std::vector<Session>{*live.session});
  CHECK_EQ(h.repo.db.sessions[0].finishedAtMs, std::optional<std::uint64_t>());
}

TEST(start_that_will_not_join_stores_the_session_it_named_when_nothing_is_open) {
  Harness h;
  std::uint64_t yesterday = h.clock.now - kAutoCloseMs;

  StartOutcome backfill = h.startExactly(yesterday, "ses_00000002");

  CHECK(backfill.error == StartError::none);
  CHECK_EQ(*backfill.session, Session(sid("ses_00000002"), uid(), yesterday));
}

TEST(start_that_will_not_join_still_replays_its_own_open_session) {
  Harness h;
  // Minutes ago, not hours: a start a full auto-close window old would be settled by the second call.
  std::uint64_t justBefore = h.clock.now - 60'000;
  StartOutcome first = h.startExactly(justBefore, "ses_00000002");

  StartOutcome replayed = h.startExactly(justBefore, "ses_00000002");

  CHECK(replayed.error == StartError::none);
  CHECK_EQ(*replayed.session, *first.session);
  CHECK_EQ(h.repo.db.sessions.size(), static_cast<std::size_t>(1));
}

TEST(append_to_a_missing_session_is_not_found) {
  Harness h;

  AppendOutcome outcome = h.training.append(uid(), sid(), h.bench("set_00000001", 80.0, 1'000));

  CHECK(outcome.error == AppendError::notFound);
  CHECK_FALSE(outcome.set.has_value());
  CHECK(h.repo.db.sets.empty());
}

TEST(append_to_anothers_session_is_the_same_not_found) {
  Harness h;
  h.startAt(h.clock.now);

  AppendOutcome outcome =
      h.training.append(uid("u2"), sid(), h.bench("set_00000001", 80.0, h.clock.now));

  CHECK(outcome.error == AppendError::notFound);
  CHECK(h.repo.db.sets.empty());
}

TEST(append_of_a_new_set_to_a_finished_session_is_finished) {
  Harness h;
  h.startAt(h.clock.now);
  h.training.finish(uid(), sid(), h.clock.now + 1'000);

  AppendOutcome outcome =
      h.training.append(uid(), sid(), h.bench("set_00000001", 80.0, h.clock.now));

  CHECK(outcome.error == AppendError::finished);
  CHECK_FALSE(outcome.set.has_value());
  CHECK(h.repo.db.sets.empty());
}

TEST(append_of_owed_sets_reopens_a_stale_close_and_moves_the_finish_forward) {
  Harness h;
  h.startAt(h.clock.now);
  h.training.append(uid(), sid(), h.bench("set_00000001", 80.0, h.clock.now + 60'000));
  h.clock.now += kAutoCloseMs + 3'600'000;   // a read the next morning settles it stale…
  h.training.log(uid(), LogCursor{kMaxInstantMs, std::nullopt, 10});
  REQUIRE(h.repo.db.sessions[0].finishedAtMs.has_value());
  CHECK_EQ(*h.repo.db.sessions[0].finishedAtMs, h.clock.now - kAutoCloseMs - 3'600'000 + 60'000);
  CHECK(h.repo.db.sessions[0].closedBy == ClosedBy::stale);
  const std::uint64_t lastNight = h.clock.now - kAutoCloseMs - 3'600'000;

  AppendOutcome second = h.training.append(uid(), sid(), h.bench("set_00000002", 82.5, lastNight + 120'000));
  AppendOutcome third = h.training.append(uid(), sid(), h.bench("set_00000003", 85.0, lastNight + 180'000));
  AppendOutcome tomorrow = h.training.append(uid(), sid(), h.bench("set_00000004", 60.0, h.clock.now));

  CHECK(second.error == AppendError::none);
  CHECK(third.error == AppendError::none);
  CHECK(tomorrow.error == AppendError::finished);
  CHECK_EQ(h.repo.db.sets.size(), static_cast<std::size_t>(3));
  CHECK_EQ(*h.repo.db.sessions[0].finishedAtMs, lastNight + 180'000);   // the finish followed the last owed set
  CHECK(h.repo.db.sessions[0].closedBy == ClosedBy::stale);            // still the log's word, still revisable
}

TEST(finish_upgrades_a_stale_close_so_the_lifters_word_ends_the_workout) {
  Harness h;
  h.startAt(h.clock.now);
  const std::uint64_t t0 = h.clock.now;
  h.training.append(uid(), sid(), h.bench("set_00000001", 80.0, t0 + 600'000));
  h.clock.now = t0 + 5 * 3'600'000;
  h.training.detail(uid(), sid());                                    // the mirror settles it stale
  REQUIRE(h.repo.db.sessions[0].closedBy == ClosedBy::stale);

  FinishOutcome finished = h.training.finish(uid(), sid(), t0 + 2 * 3'600'000);
  AppendOutcome after = h.training.append(uid(), sid(), h.bench("set_00000002", 82.5, t0 + 3 * 3'600'000));

  CHECK(finished.error == FinishError::none);
  CHECK_EQ(finished.session->finishedAtMs, std::optional<std::uint64_t>(t0 + 2 * 3'600'000));
  CHECK(finished.session->closedBy == std::optional<ClosedBy>(ClosedBy::finish));
  CHECK(after.error == AppendError::finished);
  CHECK_EQ(h.repo.db.sets.size(), static_cast<std::size_t>(1));
  // A finish EARLIER than the stale close keeps the later instant, and still becomes the lifter's word.
  h.startAt(h.clock.now, "ses_00000002");
  h.training.append(uid(), sid("ses_00000002"), h.bench("set_00000003", 80.0, h.clock.now + 600'000));
  const std::uint64_t t1 = h.clock.now;
  h.clock.now = t1 + 5 * 3'600'000;
  h.training.detail(uid(), sid("ses_00000002"));
  FinishOutcome early = h.training.finish(uid(), sid("ses_00000002"), t1 + 60'000);
  CHECK_EQ(early.session->finishedAtMs, std::optional<std::uint64_t>(t1 + 600'000));
  CHECK(early.session->closedBy == std::optional<ClosedBy>(ClosedBy::finish));
  // A tap hours after the last set keeps the end at that set; only the word changes.
  h.startAt(h.clock.now, "ses_00000003");
  h.training.append(uid(), sid("ses_00000003"), h.bench("set_00000004", 80.0, h.clock.now + 600'000));
  const std::uint64_t t2 = h.clock.now;
  h.clock.now = t2 + 5 * 3'600'000;
  h.training.detail(uid(), sid("ses_00000003"));
  FinishOutcome late = h.training.finish(uid(), sid("ses_00000003"), h.clock.now);
  CHECK_EQ(late.session->finishedAtMs, std::optional<std::uint64_t>(t2 + 600'000));
  CHECK(late.session->closedBy == std::optional<ClosedBy>(ClosedBy::finish));
}

TEST(append_after_the_lifters_own_finish_never_lands_however_close) {
  Harness h;
  h.startAt(h.clock.now);
  h.training.append(uid(), sid(), h.bench("set_00000001", 80.0, h.clock.now + 60'000));
  h.training.finish(uid(), sid(), h.clock.now + 120'000);

  AppendOutcome late = h.training.append(uid(), sid(), h.bench("set_00000002", 82.5, h.clock.now + 90'000));

  CHECK(late.error == AppendError::finished);
  CHECK_EQ(h.repo.db.sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(*h.repo.db.sessions[0].finishedAtMs, h.clock.now + 120'000);
}

// A set that is ALREADY durable must never answer 409: the flush queue treats 409 as terminal.
TEST(append_replays_an_already_stored_set_across_the_finish_boundary) {
  Harness h;
  h.startAt(h.clock.now);
  AppendOutcome landed = h.training.append(uid(), sid(), h.bench("set_00000001", 80.0, h.clock.now + 1));
  h.training.finish(uid(), sid(), h.clock.now + 1'000);

  AppendOutcome replayed =
      h.training.append(uid(), sid(), h.bench("set_00000001", 80.0, h.clock.now + 1));

  CHECK(replayed.error == AppendError::none);
  CHECK_EQ(*replayed.set, *landed.set);
  CHECK_EQ(h.repo.db.sets.size(), static_cast<std::size_t>(1));
}

TEST(append_refuses_a_set_id_minted_by_another_account) {
  Harness h;
  h.repo.db.sessions.push_back(Session{sid("ses_00000002"), uid("u2"), h.clock.now});
  h.repo.db.sets.push_back(Set{setId("set_00000001"), sid("ses_00000002"), ExerciseId{"bench-press"},
                            1, 142.5, 3, SetKind::working, std::optional<double>(9.5),
                            "knee felt off, deload next week", h.clock.now});
  h.startAt(h.clock.now);

  AppendOutcome outcome =
      h.training.append(uid(), sid(), h.bench("set_00000001", 7.5, h.clock.now + 1));

  CHECK(outcome.error == AppendError::idTaken);
  CHECK_FALSE(outcome.set.has_value());   // never the stranger's row, not even to say it exists
  REQUIRE_EQ(h.repo.db.sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.db.sets[0].weightKg, 142.5);
  CHECK_EQ(h.training.detail(uid(), sid())->sets, std::vector<Set>{});
}

TEST(append_refuses_a_set_id_the_same_lifter_spent_in_another_session) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.training.append(uid(), sid("ses_00000001"), h.bench("set_00000001", 80.0, h.clock.now + 1));
  h.training.finish(uid(), sid("ses_00000001"), h.clock.now + 2);
  h.startAt(h.clock.now + 3, "ses_00000002");

  AppendOutcome outcome = h.training.append(
      uid(), sid("ses_00000002"),
      SetWrite{setId("set_00000001"), ExerciseId{"back-squat"}, 222.5, 9, SetKind::working,
               std::nullopt, "", h.clock.now + 4});

  CHECK(outcome.error == AppendError::idTaken);
  CHECK_FALSE(outcome.set.has_value());   // the old row is NOT reported as this write's result
  CHECK_EQ(h.repo.db.sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.training.detail(uid(), sid("ses_00000002"))->sets, std::vector<Set>{});
}

TEST(append_of_a_movement_no_catalog_holds_is_unknown_exercise) {
  Harness h;
  h.startAt(h.clock.now);

  AppendOutcome outcome = h.training.append(
      uid(), sid(),
      SetWrite{setId("set_00000001"), ExerciseId{"zercher-squat"}, 100.0, 5, SetKind::working,
               std::nullopt, "", h.clock.now + 1});

  CHECK(outcome.error == AppendError::unknownExercise);
  CHECK_FALSE(outcome.set.has_value());
  CHECK(h.repo.db.sets.empty());
  CHECK_EQ(h.training.detail(uid(), sid())->sets, std::vector<Set>{});
}

TEST(append_naming_another_accounts_private_movement_is_unknown_exercise) {
  Harness h;
  const Exercise theirs{ExerciseId{"ex_22222222"}, "Their Zercher Squat", Pattern::squat,
                        Equipment::barbell, 2.5, true};
  h.repo.db.seedCustom(uid("u2"), theirs);
  h.startAt(h.clock.now);

  AppendOutcome refused = h.training.append(
      uid(), sid(),
      SetWrite{setId("set_00000001"), ExerciseId{"ex_22222222"}, 100.0, 5, SetKind::working,
               std::nullopt, "", h.clock.now + 1});

  CHECK(refused.error == AppendError::unknownExercise);
  CHECK_FALSE(refused.set.has_value());
  CHECK(h.repo.db.sets.empty());

  h.training.start(uid("u2"), SessionStart{sid("ses_00000002"), h.clock.now});
  AppendOutcome mine = h.training.append(
      uid("u2"), sid("ses_00000002"),
      SetWrite{setId("set_00000002"), ExerciseId{"ex_22222222"}, 100.0, 5, SetKind::working,
               std::nullopt, "", h.clock.now + 2});
  CHECK(mine.error == AppendError::none);
  CHECK_EQ(mine.set->exercise, ExerciseId{"ex_22222222"});
}

// The lock reads the state it locks, so a close landing between the read and the insert is caught.
TEST(append_that_reaches_a_session_closed_under_the_lock_is_refused_by_the_store) {
  Harness h;
  h.startAt(h.clock.now);
  h.training.finish(uid(), sid(), h.clock.now + 1'000);

  SetInsertOutcome landed =
      h.repo.log.insertSet(Set{setId("set_00000001"), sid(), ExerciseId{"bench-press"}, 0, 80.0, 8,
                           SetKind::working, std::nullopt, "", h.clock.now + 1});

  CHECK(landed.error == SetInsertError::finished);
  CHECK_FALSE(landed.set.has_value());
  CHECK(h.repo.db.sets.empty());
}

TEST(append_reports_the_stores_finish_refusal_as_the_finished_the_wire_already_knows) {
  FakeGym repo;
  ClosedUnderTheLock log{repo.db};
  wm::fake::FakeClock clock;
  wm::fake::FakeTokens tokens;
  TrainingService service{log, repo.program, clock, tokens};
  repo.db.seed(benchPress());
  service.start(uid(), SessionStart{sid(), clock.now});

  AppendOutcome refused =
      service.append(uid(), sid(),
                     SetWrite{setId("set_00000001"), ExerciseId{"bench-press"}, 80.0, 8,
                              SetKind::working, std::nullopt, "", clock.now + 1});

  CHECK(refused.error == AppendError::finished);
  CHECK_FALSE(refused.set.has_value());
}

TEST(append_numbers_max_plus_one_per_exercise_across_interleaving) {
  Harness h;
  h.startAt(h.clock.now);
  SetWrite squat{setId("set_00000002"), ExerciseId{"back-squat"}, 100.0, 5, SetKind::working,
                 std::nullopt, "", h.clock.now + 2};

  AppendOutcome bench1 = h.training.append(uid(), sid(), h.bench("set_00000001", 80.0, h.clock.now + 1));
  AppendOutcome squat1 = h.training.append(uid(), sid(), squat);
  AppendOutcome bench2 = h.training.append(uid(), sid(), h.bench("set_00000003", 82.5, h.clock.now + 3));

  CHECK_EQ(bench1.set->setNumber, 1);
  CHECK_EQ(squat1.set->setNumber, 1);   // its own count, not the session's
  CHECK_EQ(bench2.set->setNumber, 2);
}

TEST(append_replay_returns_the_stored_row_byte_for_byte) {
  Harness h;
  h.startAt(h.clock.now);
  AppendOutcome first = h.training.append(uid(), sid(), h.bench("set_00000001", 80.0, h.clock.now + 1));

  // The replay arrives with a different weight — the flush queue re-sending after a lost reply.
  AppendOutcome replayed =
      h.training.append(uid(), sid(), h.bench("set_00000001", 90.0, h.clock.now + 99));

  CHECK(replayed.error == AppendError::none);
  CHECK_EQ(*replayed.set, *first.set);
  REQUIRE_EQ(h.repo.db.sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.db.sets[0].weightKg, 80.0);
}

TEST(finish_is_idempotent_and_keeps_the_first_instant) {
  Harness h;
  h.startAt(h.clock.now);

  FinishOutcome first = h.training.finish(uid(), sid(), h.clock.now + 1'000);
  FinishOutcome replayed = h.training.finish(uid(), sid(), h.clock.now + 2'000);

  CHECK(first.error == FinishError::none);
  CHECK_EQ(first.session->finishedAtMs, std::optional<std::uint64_t>(h.clock.now + 1'000));
  CHECK(replayed.error == FinishError::none);
  CHECK_EQ(*replayed.session, *first.session);

  FinishOutcome unknown = h.training.finish(uid(), SessionId{"ses_unknown1"}, h.clock.now + 1);
  CHECK(unknown.error == FinishError::notFound);
  CHECK_FALSE(unknown.session.has_value());
}

TEST(finish_that_finds_the_session_gone_under_it_is_not_found_and_never_an_empty_none) {
  FakeGym repo;
  DiscardedUnderTheFinish log{repo.db};
  wm::fake::FakeClock clock;
  wm::fake::FakeTokens tokens;
  TrainingService service{log, repo.program, clock, tokens};
  service.start(uid(), SessionStart{sid(), clock.now});

  FinishOutcome outcome = service.finish(uid(), sid(), clock.now + 1'000);

  CHECK(outcome.error == FinishError::notFound);
  CHECK_FALSE(outcome.session.has_value());
}

// close is first-writer-wins, so a nonsense instant would be the session's end forever.
TEST(finish_refuses_an_instant_the_session_could_not_have_ended_at) {
  Harness h;
  const std::uint64_t started = h.clock.now;
  h.startAt(started);

  FinishOutcome zero = h.training.finish(uid(), sid(), 0);
  FinishOutcome beforeStart = h.training.finish(uid(), sid(), started - 1);
  FinishOutcome pastTheCeiling = h.training.finish(uid(), sid(), kMaxInstantMs + 1);

  CHECK(zero.error == FinishError::badInstant);
  CHECK(beforeStart.error == FinishError::badInstant);
  CHECK(pastTheCeiling.error == FinishError::badInstant);
  CHECK_FALSE(zero.session.has_value());
  CHECK_EQ(h.repo.db.sessions[0].finishedAtMs, std::optional<std::uint64_t>());

  FinishOutcome atTheStart = h.training.finish(uid(), sid(), started);   // a workout with one rep
  CHECK(atTheStart.error == FinishError::none);
  CHECK_EQ(atTheStart.session->finishedAtMs, std::optional<std::uint64_t>(started));
}

TEST(log_auto_closes_the_stale_open_session_before_listing) {
  Harness h;
  const std::uint64_t started = h.clock.now;
  h.startAt(started);
  h.clock.now += kAutoCloseMs;

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 1);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(1));
  CHECK_EQ(listed[0].summary.session.finishedAtMs, std::optional<std::uint64_t>(started));
  CHECK_EQ(h.repo.db.sessions[0].finishedAtMs, std::optional<std::uint64_t>(started));
}

TEST(log_lists_newest_first_with_counts_and_sorted_names) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.training.append(uid(), sid(), h.bench("set_00000001", 80.0, h.clock.now + 1));
  h.training.append(uid(), sid(),
                   SetWrite{setId("set_00000002"), ExerciseId{"back-squat"}, 100.0, 5,
                            SetKind::working, std::nullopt, "", h.clock.now + 2});
  h.training.finish(uid(), sid(), h.clock.now + 3);
  h.clock.now += 10'000;
  h.startAt(h.clock.now, "ses_00000002");

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 1);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(2));
  CHECK_EQ(listed[0].summary.session.id.str(), std::string("ses_00000002"));
  CHECK_EQ(listed[0].summary.setCount, 0);
  CHECK_EQ(listed[0].summary.exerciseNames, std::vector<std::string>{});
  CHECK_EQ(listed[1].summary.session.id.str(), std::string("ses_00000001"));
  CHECK_EQ(listed[1].summary.setCount, 2);
  CHECK_EQ(listed[1].summary.exerciseNames,
           (std::vector<std::string>{"Back Squat", "Bench Press"}));
}

// The top set is the heaviest WORKING set, ties to more reps, never volume.
TEST(log_carries_the_top_working_set_of_each_session) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.training.append(uid(), sid(), h.bench("set_00000001", 80.0, h.clock.now + 1));
  h.training.append(uid(), sid(),
                   SetWrite{setId("set_00000002"), ExerciseId{"back-squat"}, 100.0, 5,
                            SetKind::working, std::nullopt, "", h.clock.now + 2});
  h.training.append(uid(), sid(),
                   SetWrite{setId("set_00000003"), ExerciseId{"back-squat"}, 100.0, 8,
                            SetKind::working, std::nullopt, "", h.clock.now + 3});
  h.training.append(uid(), sid(),
                   SetWrite{setId("set_00000004"), ExerciseId{"back-squat"}, 140.0, 1,
                            SetKind::warmup, std::nullopt, "", h.clock.now + 4});
  h.training.finish(uid(), sid(), h.clock.now + 5);
  h.clock.now += 10'000;
  h.startAt(h.clock.now, "ses_00000002");   // nothing logged into it yet

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 1);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(2));
  CHECK_EQ(listed[0].summary.topSet, std::optional<TopWorkingSet>());   // not 0 kg × 0
  CHECK_EQ(listed[1].summary.topSet, std::optional<TopWorkingSet>(TopWorkingSet{100.0, 8}));
}

TEST(log_counts_the_working_sets_apart_from_every_set_and_sums_what_they_moved) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.training.append(uid(), sid(),
                   SetWrite{setId("set_00000001"), ExerciseId{"back-squat"}, 60.0, 10,
                            SetKind::warmup, std::nullopt, "", h.clock.now + 1});
  h.training.append(uid(), sid(),
                   SetWrite{setId("set_00000002"), ExerciseId{"back-squat"}, 100.0, 5,
                            SetKind::working, std::nullopt, "", h.clock.now + 2});
  h.training.append(uid(), sid(),
                   SetWrite{setId("set_00000003"), ExerciseId{"back-squat"}, 100.0, 5,
                            SetKind::working, std::nullopt, "", h.clock.now + 3});
  h.training.append(uid(), sid(), h.bench("set_00000004", 82.5, h.clock.now + 4));   // 82.5 × 8
  h.training.finish(uid(), sid(), h.clock.now + 5);

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 10);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(1));
  CHECK_EQ(listed[0].summary.setCount, 4);
  CHECK_EQ(listed[0].summary.workingSetCount, 3);
  CHECK_EQ(listed[0].summary.tonnageKg, 100.0 * 5 + 100.0 * 5 + 82.5 * 8);   // the warmup is not in
}

// Band-assisted work logs a NEGATIVE load, which adds no tonnage rather than subtracting from it.
TEST(log_gives_an_assisted_or_bodyweight_set_no_tonnage_rather_than_letting_it_subtract) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.training.append(uid(), sid(),
                   SetWrite{setId("set_00000001"), ExerciseId{"back-squat"}, 100.0, 5,
                            SetKind::working, std::nullopt, "", h.clock.now + 1});
  h.training.append(uid(), sid(),
                   SetWrite{setId("set_00000002"), ExerciseId{"bench-press"}, -20.0, 10,
                            SetKind::working, std::nullopt, "", h.clock.now + 2});
  h.training.finish(uid(), sid(), h.clock.now + 3);
  h.clock.now += 10'000;
  h.startAt(h.clock.now, "ses_00000002");
  h.training.append(uid(), sid("ses_00000002"),
                   SetWrite{setId("set_00000003"), ExerciseId{"bench-press"}, 0.0, 9,
                            SetKind::working, std::nullopt, "", h.clock.now + 1});
  h.training.finish(uid(), sid("ses_00000002"), h.clock.now + 2);

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 10);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(2));
  CHECK_EQ(listed[0].summary.workingSetCount, 1);
  CHECK_EQ(listed[0].summary.tonnageKg, 0.0);          // chin-ups moved no measurable load
  CHECK_EQ(listed[1].summary.workingSetCount, 2);
  CHECK_EQ(listed[1].summary.tonnageKg, 500.0);        // the assisted set took nothing away
}

// The estimate is absent exactly where Epley is undefined: a working set at or below zero.
TEST(log_puts_the_domains_estimate_on_the_row_and_omits_it_where_there_is_no_estimate) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.training.append(uid(), sid(),
                   SetWrite{setId("set_00000001"), ExerciseId{"back-squat"}, 100.0, 5,
                            SetKind::working, std::nullopt, "", h.clock.now + 1});
  h.training.finish(uid(), sid(), h.clock.now + 2);
  h.clock.now += 10'000;
  h.startAt(h.clock.now, "ses_00000002");
  h.training.append(uid(), sid("ses_00000002"),
                   SetWrite{setId("set_00000002"), ExerciseId{"bench-press"}, 0.0, 9,
                            SetKind::working, std::nullopt, "", h.clock.now + 1});
  h.training.finish(uid(), sid("ses_00000002"), h.clock.now + 2);
  h.clock.now += 10'000;
  h.startAt(h.clock.now, "ses_00000003");   // warmed up and nothing else
  h.training.append(uid(), sid("ses_00000003"),
                   SetWrite{setId("set_00000003"), ExerciseId{"bench-press"}, 40.0, 10,
                            SetKind::warmup, std::nullopt, "", h.clock.now + 1});
  h.training.finish(uid(), sid("ses_00000003"), h.clock.now + 2);

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 10);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(3));
  CHECK_EQ(listed[0].summary.topSet, std::optional<TopWorkingSet>());
  CHECK_EQ(listed[0].topE1rm, std::optional<double>());
  CHECK_EQ(listed[1].summary.topSet, std::optional<TopWorkingSet>(TopWorkingSet{0.0, 9}));
  CHECK_EQ(listed[1].topE1rm, std::optional<double>());
  CHECK_EQ(listed[2].summary.topSet, std::optional<TopWorkingSet>(TopWorkingSet{100.0, 5}));
  CHECK_EQ(listed[2].topE1rm, e1rm(100.0, 5));         // 116.7, and the one copy that computes it
}

TEST(log_and_the_finish_screen_agree_on_a_session_whose_back_offs_beat_its_top_set) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.training.append(uid(), sid(),
                   SetWrite{setId("set_00000001"), ExerciseId{"back-squat"}, 100.0, 5,
                            SetKind::working, std::nullopt, "", h.clock.now + 1});
  for (int number = 2; number <= 4; ++number)
    h.training.append(uid(), sid(),
                     SetWrite{setId("set_0000000" + std::to_string(number)),
                              ExerciseId{"back-squat"}, 95.0, 10, SetKind::working, std::nullopt,
                              "", h.clock.now + static_cast<std::uint64_t>(number)});
  h.training.finish(uid(), sid(), h.clock.now + 5);

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 10);
  std::optional<Review> finished = h.training.review(uid(), sid());

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(1));
  CHECK_EQ(listed[0].summary.topSet, std::optional<TopWorkingSet>(TopWorkingSet{100.0, 5}));
  CHECK_EQ(listed[0].topE1rm, e1rm(95.0, 10));         // 126.7, not the top set's 116.7
  CHECK_EQ(listed[0].topE1rm, finished->stats.topE1rm);
  CHECK(e1rm(95.0, 10) > e1rm(100.0, 5));              // the two really do disagree
}

// The store hands over one row per LOAD carrying the best reps at it; Epley rises with reps at a fixed load.
TEST(log_reads_the_stores_per_load_projection_and_lands_where_a_walk_over_every_set_would) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.training.append(uid(), sid(),
                   SetWrite{setId("set_00000001"), ExerciseId{"back-squat"}, 95.0, 6,
                            SetKind::working, std::nullopt, "", h.clock.now + 1});
  h.training.append(uid(), sid(),
                   SetWrite{setId("set_00000002"), ExerciseId{"back-squat"}, 95.0, 10,
                            SetKind::working, std::nullopt, "", h.clock.now + 2});
  h.training.append(uid(), sid(),
                   SetWrite{setId("set_00000003"), ExerciseId{"back-squat"}, 95.0, 8,
                            SetKind::working, std::nullopt, "", h.clock.now + 3});
  h.training.append(uid(), sid(),
                   SetWrite{setId("set_00000004"), ExerciseId{"bench-press"}, 60.0, 12,
                            SetKind::warmup, std::nullopt, "", h.clock.now + 4});
  h.training.finish(uid(), sid(), h.clock.now + 5);

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 10);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(1));
  // Dated by the SESSION's start rather than by the set that hit those reps (domain/Review.h).
  CHECK_EQ(listed[0].summary.workingMarks,
           (std::vector<PriorMark>{PriorMark{ExerciseId{"back-squat"}, 95.0, 10, h.clock.now}}));
  CHECK_EQ(listed[0].topE1rm, e1rm(95.0, 10));
  CHECK_EQ(topE1rmOf(std::vector<PriorMark>{PriorMark{ExerciseId{"back-squat"}, 95.0, 6, 1},
                                            PriorMark{ExerciseId{"back-squat"}, 95.0, 10, 2},
                                            PriorMark{ExerciseId{"back-squat"}, 95.0, 8, 3}}),
           listed[0].topE1rm);
}

// closedItself is inferred from the auto-close's signature: finished_at at the last set's instant, or at started_at.
TEST(log_says_which_sessions_the_four_hour_rule_closed) {
  Harness h;
  const std::uint64_t started = h.clock.now;
  h.startAt(started, "ses_00000001");
  h.training.append(uid(), sid("ses_00000001"), h.bench("set_00000001", 80.0, started + 60'000));
  h.training.finish(uid(), sid("ses_00000001"), started + 3'600'000);   // a tap, an hour later
  h.clock.now = started + 10'000'000;
  h.startAt(h.clock.now, "ses_00000002");   // left running, and never touched again
  h.training.append(uid(), sid("ses_00000002"),
                   h.bench("set_00000002", 80.0, h.clock.now + 60'000));
  const std::uint64_t abandoned = h.clock.now + 60'000;
  h.clock.now = abandoned + kAutoCloseMs;   // the next log read settles it

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 1);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(2));
  CHECK_EQ(listed[0].summary.session.finishedAtMs, std::optional<std::uint64_t>(abandoned));
  CHECK(listed[0].summary.closedItself);
  CHECK_EQ(listed[1].summary.session.finishedAtMs,
           std::optional<std::uint64_t>(started + 3'600'000));
  CHECK_FALSE(listed[1].summary.closedItself);
}

TEST(log_calls_an_open_session_closed_by_nothing_and_a_setless_auto_close_its_own_start) {
  Harness h;
  const std::uint64_t started = h.clock.now;
  h.startAt(started, "ses_00000001");

  std::vector<LogRow> running = h.logBefore(started + 1);
  h.clock.now = started + kAutoCloseMs;
  std::vector<LogRow> settled = h.logBefore(h.clock.now + 1);

  REQUIRE_EQ(running.size(), static_cast<std::size_t>(1));
  CHECK_EQ(running[0].summary.session.finishedAtMs, std::optional<std::uint64_t>());
  CHECK_FALSE(running[0].summary.closedItself);
  REQUIRE_EQ(settled.size(), static_cast<std::size_t>(1));
  CHECK_EQ(settled[0].summary.session.finishedAtMs, std::optional<std::uint64_t>(started));
  CHECK(settled[0].summary.closedItself);
}

// Two sessions sharing a start instant: only the compound cursor walks the whole log.
TEST(log_pages_across_a_tied_start_instant_without_losing_a_session) {
  Harness h;
  const std::uint64_t tied = h.clock.now;
  h.repo.db.sessions.push_back(Session{sid("ses_00000001"), uid(), tied + 3, tied + 4});
  h.repo.db.sessions.push_back(Session{sid("ses_00000002"), uid(), tied + 2, tied + 4});
  h.repo.db.sessions.push_back(Session{sid("ses_00000003"), uid(), tied + 2, tied + 4});
  h.repo.db.sessions.push_back(Session{sid("ses_00000004"), uid(), tied + 1, tied + 4});

  std::vector<LogRow> first = h.training.log(uid(), LogCursor{tied + 9, std::nullopt, 2});
  std::vector<LogRow> second =
      h.training.log(uid(), LogCursor{first.back().summary.session.startedAtMs,
                                     first.back().summary.session.id, 2});
  std::vector<LogRow> third =
      h.training.log(uid(), LogCursor{second.back().summary.session.startedAtMs,
                                     second.back().summary.session.id, 2});

  REQUIRE_EQ(first.size(), static_cast<std::size_t>(2));
  CHECK_EQ(first[0].summary.session.id, sid("ses_00000001"));
  CHECK_EQ(first[1].summary.session.id, sid("ses_00000003"));
  REQUIRE_EQ(second.size(), static_cast<std::size_t>(2));
  CHECK_EQ(second[0].summary.session.id, sid("ses_00000002"));   // the tie the old cursor skipped
  CHECK_EQ(second[1].summary.session.id, sid("ses_00000004"));
  CHECK(third.empty());
}

TEST(detail_returns_the_session_with_its_sets_in_completion_order) {
  Harness h;
  h.startAt(h.clock.now);
  AppendOutcome second = h.training.append(uid(), sid(), h.bench("set_00000002", 82.5, h.clock.now + 2));
  AppendOutcome first = h.training.append(uid(), sid(), h.bench("set_00000001", 80.0, h.clock.now + 1));

  std::optional<SessionDetail> detail = h.training.detail(uid(), sid());

  REQUIRE(detail.has_value());
  CHECK_EQ(detail->session.id, sid());
  CHECK_EQ(detail->sets, (std::vector<Set>{*first.set, *second.set}));
  CHECK_EQ(h.training.detail(uid("u2"), sid()), std::optional<SessionDetail>());
}

// The read settles the four-hour rule and ends the session STALE, so a phone's owed set still lands.
TEST(detail_settles_a_stale_open_session_at_its_last_set_and_leaves_the_close_revisable) {
  Harness h;
  h.startAt(h.clock.now);
  h.training.append(uid(), sid(), h.bench("set_00000001", 80.0, h.clock.now + 60'000));
  h.clock.now += kAutoCloseMs + 3'600'000;

  std::optional<SessionDetail> detail = h.training.detail(uid(), sid());

  REQUIRE(detail.has_value());
  CHECK_EQ(detail->session.finishedAtMs, std::optional<std::uint64_t>(h.clock.now - kAutoCloseMs - 3'600'000 + 60'000));
  CHECK(detail->session.closedBy == std::optional<ClosedBy>(ClosedBy::stale));
  AppendOutcome owed = h.training.append(uid(), sid(), h.bench("set_00000002", 82.5, h.clock.now - kAutoCloseMs - 3'600'000 + 120'000));
  CHECK(owed.error == AppendError::none);
}

TEST(last_time_is_the_most_recent_finished_session_never_the_open_one) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.training.append(uid(), sid("ses_00000001"), h.bench("set_00000001", 80.0, h.clock.now + 1));
  h.training.finish(uid(), sid("ses_00000001"), h.clock.now + 2);
  h.clock.now += 10'000;
  h.startAt(h.clock.now, "ses_00000002");
  AppendOutcome top =
      h.training.append(uid(), sid("ses_00000002"), h.bench("set_00000002", 82.5, h.clock.now + 1));
  AppendOutcome backOff =
      h.training.append(uid(), sid("ses_00000002"), h.bench("set_00000003", 80.0, h.clock.now + 2));
  h.training.finish(uid(), sid("ses_00000002"), h.clock.now + 3);
  h.clock.now += 10'000;
  h.startAt(h.clock.now, "ses_00000003");
  h.training.append(uid(), sid("ses_00000003"), h.bench("set_00000004", 100.0, h.clock.now + 1));

  LastTimeOutcome last = h.training.lastTime(uid(), ExerciseId{"bench-press"});

  CHECK(last.error == LastTimeError::none);
  CHECK_EQ(last.lastTime->session.id, sid("ses_00000002"));
  CHECK_EQ(last.lastTime->routineName, std::string(""));
  CHECK_EQ(last.lastTime->sets, (std::vector<Set>{*top.set, *backOff.set}));
  CHECK_EQ(h.repo.db.sessions[2].finishedAtMs, std::optional<std::uint64_t>());
}

TEST(last_time_is_the_working_block_in_set_order_and_never_the_warmups) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.training.append(uid(), sid("ses_00000001"),
                   SetWrite{setId("set_00000001"), ExerciseId{"bench-press"}, 40.0, 10,
                            SetKind::warmup, std::nullopt, "", h.clock.now + 1});
  AppendOutcome first =
      h.training.append(uid(), sid("ses_00000001"), h.bench("set_00000002", 82.5, h.clock.now + 2));
  AppendOutcome second =
      h.training.append(uid(), sid("ses_00000001"), h.bench("set_00000003", 82.5, h.clock.now + 3));
  AppendOutcome third =
      h.training.append(uid(), sid("ses_00000001"), h.bench("set_00000004", 80.0, h.clock.now + 4));
  h.training.append(uid(), sid("ses_00000001"),
                   SetWrite{setId("set_00000005"), ExerciseId{"back-squat"}, 100.0, 5,
                            SetKind::working, std::nullopt, "", h.clock.now + 5});
  h.training.finish(uid(), sid("ses_00000001"), h.clock.now + 6);
  h.repo.db.sessions[0].plan = PlanSnapshot{"Bench day", {}};

  LastTimeOutcome last = h.training.lastTime(uid(), ExerciseId{"bench-press"});

  CHECK(last.error == LastTimeError::none);
  CHECK_EQ(last.lastTime->routineName, std::string("Bench day"));
  CHECK_EQ(last.lastTime->sets, (std::vector<Set>{*first.set, *second.set, *third.set}));
  // Numbering counts the warmup (max+1 per session and exercise), so the block starts at 2.
  CHECK_EQ(last.lastTime->sets[0].setNumber, 2);
}

TEST(last_time_steps_over_a_session_that_only_warmed_this_movement_up) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  AppendOutcome worked =
      h.training.append(uid(), sid("ses_00000001"), h.bench("set_00000001", 82.5, h.clock.now + 1));
  h.training.finish(uid(), sid("ses_00000001"), h.clock.now + 2);
  h.clock.now += 10'000;
  h.startAt(h.clock.now, "ses_00000002");
  h.training.append(uid(), sid("ses_00000002"),
                   SetWrite{setId("set_00000002"), ExerciseId{"bench-press"}, 40.0, 10,
                            SetKind::warmup, std::nullopt, "", h.clock.now + 1});
  h.training.finish(uid(), sid("ses_00000002"), h.clock.now + 2);

  LastTimeOutcome last = h.training.lastTime(uid(), ExerciseId{"bench-press"});

  CHECK(last.error == LastTimeError::none);
  CHECK_EQ(last.lastTime->session.id, sid("ses_00000001"));
  CHECK_EQ(last.lastTime->sets, std::vector<Set>{*worked.set});
}

TEST(last_time_never_reaches_into_another_accounts_log) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  AppendOutcome mine =
      h.training.append(uid(), sid("ses_00000001"), h.bench("set_00000001", 82.5, h.clock.now + 1));
  h.training.finish(uid(), sid("ses_00000001"), h.clock.now + 2);
  h.repo.db.sessions.push_back(
      Session{sid("ses_00000009"), uid("u2"), h.clock.now + 10, h.clock.now + 30});
  h.repo.db.sets.push_back(Set{setId("set_00000009"), sid("ses_00000009"), ExerciseId{"bench-press"},
                            1, 142.5, 3, SetKind::working, std::nullopt, "", h.clock.now + 20});

  LastTimeOutcome ours = h.training.lastTime(uid(), ExerciseId{"bench-press"});
  LastTimeOutcome theirs = h.training.lastTime(uid("u2"), ExerciseId{"bench-press"});

  CHECK(ours.error == LastTimeError::none);
  CHECK_EQ(ours.lastTime->session.id, sid("ses_00000001"));
  CHECK_EQ(ours.lastTime->sets, std::vector<Set>{*mine.set});
  CHECK(theirs.error == LastTimeError::none);
  CHECK_EQ(theirs.lastTime->session.id, sid("ses_00000009"));
  CHECK_EQ(theirs.lastTime->sets, std::vector<Set>{h.repo.db.sets[1]});
}

// Never trained and no such movement are different answers, and only the store can tell them apart.
TEST(last_time_of_a_first_ever_movement_is_a_fact_and_of_an_unknown_one_is_a_fault) {
  Harness h;
  h.startAt(h.clock.now);
  h.training.append(uid(), sid(), h.bench("set_00000001", 82.5, h.clock.now + 1));
  h.training.finish(uid(), sid(), h.clock.now + 2);
  h.repo.db.seedCustom(uid("u2"), Exercise{ExerciseId{"landmine-press"}, "Landmine Press",
                                        Pattern::press, Equipment::barbell, 2.5, true});

  LastTimeOutcome firstEver = h.training.lastTime(uid(), ExerciseId{"back-squat"});
  LastTimeOutcome unknown = h.training.lastTime(uid(), ExerciseId{"zercher-squat"});
  LastTimeOutcome anothersCustom = h.training.lastTime(uid(), ExerciseId{"landmine-press"});

  CHECK(firstEver.error == LastTimeError::none);
  CHECK_FALSE(firstEver.lastTime.has_value());
  CHECK(unknown.error == LastTimeError::unknownExercise);
  CHECK_FALSE(unknown.lastTime.has_value());
  CHECK(anothersCustom.error == LastTimeError::unknownExercise);
  CHECK_FALSE(anothersCustom.lastTime.has_value());
}

// The prefill must leave the workout the lifter is in open: a close nobody can see refuses every set after it.
TEST(last_time_never_closes_the_session_the_lifter_is_in) {
  Harness h;
  const std::uint64_t started = h.clock.now;
  h.startAt(started, "ses_00000001");
  AppendOutcome lastWeek =
      h.training.append(uid(), sid("ses_00000001"), h.bench("set_00000001", 82.5, started + 1));
  h.training.finish(uid(), sid("ses_00000001"), started + 2);
  const std::uint64_t liveSetAt = started + 4;
  h.clock.now = started + 3;
  h.startAt(h.clock.now, "ses_00000002");
  h.training.append(uid(), sid("ses_00000002"), h.bench("set_00000002", 100.0, liveSetAt));
  h.clock.now = liveSetAt + kAutoCloseMs;   // the live workout now reads as idle past the window

  LastTimeOutcome last = h.training.lastTime(uid(), ExerciseId{"bench-press"});
  AppendOutcome next =
      h.training.append(uid(), sid("ses_00000002"), h.bench("set_00000003", 102.5, h.clock.now + 1));

  CHECK(last.error == LastTimeError::none);
  CHECK_EQ(last.lastTime->session.id, sid("ses_00000001"));   // never the live one, closed or not
  CHECK_EQ(last.lastTime->sets, std::vector<Set>{*lastWeek.set});
  CHECK_EQ(h.repo.db.sessions[1].finishedAtMs, std::optional<std::uint64_t>());
  CHECK(next.error == AppendError::none);
  CHECK_EQ(next.set->setNumber, 2);
}

TEST(last_time_sees_a_stale_session_once_the_log_read_has_settled_it) {
  Harness h;
  const std::uint64_t started = h.clock.now;
  h.startAt(started, "ses_00000001");
  AppendOutcome older =
      h.training.append(uid(), sid("ses_00000001"), h.bench("set_00000001", 80.0, started + 1));
  h.training.finish(uid(), sid("ses_00000001"), started + 2);
  const std::uint64_t abandonedStart = started + 10'000;
  const std::uint64_t abandonedSetAt = abandonedStart + 1;
  h.clock.now = abandonedStart;
  h.startAt(abandonedStart, "ses_00000002");
  AppendOutcome abandoned =
      h.training.append(uid(), sid("ses_00000002"), h.bench("set_00000002", 82.5, abandonedSetAt));
  h.clock.now = abandonedSetAt + kAutoCloseMs;

  LastTimeOutcome beforeTheLogRead = h.training.lastTime(uid(), ExerciseId{"bench-press"});
  h.logBefore(h.clock.now + 1);
  LastTimeOutcome afterTheLogRead = h.training.lastTime(uid(), ExerciseId{"bench-press"});

  CHECK_EQ(beforeTheLogRead.lastTime->session.id, sid("ses_00000001"));
  CHECK_EQ(beforeTheLogRead.lastTime->sets, std::vector<Set>{*older.set});
  CHECK_EQ(afterTheLogRead.lastTime->session.id, sid("ses_00000002"));
  CHECK_EQ(afterTheLogRead.lastTime->session.finishedAtMs,
           std::optional<std::uint64_t>(abandonedSetAt));
  CHECK_EQ(afterTheLogRead.lastTime->sets, std::vector<Set>{*abandoned.set});
}

// Last time is the newest SESSION, never the newest set instant.
TEST(last_time_is_the_newest_session_even_when_an_older_one_holds_a_future_stamped_set) {
  Harness h;
  const std::uint64_t day = 86'400'000;
  const std::uint64_t weekAgo = h.clock.now;
  h.startAt(weekAgo, "ses_00000001");
  h.training.append(uid(), sid("ses_00000001"), h.bench("set_00000001", 60.0, weekAgo + 30 * day));
  h.training.finish(uid(), sid("ses_00000001"), weekAgo + 1'000);
  h.clock.now = weekAgo + 7 * day;
  h.startAt(h.clock.now, "ses_00000002");
  AppendOutcome yesterday =
      h.training.append(uid(), sid("ses_00000002"), h.bench("set_00000002", 100.0, h.clock.now + 1));
  h.training.finish(uid(), sid("ses_00000002"), h.clock.now + 2);

  LastTimeOutcome last = h.training.lastTime(uid(), ExerciseId{"bench-press"});
  std::vector<LogRow> listed = h.logBefore(h.clock.now + 10'000);

  CHECK(last.error == LastTimeError::none);
  CHECK_EQ(last.lastTime->session.id, sid("ses_00000002"));
  CHECK_EQ(last.lastTime->sets, std::vector<Set>{*yesterday.set});
  CHECK_EQ(listed[0].summary.session.id, last.lastTime->session.id);
}

TEST(last_time_names_the_routine_the_session_was_trained_under_not_the_one_stored_today) {
  Harness h;
  h.create(h.pushAWrite());
  h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  AppendOutcome landed =
      h.training.append(uid(), sid("ses_00000001"), h.bench("set_00000001", 82.5, h.clock.now + 1));
  h.training.finish(uid(), sid("ses_00000001"), h.clock.now + 2);

  h.program.replaceRoutine(uid(), rtId(), h.pushAWrite({benchEntry()}, "rt_00000001", "Bench day"));
  LastTimeOutcome afterRename = h.training.lastTime(uid(), ExerciseId{"bench-press"});
  h.program.deleteRoutine(uid(), rtId());
  LastTimeOutcome afterDelete = h.training.lastTime(uid(), ExerciseId{"bench-press"});

  CHECK(afterRename.error == LastTimeError::none);
  CHECK_EQ(afterRename.lastTime->routineName, std::string("Push A"));
  CHECK_EQ(afterDelete.lastTime->routineName, std::string("Push A"));
  CHECK_EQ(afterDelete.lastTime->session.routine, std::optional<RoutineId>());
  CHECK_EQ(afterDelete.lastTime->session.plan,
           std::optional<PlanSnapshot>(PlanSnapshot{
               "Push A", {PlanEntry{ExerciseId{"bench-press"}, 5, 5, 82.5, 180}}}));
  CHECK_EQ(afterDelete.lastTime->sets, std::vector<Set>{*landed.set});
}

TEST(start_from_a_routine_freezes_its_name_and_entries_onto_the_session) {
  Harness h;
  h.create(h.pushAWrite({benchEntry(1), RoutineEntry{
                                                  2, ExerciseId{"back-squat"}, 3, 8, std::nullopt,
                                                  std::nullopt}}));

  StartOutcome started = h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");

  CHECK(started.error == StartError::none);
  CHECK_EQ(started.session->routine, std::optional<RoutineId>(rtId()));
  CHECK_EQ(started.session->plan,
           std::optional<PlanSnapshot>(PlanSnapshot{
               "Push A",
               {PlanEntry{ExerciseId{"bench-press"}, 5, 5, 82.5, 180},
                PlanEntry{ExerciseId{"back-squat"}, 3, 8, std::nullopt, std::nullopt}}}));
  CHECK_EQ(h.repo.db.sessions[0], *started.session);
}

TEST(a_routine_line_with_no_rep_target_survives_the_write_and_the_freeze) {
  Harness h;
  h.repo.db.seed(Exercise{ExerciseId{"chin-up"}, "Chin-up", Pattern::pull, Equipment::bodyweight, 2.5,
                       false});
  RoutineWriteOutcome created = h.create(h.pushAWrite({RoutineEntry{1, ExerciseId{"chin-up"}, 3, std::nullopt, std::nullopt,
                                        180}}));

  StartOutcome started = h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");

  CHECK(created.error == RoutineWriteError::none);
  CHECK_EQ(created.routine->entries[0].targetReps, std::optional<int>());
  CHECK_EQ(h.program.routine(uid(), rtId())->entries[0].targetReps, std::optional<int>());
  CHECK(started.error == StartError::none);
  CHECK_EQ(started.session->plan,
           std::optional<PlanSnapshot>(PlanSnapshot{
               "Push A", {PlanEntry{ExerciseId{"chin-up"}, 3, std::nullopt, std::nullopt, 180}}}));
}

TEST(start_naming_a_routine_this_account_cannot_read_is_refused) {
  Harness h;
  h.repo.db.routineRows.push_back(Routine{rtId("rt_00000002"), uid("u2"), "Their plan", 0,
                                       {benchEntry()}});

  StartOutcome unknown = h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  StartOutcome theirs = h.startFrom(h.clock.now, "ses_00000001", "rt_00000002");

  CHECK(unknown.error == StartError::unknownRoutine);
  CHECK(theirs.error == StartError::unknownRoutine);
  CHECK_FALSE(unknown.session.has_value());
  CHECK_FALSE(theirs.session.has_value());
  CHECK(h.repo.db.sessions.empty());
}

TEST(start_that_joins_an_open_session_keeps_the_plan_that_session_began_with) {
  Harness h;
  h.create(h.pushAWrite({benchEntry()}, "rt_00000001", "Push A"));
  h.create(h.pushAWrite({benchEntry()}, "rt_00000002", "Legs"));
  StartOutcome live = h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");

  StartOutcome joined = h.startFrom(h.clock.now + 5, "ses_00000002", "rt_00000002");
  StartOutcome adHoc = h.startAt(h.clock.now + 6, "ses_00000003");

  CHECK(joined.error == StartError::none);
  CHECK_EQ(*joined.session, *live.session);
  CHECK_EQ(joined.session->plan->routineName, std::string("Push A"));
  CHECK(adHoc.error == StartError::none);
  CHECK_EQ(adHoc.session->plan->routineName, std::string("Push A"));
  CHECK_EQ(h.repo.db.sessions.size(), static_cast<std::size_t>(1));
}

TEST(start_replay_keeps_the_plan_the_session_was_started_under) {
  Harness h;
  h.create(h.pushAWrite({benchEntry()}, "rt_00000001", "Push A"));
  h.create(h.pushAWrite({benchEntry()}, "rt_00000002", "Legs"));
  StartOutcome first = h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  h.training.finish(uid(), sid("ses_00000001"), h.clock.now + 1);

  StartOutcome replayed = h.startFrom(h.clock.now, "ses_00000001", "rt_00000002");

  CHECK(replayed.error == StartError::none);
  CHECK_EQ(replayed.session->plan->routineName, std::string("Push A"));
  CHECK_EQ(replayed.session->routine, std::optional<RoutineId>(rtId("rt_00000001")));
  CHECK_EQ(replayed.session->startedAtMs, first.session->startedAtMs);
  CHECK_EQ(h.repo.db.sessions.size(), static_cast<std::size_t>(1));
}

// The routine is loaded only where a session is actually CREATED, so a replay and a join cannot 404.
TEST(start_replay_and_join_survive_a_routine_deleted_since_the_workout_began) {
  Harness h;
  h.create(h.pushAWrite({benchEntry()}, "rt_00000001", "Push A"));
  StartOutcome live = h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  CHECK(h.program.deleteRoutine(uid(), rtId("rt_00000001")));

  StartOutcome replayed = h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  StartOutcome joined = h.startFrom(h.clock.now + 5, "ses_00000002", "rt_00000001");

  CHECK(live.error == StartError::none);
  CHECK(replayed.error == StartError::none);
  CHECK_EQ(replayed.session->id, sid("ses_00000001"));
  CHECK_EQ(replayed.session->routine, std::optional<RoutineId>());
  CHECK_EQ(replayed.session->plan->routineName, std::string("Push A"));
  CHECK(joined.error == StartError::none);
  CHECK_EQ(joined.session->id, sid("ses_00000001"));
  CHECK_EQ(joined.session->plan->routineName, std::string("Push A"));
  CHECK_EQ(h.repo.db.sessions.size(), static_cast<std::size_t>(1));
}

TEST(start_resolves_its_own_id_before_it_ever_looks_at_a_routine) {
  Harness h;
  h.create(h.pushAWrite({benchEntry()}, "rt_00000001", "Push A"));
  h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  h.training.finish(uid(), sid("ses_00000001"), h.clock.now + 1);
  h.startFrom(h.clock.now + 10, "ses_00000002", "rt_00000001");   // and this one stays open
  CHECK(h.program.deleteRoutine(uid(), rtId("rt_00000001")));

  StartOutcome finishedReplay = h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  StartOutcome willNotJoin = h.training.start(
      uid(), SessionStart{sid("ses_00000003"), h.clock.now + 20, false, rtId("rt_00000001")});

  CHECK(finishedReplay.error == StartError::none);
  CHECK_EQ(finishedReplay.session->finishedAtMs, std::optional<std::uint64_t>(h.clock.now + 1));
  CHECK(willNotJoin.error == StartError::alreadyOpen);
  CHECK_FALSE(willNotJoin.session.has_value());
  CHECK_EQ(h.repo.db.sessions.size(), static_cast<std::size_t>(2));
}

TEST(review_of_a_missing_or_anothers_session_is_the_same_absence) {
  Harness h;
  h.repo.db.sessions.push_back(Session{sid("ses_00000002"), uid("u2"), h.clock.now,
                                    h.clock.now + 3'600'000});

  CHECK_EQ(h.training.review(uid(), sid("ses_00000001")), std::optional<Review>());
  CHECK_EQ(h.training.review(uid(), sid("ses_00000002")), std::optional<Review>());
}

// The review is read AFTER the finish, so the session is kept out of its own history by the (startedAt, id) window.
TEST(review_reads_the_marks_of_earlier_sessions_and_never_the_one_it_is_reviewing) {
  Harness h;
  h.trained("ses_00000001", h.clock.now - 2 * kWeek, 100, 5, 4);
  h.trained("ses_00000002", h.clock.now - kWeek, 105, 5, 4);

  std::optional<Review> result = h.training.review(uid(), sid("ses_00000002"));
  std::optional<Review> again = h.training.review(uid(), sid("ses_00000002"));

  // The beaten mark is dated by the SESSION that set it (domain/Review.h).
  const PersonalRecord estimate{RecordKind::e1rm, ExerciseId{"back-squat"}, 122.5, 105.0, 5, 116.7,
                                h.clock.now - 2 * kWeek};
  REQUIRE(result.has_value());
  REQUIRE(result->record.has_value());
  CHECK_EQ(*result->record, estimate);
  CHECK_EQ(result->stats.workingSets, 4);
  CHECK_EQ(result, again);
}

TEST(review_never_takes_a_session_still_running_as_history) {
  Harness h;
  h.stored("ses_00000001", h.clock.now - 2 * kWeek, std::nullopt, 200, 5, 4);
  h.stored("ses_00000002", h.clock.now - kWeek, h.clock.now - kWeek + 3'600'000, 100, 5, 4);
  h.stored("ses_00000003", h.clock.now - 3'600'000, h.clock.now, 105, 5, 4);

  std::optional<Review> result = h.training.review(uid(), sid("ses_00000003"));

  REQUIRE(result.has_value());
  REQUIRE(result->record.has_value());
  CHECK_EQ(result->record->previous, 116.7);   // the finished 100 × 5, never the open 200 × 5
}

TEST(review_stands_against_the_last_session_of_the_same_routine) {
  Harness h;
  h.create(h.pushAWrite({RoutineEntry{1, ExerciseId{"back-squat"}, 5, 5, 100.0, 180}}));
  h.trained("ses_00000001", h.clock.now - 2 * kWeek, 95, 5, 4, "rt_00000001");
  h.trained("ses_00000002", h.clock.now - kWeek, 100, 5, 4);   // the same movement, no day behind it
  h.trained("ses_00000003", h.clock.now - 3'600'000, 105, 5, 4, "rt_00000001");

  std::optional<Review> result = h.training.review(uid(), sid("ses_00000003"));

  const std::vector<AgainstMovement> movements{
      AgainstMovement{ExerciseId{"back-squat"}, TopSet{105, 5, 4}, TopSet{95, 5, 4},
                      PlanEntry{ExerciseId{"back-squat"}, 5, 5, 100.0, 180}}};
  REQUIRE(result.has_value());
  REQUIRE(result->against.has_value());
  CHECK_EQ(result->against->session, sid("ses_00000001"));
  CHECK_EQ(result->against->routineName, std::string("Push A"));
  CHECK_EQ(result->against->startedAtMs, h.clock.now - 2 * kWeek);
  CHECK_EQ(result->against->movements, movements);
}

TEST(discard_refuses_a_session_that_is_still_running) {
  Harness h;
  h.startAt(h.clock.now);
  h.training.append(uid(), sid(), h.bench("set_00000001", 82.5, h.clock.now + 1));

  DiscardOutcome refused = h.training.discard(uid(), sid());

  CHECK(refused == DiscardOutcome::open);
  CHECK_EQ(h.repo.db.sessions.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.db.sets.size(), static_cast<std::size_t>(1));
}

TEST(discard_takes_the_session_and_its_sets_and_asking_twice_is_the_same_fact) {
  Harness h;
  h.trained("ses_00000001", h.clock.now - 3'600'000, 100, 5, 4);

  DiscardOutcome first = h.training.discard(uid(), sid("ses_00000001"));
  DiscardOutcome again = h.training.discard(uid(), sid("ses_00000001"));

  CHECK(first == DiscardOutcome::done);
  CHECK(again == DiscardOutcome::notFound);
  CHECK(h.repo.db.sessions.empty());
  CHECK(h.repo.db.sets.empty());   // the sets go with the row, never orphaned behind it
}

TEST(discard_never_reaches_another_accounts_session) {
  Harness h;
  h.repo.db.sessions.push_back(Session{sid("ses_00000002"), uid("u2"), h.clock.now,
                                    h.clock.now + 3'600'000});

  DiscardOutcome theirs = h.training.discard(uid(), sid("ses_00000002"));

  CHECK(theirs == DiscardOutcome::notFound);   // absent and forbidden are one answer
  CHECK_EQ(h.repo.db.sessions.size(), static_cast<std::size_t>(1));
}

TEST(statistics_draws_a_point_per_finished_session_and_leaves_the_open_one_out) {
  Harness h;
  h.trained("ses_00000001", h.clock.now - 2 * kWeek, 100, 5, 4);
  h.trained("ses_00000002", h.clock.now - kWeek, 105, 5, 4);
  h.startAt(h.clock.now, "ses_00000003");   // today's workout, still being logged into
  h.training.append(uid(), sid("ses_00000003"),
                   SetWrite{setId("set_99999999"), ExerciseId{"back-squat"}, 110, 5,
                            SetKind::working, std::nullopt, "", h.clock.now + 60'000});

  Statistics answer = h.training.statistics(uid());

  REQUIRE_EQ(answer.movements.size(), static_cast<std::size_t>(1));
  REQUIRE_EQ(answer.movements[0].points.size(), static_cast<std::size_t>(2));
  CHECK_EQ(answer.movements[0].points[0],
           (MovementPoint{h.clock.now - 2 * kWeek, 100, 5, 116.7}));
  CHECK_EQ(answer.movements[0].points[1], (MovementPoint{h.clock.now - kWeek, 105, 5, 122.5}));
  CHECK_EQ(answer.movements[0].lastTrainedAtMs, h.clock.now - kWeek);
}

TEST(statistics_settles_a_session_the_four_hour_rule_already_ended) {
  Harness h;
  const std::uint64_t began = h.clock.now - 6 * 3'600'000;
  h.startAt(began, "ses_00000001");
  h.training.append(uid(), sid("ses_00000001"), h.bench("set_00000001", 82.5, began + 60'000));

  Statistics answer = h.training.statistics(uid());

  REQUIRE_EQ(h.repo.db.sessions.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.db.sessions[0].finishedAtMs, std::optional<std::uint64_t>(began + 60'000));
  REQUIRE_EQ(answer.movements.size(), static_cast<std::size_t>(1));
  CHECK_EQ(answer.movements[0].exercise, ExerciseId{"bench-press"});
}

TEST(statistics_never_reaches_another_accounts_log) {
  Harness h;
  h.repo.db.sessions.push_back(Session{sid("ses_00000002"), uid("u2"), h.clock.now - kWeek,
                                    h.clock.now - kWeek + 3'600'000});
  h.repo.db.sets.push_back(Set{setId("set_00000002"), sid("ses_00000002"), ExerciseId{"back-squat"}, 1,
                            200, 5, SetKind::working, std::nullopt, "", h.clock.now - kWeek});

  Statistics answer = h.training.statistics(uid());

  CHECK_EQ(answer.movements.size(), static_cast<std::size_t>(0));
  CHECK_EQ(answer.weeks.size(), static_cast<std::size_t>(0));
}

TEST(export_carries_every_set_the_account_holds_including_the_open_session) {
  Harness h;
  h.trained("ses_00000001", h.clock.now - kWeek, 100, 5, 2);
  h.startAt(h.clock.now, "ses_00000002");
  h.training.append(uid(), sid("ses_00000002"),
                   SetWrite{setId("set_99999999"), ExerciseId{"bench-press"}, 82.5, 8,
                            SetKind::warmup, 8.5, "felt light", h.clock.now + 60'000});

  std::vector<ExportedSet> rows = h.training.exportedSets(uid());

  REQUIRE_EQ(rows.size(), static_cast<std::size_t>(3));
  CHECK_EQ(rows[0].sessionId, "ses_00000001");
  CHECK_EQ(rows[0].exerciseId, "back-squat");
  CHECK_EQ(rows[0].exerciseName, "Back Squat");
  CHECK_EQ(rows[0].setNumber, "1");
  CHECK_EQ(rows[0].weightKg, "100.00");
  CHECK_EQ(rows[0].reps, "5");
  CHECK_EQ(rows[0].kind, "working");
  CHECK_EQ(rows[0].rpe, "");
  CHECK_EQ(rows[0].note, "");
  CHECK_EQ(rows[2].sessionId, "ses_00000002");
  CHECK_EQ(rows[2].exerciseName, "Bench Press");
  CHECK_EQ(rows[2].kind, "warmup");
  CHECK_EQ(rows[2].rpe, "8.5");
  CHECK_EQ(rows[2].note, "felt light");
  CHECK_EQ(rows[2].finishedAt, "");   // the workout still running has no end to name yet
}

TEST(export_settles_nothing_and_leaves_an_abandoned_session_open) {
  Harness h;
  const std::uint64_t began = h.clock.now - 6 * 3'600'000;
  h.startAt(began, "ses_00000001");
  h.training.append(uid(), sid("ses_00000001"), h.bench("set_00000001", 82.5, began + 60'000));

  CHECK_EQ(h.training.exportedSets(uid()).size(), static_cast<std::size_t>(1));

  CHECK_FALSE(h.repo.db.sessions[0].finishedAtMs);
}

TEST(export_never_reaches_another_accounts_sets) {
  Harness h;
  h.repo.db.sessions.push_back(Session{sid("ses_00000002"), uid("u2"), h.clock.now, h.clock.now + 1});
  h.repo.db.sets.push_back(Set{setId("set_00000002"), sid("ses_00000002"), ExerciseId{"back-squat"}, 1,
                            200, 5, SetKind::working, std::nullopt, "", h.clock.now});

  CHECK_EQ(h.training.exportedSets(uid()).size(), static_cast<std::size_t>(0));
}

TEST(share_is_idempotent_on_the_session) {
  Harness h;
  h.trained("ses_00000001", h.clock.now - kWeek, 100, 5, 4);

  std::optional<SessionShare> first = h.training.share(uid(), sid("ses_00000001"));
  std::optional<SessionShare> again = h.training.share(uid(), sid("ses_00000001"));

  REQUIRE(first);
  REQUIRE(again);
  CHECK_EQ(first->token, again->token);   // one link, not two capabilities to revoke separately
  CHECK_EQ(first->expiresAtMs, h.clock.now + kShareLifetimeMs);
  CHECK_EQ(h.repo.db.shares.size(), static_cast<std::size_t>(1));
}

TEST(share_of_an_absent_or_another_accounts_session_is_one_answer) {
  Harness h;
  h.repo.db.sessions.push_back(Session{sid("ses_00000002"), uid("u2"), h.clock.now, h.clock.now + 1});

  CHECK_FALSE(h.training.share(uid(), sid("ses_00000009")));
  CHECK_FALSE(h.training.share(uid(), sid("ses_00000002")));
  CHECK(h.repo.db.shares.empty());
}

TEST(share_that_has_already_expired_is_replaced_rather_than_returned) {
  Harness h;
  h.trained("ses_00000001", h.clock.now - kWeek, 100, 5, 4);
  std::optional<SessionShare> first = h.training.share(uid(), sid("ses_00000001"));
  REQUIRE(first);
  h.clock.now += kShareLifetimeMs + 1;

  std::optional<SessionShare> minted = h.training.share(uid(), sid("ses_00000001"));

  REQUIRE(minted);
  CHECK(minted->token != first->token);
  CHECK_EQ(h.repo.db.shares.size(), static_cast<std::size_t>(1));
  CHECK_FALSE(h.training.shared(first->token));
}

TEST(shared_session_resolves_a_live_token_and_names_no_account) {
  Harness h;
  h.trained("ses_00000001", h.clock.now - kWeek, 100, 5, 4);
  std::optional<SessionShare> minted = h.training.share(uid(), sid("ses_00000001"));
  REQUIRE(minted);

  std::optional<SharedSession> read = h.training.shared(minted->token);

  REQUIRE(read);
  CHECK_EQ(read->startedAtMs, h.clock.now - kWeek);
  CHECK_EQ(read->finishedAtMs,
           std::optional<std::uint64_t>(h.clock.now - kWeek + 3'600'000));
  CHECK_EQ(read->routineName, "");   // the session was ad-hoc, and an absence is not a blank name
  REQUIRE_EQ(read->sets.size(), static_cast<std::size_t>(4));
  CHECK_EQ(read->sets[0], (SharedSet{"Back Squat", 1, 100, 5, SetKind::working, std::nullopt, "",
                                     h.clock.now - kWeek + 60'000}));
}

TEST(shared_session_of_a_revoked_or_unknown_token_is_the_same_nothing) {
  Harness h;
  h.trained("ses_00000001", h.clock.now - kWeek, 100, 5, 4);
  std::optional<SessionShare> minted = h.training.share(uid(), sid("ses_00000001"));
  REQUIRE(minted);
  CHECK(h.training.shared(minted->token));

  CHECK(h.training.revokeShare(uid(), sid("ses_00000001")));

  CHECK_FALSE(h.training.shared(minted->token));
  CHECK_FALSE(h.training.shared("a token nobody ever minted"));
  CHECK_FALSE(h.training.revokeShare(uid(), sid("ses_00000001")));   // nothing left to revoke
  CHECK(h.repo.db.shares.empty());
}

// The end is not inclusive: at the instant it names, the link is already gone.
TEST(shared_session_stops_answering_the_moment_the_share_expires) {
  Harness h;
  h.trained("ses_00000001", h.clock.now - kWeek, 100, 5, 4);
  std::optional<SessionShare> minted = h.training.share(uid(), sid("ses_00000001"));
  REQUIRE(minted);

  h.clock.now = minted->expiresAtMs;

  CHECK_FALSE(h.training.shared(minted->token));
}

// A stranger holding a link may never write to the owner's log, not even the four-hour close.
TEST(shared_session_never_settles_the_owners_open_session) {
  Harness h;
  const std::uint64_t began = h.clock.now - 6 * 3'600'000;
  h.stored("ses_00000001", began, std::nullopt, 100, 5, 2);
  std::optional<SessionShare> minted = h.training.share(uid(), sid("ses_00000001"));
  REQUIRE(minted);

  CHECK(h.training.shared(minted->token));

  CHECK_FALSE(h.repo.db.sessions[0].finishedAtMs);
}

TEST(revoke_never_reaches_another_accounts_share) {
  Harness h;
  h.repo.db.sessions.push_back(Session{sid("ses_00000002"), uid("u2"), h.clock.now, h.clock.now + 1});
  h.repo.db.shares.push_back(
      SessionShare{sid("ses_00000002"), uid("u2"), "theirs", h.clock.now + kShareLifetimeMs});

  CHECK_FALSE(h.training.revokeShare(uid(), sid("ses_00000002")));

  CHECK_EQ(h.repo.db.shares.size(), static_cast<std::size_t>(1));
  CHECK(h.training.shared("theirs"));   // and it is still live for the account that minted it
}

TEST(the_log_marks_the_rows_where_a_record_happened) {
  Harness h;
  h.trained("ses_00000001", h.clock.now, 100, 5, 4);
  h.trained("ses_00000002", h.clock.now + kWeek, 105, 5, 4);
  h.trained("ses_00000003", h.clock.now + 2 * kWeek, 105, 5, 4);

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 3 * kWeek);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(3));
  CHECK_EQ(listed[0].summary.session.id, sid("ses_00000003"));
  CHECK_FALSE(listed[0].record);
  CHECK(listed[1].record);
  CHECK_FALSE(listed[2].record);
}

TEST(the_dot_survives_a_page_edge_because_the_marks_before_the_page_travel_with_it) {
  Harness h;
  h.trained("ses_00000001", h.clock.now, 100, 5, 4);
  h.trained("ses_00000002", h.clock.now + kWeek, 105, 5, 4);

  std::vector<LogRow> whole = h.logBefore(h.clock.now + 2 * kWeek);
  std::vector<LogRow> newest = h.logBefore(h.clock.now + 2 * kWeek, 1);

  REQUIRE_EQ(whole.size(), static_cast<std::size_t>(2));
  REQUIRE_EQ(newest.size(), static_cast<std::size_t>(1));
  CHECK(whole[0].record);
  CHECK_EQ(newest[0].summary.session.id, sid("ses_00000002"));
  CHECK(newest[0].record);
}

// The page carries an OPEN workout as a row; the standing marks count FINISHED sessions alone.
TEST(a_still_open_workout_on_the_page_never_stands_under_the_row_above_it) {
  Harness h;
  h.stored("ses_00000001", h.clock.now, h.clock.now + 3'600'000, 100, 5, 4);
  h.stored("ses_00000002", h.clock.now + kWeek, std::nullopt, 110, 5, 4);   // never finished
  h.stored("ses_00000003", h.clock.now + 2 * kWeek, h.clock.now + 2 * kWeek + 3'600'000, 105, 5, 4);

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 3 * kWeek);
  std::optional<Review> finish = h.training.review(uid(), sid("ses_00000003"));

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(3));
  REQUIRE(finish.has_value());
  CHECK_EQ(listed[0].summary.session.id, sid("ses_00000003"));
  CHECK_EQ(listed[0].record, finish->record.has_value());   // the row and the screen, one judgement
  CHECK(listed[0].record);
  CHECK_EQ(listed[1].summary.session.id, sid("ses_00000002"));
  CHECK(listed[1].record);
  CHECK_FALSE(listed[2].record);
}

TEST(a_slight_session_gets_no_dot_however_heavy_it_was) {
  Harness h;
  h.trained("ses_00000001", h.clock.now, 100, 5, 4);
  h.trained("ses_00000002", h.clock.now + kWeek, 140, 5, kSlightWorkingSets - 1);

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 2 * kWeek);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(2));
  CHECK_EQ(listed[0].summary.session.id, sid("ses_00000002"));
  CHECK_FALSE(listed[0].record);
}

TEST(a_movements_record_answers_the_whole_page_from_one_read) {
  Harness h;
  h.create(h.pushAWrite({RoutineEntry{1, ExerciseId{"back-squat"}, 5, 5, 100.0, 180}}));
  h.trained("ses_00000001", h.clock.now, 100, 5, 4);
  h.trained("ses_00000002", h.clock.now + kWeek, 105, 5, 4);
  h.catalog.renameExercise(uid(), ExerciseId{"back-squat"}, "Low-bar Squat");

  std::optional<MovementRecord> page = h.training.movementRecord(uid(), ExerciseId{"back-squat"});

  REQUIRE(page.has_value());
  CHECK_EQ(page->exercise.name, std::string("Low-bar Squat"));
  CHECK_EQ(page->routines, std::vector<std::string>{"Push A"});
  CHECK_EQ(page->sessions, 2);
  REQUIRE(page->bestE1rm.has_value());
  CHECK_EQ(*page->bestE1rm, (Best{105, 5, h.clock.now + kWeek, e1rm(105, 5)}));
  REQUIRE_EQ(page->records.size(), static_cast<std::size_t>(1));
  CHECK_EQ(page->records[0], (RecordPoint{h.clock.now + kWeek, 105, 5, *e1rm(105, 5)}));
  REQUIRE_EQ(page->recent.size(), static_cast<std::size_t>(2));
  CHECK_EQ(page->recent[0].session, sid("ses_00000002"));
  CHECK_EQ(page->recent[0].sets.size(), static_cast<std::size_t>(4));
}

TEST(a_record_of_a_movement_never_lifted_is_empty_and_of_an_unknown_one_is_absent) {
  Harness h;

  std::optional<MovementRecord> page = h.training.movementRecord(uid(), ExerciseId{"bench-press"});

  REQUIRE(page.has_value());
  CHECK_EQ(page->sessions, 0);
  CHECK(page->routines.empty());
  CHECK_EQ(page->bestE1rm, std::nullopt);
  CHECK(page->series.empty());
  CHECK_EQ(h.training.movementRecord(uid(), ExerciseId{"no-such"}), std::nullopt);
}

TEST(a_fix_rewrites_the_stored_set_and_keeps_the_version_it_replaced) {
  Harness h;
  h.startAt(h.clock.now);
  h.training.append(uid(), sid(), h.bench("set_00000001", 82.5, h.clock.now + 60'000));
  SetFix fix;
  fix.weightKg = 80.0;
  fix.reps = 5;

  std::optional<Set> fixed = h.training.fixSet(uid(), sid(), setId("set_00000001"), fix);

  REQUIRE(fixed.has_value());
  CHECK_EQ(*fixed, Set(setId("set_00000001"), sid(), ExerciseId{"bench-press"}, 1, 80.0, 5,
                       SetKind::working, std::nullopt, "", h.clock.now + 60'000));
  CHECK_EQ(h.repo.db.sets, std::vector<Set>{*fixed});
  REQUIRE_EQ(h.repo.db.kept.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.db.kept[0],
           (FakeGymStore::KeptSet{
               Set{setId("set_00000001"), sid(), ExerciseId{"bench-press"}, 1, 82.5, 8,
                   SetKind::working, std::nullopt, "", h.clock.now + 60'000},
               false}));
}

// A correction assigns absolute values, so sending it again is sending the same values again.
TEST(a_replayed_fix_answers_the_same_row) {
  Harness h;
  h.startAt(h.clock.now);
  h.training.append(uid(), sid(), h.bench("set_00000001", 82.5, h.clock.now + 60'000));
  SetFix fix;
  fix.weightKg = 80.0;

  std::optional<Set> first = h.training.fixSet(uid(), sid(), setId("set_00000001"), fix);
  std::optional<Set> replayed = h.training.fixSet(uid(), sid(), setId("set_00000001"), fix);

  CHECK_EQ(first, replayed);
  CHECK_EQ(h.repo.db.sets.size(), static_cast<std::size_t>(1));
}

TEST(a_fix_reaches_no_set_outside_the_workout_the_path_names) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.training.append(uid(), sid("ses_00000001"), h.bench("set_00000001", 82.5, h.clock.now + 60'000));
  h.training.finish(uid(), sid("ses_00000001"), h.clock.now + 3'600'000);
  h.startAt(h.clock.now + 4'000'000, "ses_00000002");
  h.repo.db.sessions.push_back(Session{sid("ses_00000009"), uid("u2"), h.clock.now});
  h.repo.db.sets.push_back(Set{setId("set_00000009"), sid("ses_00000009"), ExerciseId{"bench-press"},
                            1, 100.0, 3, SetKind::working, std::nullopt, "", h.clock.now});
  SetFix fix;
  fix.weightKg = 60.0;

  CHECK_EQ(h.training.fixSet(uid(), sid("ses_00000002"), setId("set_00000001"), fix), std::nullopt);
  CHECK_EQ(h.training.fixSet(uid(), sid("ses_00000001"), setId("set_99999999"), fix), std::nullopt);
  CHECK_EQ(h.training.fixSet(uid(), sid("ses_00000009"), setId("set_00000009"), fix), std::nullopt);
  CHECK_EQ(h.repo.db.sets[0].weightKg, 82.5);
  CHECK_EQ(h.repo.db.sets[1].weightKg, 100.0);
  CHECK(h.repo.db.kept.empty());
}

TEST(a_finished_workout_is_still_correctable) {
  Harness h;
  h.startAt(h.clock.now);
  h.training.append(uid(), sid(), h.bench("set_00000001", 82.5, h.clock.now + 60'000));
  h.training.finish(uid(), sid(), h.clock.now + 3'600'000);
  SetFix fix;
  fix.reps = 5;

  std::optional<Set> fixed = h.training.fixSet(uid(), sid(), setId("set_00000001"), fix);

  REQUIRE(fixed.has_value());
  CHECK_EQ(fixed->reps, 5);
}

// The set leaves the live log and moves whole into the kept rows, marked; nothing offers it back.
TEST(a_deleted_set_leaves_the_log_and_is_kept_marked_deleted) {
  Harness h;
  h.startAt(h.clock.now);
  h.training.append(uid(), sid(), h.bench("set_00000001", 82.5, h.clock.now + 60'000));
  h.training.append(uid(), sid(), h.bench("set_00000002", 85.0, h.clock.now + 120'000));

  h.training.deleteSet(uid(), sid(), setId("set_00000001"));

  REQUIRE_EQ(h.repo.db.sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.db.sets[0].id, setId("set_00000002"));
  REQUIRE_EQ(h.repo.db.kept.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.db.kept[0],
           (FakeGymStore::KeptSet{
               Set{setId("set_00000001"), sid(), ExerciseId{"bench-press"}, 1, 82.5, 8,
                   SetKind::working, std::nullopt, "", h.clock.now + 60'000},
               true}));
}

TEST(deleting_a_set_twice_is_the_same_silence_and_reaches_nobody_elses) {
  Harness h;
  h.startAt(h.clock.now);
  h.training.append(uid(), sid(), h.bench("set_00000001", 82.5, h.clock.now + 60'000));
  h.repo.db.sessions.push_back(Session{sid("ses_00000009"), uid("u2"), h.clock.now});
  h.repo.db.sets.push_back(Set{setId("set_00000009"), sid("ses_00000009"), ExerciseId{"bench-press"},
                            1, 100.0, 3, SetKind::working, std::nullopt, "", h.clock.now});

  h.training.deleteSet(uid(), sid(), setId("set_00000001"));
  h.training.deleteSet(uid(), sid(), setId("set_00000001"));
  h.training.deleteSet(uid(), sid("ses_00000009"), setId("set_00000009"));

  CHECK_EQ(h.repo.db.sets, std::vector<Set>{Set(setId("set_00000009"), sid("ses_00000009"),
                                             ExerciseId{"bench-press"}, 1, 100.0, 3,
                                             SetKind::working, std::nullopt, "", h.clock.now)});
  CHECK_EQ(h.repo.db.kept.size(), static_cast<std::size_t>(1));
}

// `setOf` reads the rows that STAND, so a replayed append of a deleted set answers `deleted`, never `idTaken`.
TEST(a_deleted_set_is_never_logged_again_by_the_queue_that_replays_it) {
  Harness h;
  h.startAt(h.clock.now);
  h.training.append(uid(), sid(), h.bench("set_00000001", 80.0, h.clock.now + 60'000));
  h.training.append(uid(), sid(), h.bench("set_00000002", 82.5, h.clock.now + 120'000));
  h.training.deleteSet(uid(), sid(), setId("set_00000002"));

  AppendOutcome replayed =
      h.training.append(uid(), sid(), h.bench("set_00000002", 82.5, h.clock.now + 120'000));

  CHECK_EQ(replayed.set, std::optional<Set>());
  CHECK(replayed.error == AppendError::deleted);
  CHECK_EQ(h.repo.db.sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.db.sets[0].id, setId("set_00000001"));
  CHECK_EQ(h.repo.db.kept.size(), static_cast<std::size_t>(1));
  h.training.finish(uid(), sid(), h.clock.now + 300'000);
  CHECK(h.training.append(uid(), sid(), h.bench("set_00000002", 82.5, h.clock.now + 120'000)).error ==
        AppendError::deleted);
  CHECK_EQ(h.repo.db.sets.size(), static_cast<std::size_t>(1));
}

// A correction that moved nothing keeps nothing: `{}` is a legal fix and stores no version.
TEST(a_fix_that_changes_nothing_answers_the_row_and_keeps_no_version_of_it) {
  Harness h;
  h.startAt(h.clock.now);
  h.training.append(uid(), sid(), h.bench("set_00000001", 82.5, h.clock.now + 60'000));

  for (int retry = 0; retry < 4; ++retry) {
    std::optional<Set> answered = h.training.fixSet(uid(), sid(), setId("set_00000001"), SetFix{});
    REQUIRE(answered.has_value());
    CHECK_EQ(answered->weightKg, 82.5);
  }
  CHECK_EQ(h.repo.db.kept.size(), static_cast<std::size_t>(0));

  SetFix moves;
  moves.weightKg = 90.0;
  h.training.fixSet(uid(), sid(), setId("set_00000001"), moves);
  REQUIRE_EQ(h.repo.db.kept.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.db.kept[0].set.weightKg, 82.5);
  CHECK_FALSE(h.repo.db.kept[0].deleted);
}

// Numbers are not closed up behind a delete: deleting set 2 of 3 leaves 1 and 3, and the next set is 4.
TEST(a_delete_leaves_the_numbers_alone_and_the_next_set_never_reuses_one) {
  Harness h;
  h.startAt(h.clock.now);
  h.training.append(uid(), sid(), h.bench("set_00000001", 80.0, h.clock.now + 60'000));
  h.training.append(uid(), sid(), h.bench("set_00000002", 82.5, h.clock.now + 120'000));
  h.training.append(uid(), sid(), h.bench("set_00000003", 85.0, h.clock.now + 180'000));

  h.training.deleteSet(uid(), sid(), setId("set_00000002"));
  AppendOutcome next = h.training.append(uid(), sid(), h.bench("set_00000004", 87.5,
                                                              h.clock.now + 240'000));

  REQUIRE(next.set.has_value());
  CHECK_EQ(next.set->setNumber, 4);
  std::vector<int> numbers;
  for (const Set& set : h.repo.db.sets) numbers.push_back(set.setNumber);
  CHECK_EQ(numbers, (std::vector<int>{1, 3, 4}));
}

TEST(fixing_and_deleting_a_set_never_touch_the_frozen_plan_or_the_routine) {
  Harness h;
  h.create(h.pushAWrite());
  h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  h.training.append(uid(), sid(), h.bench("set_00000001", 82.5, h.clock.now + 60'000));
  h.training.append(uid(), sid(), h.bench("set_00000002", 82.5, h.clock.now + 120'000));
  const std::optional<PlanSnapshot> frozen = h.repo.db.sessions[0].plan;
  const std::vector<RoutineEntry> planned = h.repo.db.routineRows[0].entries;
  REQUIRE(frozen.has_value());

  SetFix fix;
  fix.weightKg = 60.0;
  fix.reps = 3;
  h.training.fixSet(uid(), sid(), setId("set_00000001"), fix);
  h.training.deleteSet(uid(), sid(), setId("set_00000002"));

  CHECK_EQ(h.repo.db.sessions[0].plan, frozen);
  CHECK_EQ(*h.repo.db.sessions[0].plan,
           (PlanSnapshot{"Push A", {PlanEntry{ExerciseId{"bench-press"}, 5, 5, 82.5, 180}}}));
  CHECK_EQ(h.repo.db.routineRows[0].entries, planned);
  CHECK_EQ(h.repo.db.routineRows[0].name, std::string("Push A"));
  CHECK_EQ(h.repo.db.sessions[0].routine, std::optional<RoutineId>(rtId()));
}

TEST(a_correction_moves_the_record_and_every_read_that_stands_on_it) {
  Harness h;
  const std::uint64_t week0 = h.clock.now;
  h.trained("ses_00000001", week0, 100, 5, 4);
  h.clock.now = week0 + kWeek;  // a week on, the second squat day starts under a clock that agrees
  h.training.start(uid(), SessionStart{sid("ses_00000002"), h.clock.now});
  h.clock.now = week0;
  for (int number = 1; number <= 3; ++number)
    h.training.append(uid(), sid("ses_00000002"),
                     SetWrite{setId("set_0000002" + std::to_string(number)),
                              ExerciseId{"back-squat"}, 100, 5, SetKind::working, std::nullopt, "",
                              h.clock.now + kWeek + number * 60'000});
  h.training.append(uid(), sid("ses_00000002"),
                   SetWrite{setId("set_00000024"), ExerciseId{"back-squat"}, 120, 5,
                            SetKind::working, std::nullopt, "", h.clock.now + kWeek + 240'000});
  h.training.finish(uid(), sid("ses_00000002"), h.clock.now + kWeek + 3'600'000);
  REQUIRE(h.training.review(uid(), sid("ses_00000002"))->record.has_value());   // 120 kg, the PR
  SetFix fix;
  fix.weightKg = 90.0;

  std::optional<Set> fixed =
      h.training.fixSet(uid(), sid("ses_00000002"), setId("set_00000024"), fix);

  REQUIRE(fixed.has_value());
  // the session itself
  CHECK_EQ(h.training.detail(uid(), sid("ses_00000002"))->sets[3].weightKg, 90.0);
  // the finish readout
  std::optional<Review> review = h.training.review(uid(), sid("ses_00000002"));
  REQUIRE(review.has_value());
  CHECK_EQ(review->record, std::nullopt);
  CHECK_EQ(review->stats.topE1rm, e1rm(100, 5));
  // the log's row and its gold dot
  std::vector<LogRow> rows = h.logBefore(h.clock.now + 10 * kWeek);
  REQUIRE_EQ(rows.size(), static_cast<std::size_t>(2));
  CHECK_EQ(rows[0].summary.session.id, sid("ses_00000002"));
  CHECK_EQ(rows[0].summary.topSet, std::optional<TopWorkingSet>(TopWorkingSet{100.0, 5}));
  CHECK_EQ(rows[0].summary.tonnageKg, 1950.0);
  CHECK_EQ(rows[0].topE1rm, e1rm(100, 5));
  CHECK_FALSE(rows[0].record);
  // the record page
  std::optional<MovementRecord> page = h.training.movementRecord(uid(), ExerciseId{"back-squat"});
  REQUIRE(page.has_value());
  CHECK_EQ(page->heaviest, std::optional<Best>(Best{100, 5, h.clock.now, e1rm(100, 5)}));
  CHECK_EQ(page->bestE1rm, std::optional<Best>(Best{100, 5, h.clock.now, e1rm(100, 5)}));
  // the statistics engine
  Statistics stats = h.training.statistics(uid());
  REQUIRE_EQ(stats.movements.size(), static_cast<std::size_t>(1));
  CHECK_EQ(stats.movements[0].heaviest,
           std::optional<Best>(Best{100, 5, h.clock.now, e1rm(100, 5)}));
  // the prefill the logger puts on screen before a lifter touches anything
  LastTimeOutcome prefill = h.training.lastTime(uid(), ExerciseId{"back-squat"});
  REQUIRE(prefill.lastTime.has_value());
  CHECK_EQ(prefill.lastTime->sets[3].weightKg, 90.0);
  // and the file a lifter walks away with
  std::vector<ExportedSet> exported = h.training.exportedSets(uid());
  REQUIRE_EQ(exported.size(), static_cast<std::size_t>(8));
  CHECK_EQ(exported[7].weightKg, std::string("90.00"));
}

TEST(a_deleted_set_is_gone_from_the_log_the_review_and_the_export) {
  Harness h;
  h.trained("ses_00000001", h.clock.now, 100, 5, 3);

  h.training.deleteSet(uid(), sid("ses_00000001"), setId("set_000000012"));

  std::vector<LogRow> rows = h.logBefore(h.clock.now + kWeek);
  REQUIRE_EQ(rows.size(), static_cast<std::size_t>(1));
  CHECK_EQ(rows[0].summary.setCount, 2);
  CHECK_EQ(rows[0].summary.workingSetCount, 2);
  CHECK_EQ(rows[0].summary.tonnageKg, 1000.0);
  CHECK_EQ(h.training.review(uid(), sid("ses_00000001"))->stats.workingSets, 2);
  CHECK_EQ(h.training.detail(uid(), sid("ses_00000001"))->sets.size(),
           static_cast<std::size_t>(2));
  CHECK_EQ(h.training.exportedSets(uid()).size(), static_cast<std::size_t>(2));
}

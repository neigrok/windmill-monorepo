#include "products/gym/application/LogService.h"

#include "test/platform/Fakes.h"
#include "test/products/gym/Fakes.h"
#include "test/testing.h"

#include <optional>
#include <string>
#include <vector>

using namespace wm::gym;
using namespace wm::gym::fake;

namespace {
// One repo, one hand-driven clock, both seeds — every test starts here and perturbs one thing.
struct Harness {
  FakeTrainingRepository repo;
  wm::fake::FakeClock clock;
  LogService service{repo, clock};

  Harness() {
    repo.seed(benchPress());
    repo.seed(backSquat());
  }

  StartOutcome startAt(std::uint64_t ms, std::string id = "ses_00000001") {
    return service.start(uid(), SessionStart{sid(std::move(id)), ms});
  }

  // The other Start: "create exactly this session, which is not now" — backfill and lift-import.
  StartOutcome startExactly(std::uint64_t ms, std::string id) {
    return service.start(uid(), SessionStart{sid(std::move(id)), ms, false});
  }

  SetWrite bench(std::string id, double weightKg, std::uint64_t completedAtMs) {
    return SetWrite{setId(std::move(id)), ExerciseId{"bench-press"}, weightKg, 8,
                    SetKind::working, std::nullopt, "", completedAtMs};
  }

  std::vector<SessionSummary> logBefore(std::uint64_t beforeMs, int limit = 50) {
    return service.log(uid(), LogCursor{beforeMs, std::nullopt, limit});
  }
};
}

// ---- start: idempotent by construction ----------------------------------------------------

TEST(start_stores_and_returns_the_fresh_session) {
  Harness h;

  StartOutcome started = h.startAt(h.clock.now);

  CHECK(started.error == StartError::none);
  CHECK_EQ(*started.session, Session(sid(), uid(), h.clock.now));
  CHECK_EQ(h.repo.sessions, std::vector<Session>{Session(sid(), uid(), h.clock.now)});
}

TEST(start_replay_converges_on_the_same_session) {
  Harness h;
  StartOutcome first = h.startAt(h.clock.now);

  StartOutcome replayed = h.startAt(h.clock.now);

  CHECK(replayed.error == StartError::none);
  CHECK_EQ(*replayed.session, *first.session);
  CHECK_EQ(h.repo.sessions.size(), static_cast<std::size_t>(1));
}

TEST(start_double_tap_with_two_ids_joins_the_first_taps_session) {
  Harness h;
  StartOutcome first = h.startAt(h.clock.now, "ses_00000001");

  StartOutcome second = h.startAt(h.clock.now + 5, "ses_00000002");   // the one-open index refuses it

  CHECK(second.error == StartError::none);
  CHECK_EQ(*second.session, *first.session);
  CHECK_EQ(h.repo.sessions.size(), static_cast<std::size_t>(1));
}

TEST(start_refuses_a_session_id_that_belongs_to_another_account) {
  Harness h;
  h.repo.sessions.push_back(Session{sid(), uid("u2"), h.clock.now - 5'000});   // another lifter's

  StartOutcome started = h.startAt(h.clock.now);

  CHECK(started.error == StartError::idTaken);
  CHECK_FALSE(started.session.has_value());
  CHECK_EQ(h.repo.sessions, std::vector<Session>{Session(sid(), uid("u2"), h.clock.now - 5'000)});
  CHECK_EQ(h.service.detail(uid(), sid()), std::optional<SessionDetail>());
}

TEST(start_replay_of_an_already_finished_start_returns_the_stored_session) {
  Harness h;
  h.startAt(h.clock.now);
  h.service.finish(uid(), sid(), h.clock.now + 1'000);

  StartOutcome replayed = h.startAt(h.clock.now);

  CHECK(replayed.error == StartError::none);
  CHECK_EQ(*replayed.session,
           Session(sid(), uid(), h.clock.now, std::optional<std::uint64_t>(h.clock.now + 1'000)));
  CHECK_EQ(h.repo.sessions.size(), static_cast<std::size_t>(1));
}

TEST(start_auto_closes_a_stale_setless_session_at_its_start_instant) {
  Harness h;
  const std::uint64_t firstStart = h.clock.now;
  h.startAt(firstStart, "ses_00000001");
  h.clock.now += kAutoCloseMs;

  StartOutcome second = h.startAt(h.clock.now, "ses_00000002");

  CHECK_EQ(second.session->id, sid("ses_00000002"));
  CHECK_EQ(h.repo.sessions.size(), static_cast<std::size_t>(2));
  CHECK_EQ(h.repo.sessions[0].finishedAtMs, std::optional<std::uint64_t>(firstStart));
}

TEST(start_auto_closes_a_stale_session_at_its_last_set_instant) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  const std::uint64_t lastSetAt = h.clock.now + 60'000;
  h.service.append(uid(), sid(), h.bench("set_00000001", 80.0, lastSetAt));
  h.clock.now = lastSetAt + kAutoCloseMs;

  h.startAt(h.clock.now, "ses_00000002");

  CHECK_EQ(h.repo.sessions[0].finishedAtMs, std::optional<std::uint64_t>(lastSetAt));
}

TEST(start_leaves_a_live_open_session_alone_and_joins_it) {
  Harness h;
  StartOutcome first = h.startAt(h.clock.now, "ses_00000001");
  h.clock.now += kAutoCloseMs - 1;   // one ms shy of stale

  StartOutcome second = h.startAt(h.clock.now, "ses_00000002");

  CHECK_EQ(*second.session, *first.session);
  CHECK_EQ(h.repo.sessions[0].finishedAtMs, std::optional<std::uint64_t>());
}

// The corruption this refusal exists for: without it the insert no-ops on the one-open index, the
// live session comes back with a 200, and the caller appends a past workout's sets into today's.
TEST(start_that_will_not_join_is_refused_while_another_session_is_open) {
  Harness h;
  StartOutcome live = h.startAt(h.clock.now, "ses_00000001");

  StartOutcome backfill = h.startExactly(h.clock.now - kAutoCloseMs, "ses_00000002");

  CHECK(backfill.error == StartError::alreadyOpen);
  CHECK(!backfill.session.has_value());
  // The refusal touches nothing: the live session is still the only row, and still open.
  CHECK_EQ(h.repo.sessions, std::vector<Session>{*live.session});
  CHECK_EQ(h.repo.sessions[0].finishedAtMs, std::optional<std::uint64_t>());
}

TEST(start_that_will_not_join_stores_the_session_it_named_when_nothing_is_open) {
  Harness h;
  std::uint64_t yesterday = h.clock.now - kAutoCloseMs;

  StartOutcome backfill = h.startExactly(yesterday, "ses_00000002");

  CHECK(backfill.error == StartError::none);
  CHECK_EQ(*backfill.session, Session(sid("ses_00000002"), uid(), yesterday));
}

// The subtle one: declining the join must not decline a caller's own replay. A backfill that lost
// its reply and sent the same body again names the session that IS open, so it answers with itself.
TEST(start_that_will_not_join_still_replays_its_own_open_session) {
  Harness h;
  // Minutes ago, not hours: a start instant a full auto-close window old is stale on arrival, and
  // the settle in the second call would close it — a true reply, but a different question.
  std::uint64_t justBefore = h.clock.now - 60'000;
  StartOutcome first = h.startExactly(justBefore, "ses_00000002");

  StartOutcome replayed = h.startExactly(justBefore, "ses_00000002");

  CHECK(replayed.error == StartError::none);
  CHECK_EQ(*replayed.session, *first.session);
  CHECK_EQ(h.repo.sessions.size(), static_cast<std::size_t>(1));
}

// ---- append: the durable set write --------------------------------------------------------

TEST(append_to_a_missing_session_is_not_found) {
  Harness h;

  AppendOutcome outcome = h.service.append(uid(), sid(), h.bench("set_00000001", 80.0, 1'000));

  CHECK(outcome.error == AppendError::notFound);
  CHECK_FALSE(outcome.set.has_value());
  CHECK(h.repo.sets.empty());
}

TEST(append_to_anothers_session_is_the_same_not_found) {
  Harness h;
  h.startAt(h.clock.now);

  AppendOutcome outcome =
      h.service.append(uid("u2"), sid(), h.bench("set_00000001", 80.0, h.clock.now));

  CHECK(outcome.error == AppendError::notFound);
  CHECK(h.repo.sets.empty());
}

TEST(append_of_a_new_set_to_a_finished_session_is_finished) {
  Harness h;
  h.startAt(h.clock.now);
  h.service.finish(uid(), sid(), h.clock.now + 1'000);

  AppendOutcome outcome =
      h.service.append(uid(), sid(), h.bench("set_00000001", 80.0, h.clock.now));

  CHECK(outcome.error == AppendError::finished);
  CHECK_FALSE(outcome.set.has_value());
  CHECK(h.repo.sets.empty());
}

// The flush queue treats 409 as terminal and drops the write, so a set that is ALREADY durable
// must never answer 409 — whatever happened to the session while the device was offline.
TEST(append_replays_an_already_stored_set_across_the_finish_boundary) {
  Harness h;
  h.startAt(h.clock.now);
  AppendOutcome landed = h.service.append(uid(), sid(), h.bench("set_00000001", 80.0, h.clock.now + 1));
  h.service.finish(uid(), sid(), h.clock.now + 1'000);

  AppendOutcome replayed =
      h.service.append(uid(), sid(), h.bench("set_00000001", 80.0, h.clock.now + 1));

  CHECK(replayed.error == AppendError::none);
  CHECK_EQ(*replayed.set, *landed.set);
  CHECK_EQ(h.repo.sets.size(), static_cast<std::size_t>(1));
}

TEST(append_refuses_a_set_id_minted_by_another_account) {
  Harness h;
  h.repo.sessions.push_back(Session{sid("ses_00000002"), uid("u2"), h.clock.now});
  h.repo.sets.push_back(Set{setId("set_00000001"), sid("ses_00000002"), ExerciseId{"bench-press"},
                            1, 142.5, 3, SetKind::working, std::optional<double>(9.5),
                            "knee felt off, deload next week", h.clock.now});
  h.startAt(h.clock.now);

  AppendOutcome outcome =
      h.service.append(uid(), sid(), h.bench("set_00000001", 7.5, h.clock.now + 1));

  CHECK(outcome.error == AppendError::idTaken);
  CHECK_FALSE(outcome.set.has_value());   // never the stranger's row, not even to say it exists
  CHECK_EQ(h.repo.sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.sets[0].weightKg, 142.5);
  CHECK_EQ(h.service.detail(uid(), sid())->sets, std::vector<Set>{});
}

TEST(append_refuses_a_set_id_the_same_lifter_spent_in_another_session) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.service.append(uid(), sid("ses_00000001"), h.bench("set_00000001", 80.0, h.clock.now + 1));
  h.service.finish(uid(), sid("ses_00000001"), h.clock.now + 2);
  h.startAt(h.clock.now + 3, "ses_00000002");

  AppendOutcome outcome = h.service.append(
      uid(), sid("ses_00000002"),
      SetWrite{setId("set_00000001"), ExerciseId{"back-squat"}, 222.5, 9, SetKind::working,
               std::nullopt, "", h.clock.now + 4});

  CHECK(outcome.error == AppendError::idTaken);
  CHECK_FALSE(outcome.set.has_value());   // the old row is NOT reported as this write's result
  CHECK_EQ(h.repo.sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.service.detail(uid(), sid("ses_00000002"))->sets, std::vector<Set>{});
}

// Only the store knows the catalog, so the refusal is born there and travels as a value. The
// service passes it through untouched — it never inspects an exercise it would have to load.
TEST(append_of_a_movement_no_catalog_holds_is_unknown_exercise) {
  Harness h;
  h.startAt(h.clock.now);

  AppendOutcome outcome = h.service.append(
      uid(), sid(),
      SetWrite{setId("set_00000001"), ExerciseId{"zercher-squat"}, 100.0, 5, SetKind::working,
               std::nullopt, "", h.clock.now + 1});

  CHECK(outcome.error == AppendError::unknownExercise);
  CHECK_FALSE(outcome.set.has_value());
  CHECK(h.repo.sets.empty());
  CHECK_EQ(h.service.detail(uid(), sid())->sets, std::vector<Set>{});
}

TEST(append_numbers_max_plus_one_per_exercise_across_interleaving) {
  Harness h;
  h.startAt(h.clock.now);
  SetWrite squat{setId("set_00000002"), ExerciseId{"back-squat"}, 100.0, 5, SetKind::working,
                 std::nullopt, "", h.clock.now + 2};

  AppendOutcome bench1 = h.service.append(uid(), sid(), h.bench("set_00000001", 80.0, h.clock.now + 1));
  AppendOutcome squat1 = h.service.append(uid(), sid(), squat);
  AppendOutcome bench2 = h.service.append(uid(), sid(), h.bench("set_00000003", 82.5, h.clock.now + 3));

  CHECK_EQ(bench1.set->setNumber, 1);
  CHECK_EQ(squat1.set->setNumber, 1);   // its own count, not the session's
  CHECK_EQ(bench2.set->setNumber, 2);
}

TEST(append_replay_returns_the_stored_row_byte_for_byte) {
  Harness h;
  h.startAt(h.clock.now);
  AppendOutcome first = h.service.append(uid(), sid(), h.bench("set_00000001", 80.0, h.clock.now + 1));

  // The replay arrives with a different weight — the flush queue re-sending after a lost reply.
  AppendOutcome replayed =
      h.service.append(uid(), sid(), h.bench("set_00000001", 90.0, h.clock.now + 99));

  CHECK(replayed.error == AppendError::none);
  CHECK_EQ(*replayed.set, *first.set);
  CHECK_EQ(h.repo.sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.sets[0].weightKg, 80.0);
}

// ---- finish, log, detail, catalog ---------------------------------------------------------

TEST(finish_is_idempotent_and_keeps_the_first_instant) {
  Harness h;
  h.startAt(h.clock.now);

  FinishOutcome first = h.service.finish(uid(), sid(), h.clock.now + 1'000);
  FinishOutcome replayed = h.service.finish(uid(), sid(), h.clock.now + 2'000);

  CHECK(first.error == FinishError::none);
  CHECK_EQ(first.session->finishedAtMs, std::optional<std::uint64_t>(h.clock.now + 1'000));
  CHECK(replayed.error == FinishError::none);
  CHECK_EQ(*replayed.session, *first.session);

  FinishOutcome unknown = h.service.finish(uid(), SessionId{"ses_unknown1"}, h.clock.now + 1);
  CHECK(unknown.error == FinishError::notFound);
  CHECK_FALSE(unknown.session.has_value());
}

// close is first-writer-wins, so a nonsense instant would be the session's end FOREVER: refuse it
// while the session is still open and can be finished properly.
TEST(finish_refuses_an_instant_the_session_could_not_have_ended_at) {
  Harness h;
  const std::uint64_t started = h.clock.now;
  h.startAt(started);

  FinishOutcome zero = h.service.finish(uid(), sid(), 0);
  FinishOutcome beforeStart = h.service.finish(uid(), sid(), started - 1);
  FinishOutcome pastTheCeiling = h.service.finish(uid(), sid(), kMaxInstantMs + 1);

  CHECK(zero.error == FinishError::badInstant);
  CHECK(beforeStart.error == FinishError::badInstant);
  CHECK(pastTheCeiling.error == FinishError::badInstant);
  CHECK_FALSE(zero.session.has_value());
  CHECK_EQ(h.repo.sessions[0].finishedAtMs, std::optional<std::uint64_t>());

  FinishOutcome atTheStart = h.service.finish(uid(), sid(), started);   // a workout with one rep
  CHECK(atTheStart.error == FinishError::none);
  CHECK_EQ(atTheStart.session->finishedAtMs, std::optional<std::uint64_t>(started));
}

TEST(log_auto_closes_the_stale_open_session_before_listing) {
  Harness h;
  const std::uint64_t started = h.clock.now;
  h.startAt(started);
  h.clock.now += kAutoCloseMs;

  std::vector<SessionSummary> listed = h.logBefore(h.clock.now + 1);

  CHECK_EQ(listed.size(), static_cast<std::size_t>(1));
  CHECK_EQ(listed[0].session.finishedAtMs, std::optional<std::uint64_t>(started));
  CHECK_EQ(h.repo.sessions[0].finishedAtMs, std::optional<std::uint64_t>(started));
}

TEST(log_lists_newest_first_with_counts_and_sorted_names) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.service.append(uid(), sid(), h.bench("set_00000001", 80.0, h.clock.now + 1));
  h.service.append(uid(), sid(),
                   SetWrite{setId("set_00000002"), ExerciseId{"back-squat"}, 100.0, 5,
                            SetKind::working, std::nullopt, "", h.clock.now + 2});
  h.service.finish(uid(), sid(), h.clock.now + 3);
  h.clock.now += 10'000;
  h.startAt(h.clock.now, "ses_00000002");

  std::vector<SessionSummary> listed = h.logBefore(h.clock.now + 1);

  CHECK_EQ(listed.size(), static_cast<std::size_t>(2));
  CHECK_EQ(listed[0].session.id.str(), std::string("ses_00000002"));
  CHECK_EQ(listed[0].setCount, 0);
  CHECK_EQ(listed[0].exerciseNames, std::vector<std::string>{});
  CHECK_EQ(listed[1].session.id.str(), std::string("ses_00000001"));
  CHECK_EQ(listed[1].setCount, 2);
  CHECK_EQ(listed[1].exerciseNames, (std::vector<std::string>{"Back Squat", "Bench Press"}));
}

// Two sessions sharing a start instant across a page edge: on a cursor of the instant alone the
// second one is in no page, ever. The compound cursor walks the whole log.
TEST(log_pages_across_a_tied_start_instant_without_losing_a_session) {
  Harness h;
  const std::uint64_t tied = h.clock.now;
  h.repo.sessions.push_back(Session{sid("ses_00000001"), uid(), tied + 3, tied + 4});
  h.repo.sessions.push_back(Session{sid("ses_00000002"), uid(), tied + 2, tied + 4});
  h.repo.sessions.push_back(Session{sid("ses_00000003"), uid(), tied + 2, tied + 4});
  h.repo.sessions.push_back(Session{sid("ses_00000004"), uid(), tied + 1, tied + 4});

  std::vector<SessionSummary> first = h.service.log(uid(), LogCursor{tied + 9, std::nullopt, 2});
  std::vector<SessionSummary> second = h.service.log(
      uid(), LogCursor{first.back().session.startedAtMs, first.back().session.id, 2});
  std::vector<SessionSummary> third = h.service.log(
      uid(), LogCursor{second.back().session.startedAtMs, second.back().session.id, 2});

  CHECK_EQ(first.size(), static_cast<std::size_t>(2));
  CHECK_EQ(first[0].session.id, sid("ses_00000001"));
  CHECK_EQ(first[1].session.id, sid("ses_00000003"));
  CHECK_EQ(second.size(), static_cast<std::size_t>(2));
  CHECK_EQ(second[0].session.id, sid("ses_00000002"));   // the tie-mate the old cursor skipped
  CHECK_EQ(second[1].session.id, sid("ses_00000004"));
  CHECK(third.empty());
}

TEST(detail_returns_the_session_with_its_sets_in_completion_order) {
  Harness h;
  h.startAt(h.clock.now);
  AppendOutcome second = h.service.append(uid(), sid(), h.bench("set_00000002", 82.5, h.clock.now + 2));
  AppendOutcome first = h.service.append(uid(), sid(), h.bench("set_00000001", 80.0, h.clock.now + 1));

  std::optional<SessionDetail> detail = h.service.detail(uid(), sid());

  REQUIRE(detail.has_value());
  CHECK_EQ(detail->session.id, sid());
  CHECK_EQ(detail->sets, (std::vector<Set>{*first.set, *second.set}));
  CHECK_EQ(h.service.detail(uid("u2"), sid()), std::optional<SessionDetail>());
}

// ---- last time: the number on screen before the lifter touches anything --------------------

TEST(last_time_is_the_most_recent_finished_session_never_the_open_one) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.service.append(uid(), sid("ses_00000001"), h.bench("set_00000001", 80.0, h.clock.now + 1));
  h.service.finish(uid(), sid("ses_00000001"), h.clock.now + 2);
  h.clock.now += 10'000;
  h.startAt(h.clock.now, "ses_00000002");
  AppendOutcome top =
      h.service.append(uid(), sid("ses_00000002"), h.bench("set_00000002", 82.5, h.clock.now + 1));
  AppendOutcome backOff =
      h.service.append(uid(), sid("ses_00000002"), h.bench("set_00000003", 80.0, h.clock.now + 2));
  h.service.finish(uid(), sid("ses_00000002"), h.clock.now + 3);
  // Today, live, heavier: these sets are the today list, and an unfinished session is not a last
  // time — otherwise the prefill would read back the number the lifter is standing under.
  h.clock.now += 10'000;
  h.startAt(h.clock.now, "ses_00000003");
  h.service.append(uid(), sid("ses_00000003"), h.bench("set_00000004", 100.0, h.clock.now + 1));

  LastTimeOutcome last = h.service.lastTime(uid(), ExerciseId{"bench-press"});

  CHECK(last.error == LastTimeError::none);
  CHECK_EQ(last.lastTime->session.id, sid("ses_00000002"));
  CHECK_EQ(last.lastTime->routineName, std::string(""));
  CHECK_EQ(last.lastTime->sets, (std::vector<Set>{*top.set, *backOff.set}));
  CHECK_EQ(h.repo.sessions[2].finishedAtMs, std::optional<std::uint64_t>());
}

TEST(last_time_is_the_working_block_in_set_order_and_never_the_warmups) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.service.append(uid(), sid("ses_00000001"),
                   SetWrite{setId("set_00000001"), ExerciseId{"bench-press"}, 40.0, 10,
                            SetKind::warmup, std::nullopt, "", h.clock.now + 1});
  AppendOutcome first =
      h.service.append(uid(), sid("ses_00000001"), h.bench("set_00000002", 82.5, h.clock.now + 2));
  AppendOutcome second =
      h.service.append(uid(), sid("ses_00000001"), h.bench("set_00000003", 82.5, h.clock.now + 3));
  AppendOutcome third =
      h.service.append(uid(), sid("ses_00000001"), h.bench("set_00000004", 80.0, h.clock.now + 4));
  h.service.append(uid(), sid("ses_00000001"),
                   SetWrite{setId("set_00000005"), ExerciseId{"back-squat"}, 100.0, 5,
                            SetKind::working, std::nullopt, "", h.clock.now + 5});
  h.service.finish(uid(), sid("ses_00000001"), h.clock.now + 6);
  // No phase-0 write path mints a plan (§2.2 — parseSessionStart reads id and startedAt only), so
  // the snapshot is placed on the stored row the way phase 2 will write it.
  h.repo.sessions[0].planJson = R"({"routine":"Bench day","entries":[]})";

  LastTimeOutcome last = h.service.lastTime(uid(), ExerciseId{"bench-press"});

  CHECK(last.error == LastTimeError::none);
  CHECK_EQ(last.lastTime->routineName, std::string("Bench day"));
  CHECK_EQ(last.lastTime->sets, (std::vector<Set>{*first.set, *second.set, *third.set}));
  // Numbering counts the warmup (max+1 per session and exercise, whatever the kind), so the block
  // starts at 2: leaving warmups out of the answer is a filter, never a renumbering of the log.
  CHECK_EQ(last.lastTime->sets[0].setNumber, 2);
}

TEST(last_time_steps_over_a_session_that_only_warmed_this_movement_up) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  AppendOutcome worked =
      h.service.append(uid(), sid("ses_00000001"), h.bench("set_00000001", 82.5, h.clock.now + 1));
  h.service.finish(uid(), sid("ses_00000001"), h.clock.now + 2);
  // A later session that ramped up on bench, changed its mind and trained something else. A 40 kg
  // ramp-up single is not an answer to "what did I do last time".
  h.clock.now += 10'000;
  h.startAt(h.clock.now, "ses_00000002");
  h.service.append(uid(), sid("ses_00000002"),
                   SetWrite{setId("set_00000002"), ExerciseId{"bench-press"}, 40.0, 10,
                            SetKind::warmup, std::nullopt, "", h.clock.now + 1});
  h.service.finish(uid(), sid("ses_00000002"), h.clock.now + 2);

  LastTimeOutcome last = h.service.lastTime(uid(), ExerciseId{"bench-press"});

  CHECK(last.error == LastTimeError::none);
  CHECK_EQ(last.lastTime->session.id, sid("ses_00000001"));
  CHECK_EQ(last.lastTime->sets, std::vector<Set>{*worked.set});
}

TEST(last_time_never_reaches_into_another_accounts_log) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  AppendOutcome mine =
      h.service.append(uid(), sid("ses_00000001"), h.bench("set_00000001", 82.5, h.clock.now + 1));
  h.service.finish(uid(), sid("ses_00000001"), h.clock.now + 2);
  // The other lifter benched more recently, and heavier. It is their log.
  h.repo.sessions.push_back(
      Session{sid("ses_00000009"), uid("u2"), h.clock.now + 10, h.clock.now + 30});
  h.repo.sets.push_back(Set{setId("set_00000009"), sid("ses_00000009"), ExerciseId{"bench-press"},
                            1, 142.5, 3, SetKind::working, std::nullopt, "", h.clock.now + 20});

  LastTimeOutcome ours = h.service.lastTime(uid(), ExerciseId{"bench-press"});
  LastTimeOutcome theirs = h.service.lastTime(uid("u2"), ExerciseId{"bench-press"});

  CHECK(ours.error == LastTimeError::none);
  CHECK_EQ(ours.lastTime->session.id, sid("ses_00000001"));
  CHECK_EQ(ours.lastTime->sets, std::vector<Set>{*mine.set});
  CHECK(theirs.error == LastTimeError::none);
  CHECK_EQ(theirs.lastTime->session.id, sid("ses_00000009"));
  CHECK_EQ(theirs.lastTime->sets, std::vector<Set>{h.repo.sets[1]});
}

// The two ways an answer can be empty, and they are not the same thing: a movement you have never
// trained is a fact the card renders as "First time logging this"; a movement no catalog holds is
// a client fault, and only the store can tell them apart.
TEST(last_time_of_a_first_ever_movement_is_a_fact_and_of_an_unknown_one_is_a_fault) {
  Harness h;
  h.startAt(h.clock.now);
  h.service.append(uid(), sid(), h.bench("set_00000001", 82.5, h.clock.now + 1));
  h.service.finish(uid(), sid(), h.clock.now + 2);
  h.repo.seedCustom(uid("u2"), Exercise{ExerciseId{"landmine-press"}, "Landmine Press",
                                        Pattern::press, Equipment::barbell, 2.5, true});

  LastTimeOutcome firstEver = h.service.lastTime(uid(), ExerciseId{"back-squat"});
  LastTimeOutcome unknown = h.service.lastTime(uid(), ExerciseId{"zercher-squat"});
  LastTimeOutcome anothersCustom = h.service.lastTime(uid(), ExerciseId{"landmine-press"});

  CHECK(firstEver.error == LastTimeError::none);
  CHECK_FALSE(firstEver.lastTime.has_value());
  CHECK(unknown.error == LastTimeError::unknownExercise);
  CHECK_FALSE(unknown.lastTime.has_value());
  CHECK(anothersCustom.error == LastTimeError::unknownExercise);
  CHECK_FALSE(anothersCustom.lastTime.has_value());
}

// The prefill fires on every movement change, and the only session it could ever settle is the one
// the lifter is standing in — one open session per account is the store's rule. A device whose
// clock runs behind stamps its sets past the auto-close window (instants are the device's own,
// §2.2), so the read must leave the workout open, refuse to answer with it, and let the next set
// land: the reply carries no session state, and a close nobody can see refuses every set after it.
TEST(last_time_never_closes_the_session_the_lifter_is_in) {
  Harness h;
  const std::uint64_t started = h.clock.now;
  h.startAt(started, "ses_00000001");
  AppendOutcome lastWeek =
      h.service.append(uid(), sid("ses_00000001"), h.bench("set_00000001", 82.5, started + 1));
  h.service.finish(uid(), sid("ses_00000001"), started + 2);
  const std::uint64_t liveSetAt = started + 4;
  h.clock.now = started + 3;
  h.startAt(h.clock.now, "ses_00000002");
  h.service.append(uid(), sid("ses_00000002"), h.bench("set_00000002", 100.0, liveSetAt));
  h.clock.now = liveSetAt + kAutoCloseMs;   // the live workout now reads as idle past the window

  LastTimeOutcome last = h.service.lastTime(uid(), ExerciseId{"bench-press"});
  AppendOutcome next =
      h.service.append(uid(), sid("ses_00000002"), h.bench("set_00000003", 102.5, h.clock.now + 1));

  CHECK(last.error == LastTimeError::none);
  CHECK_EQ(last.lastTime->session.id, sid("ses_00000001"));   // never the live one, closed or not
  CHECK_EQ(last.lastTime->sets, std::vector<Set>{*lastWeek.set});
  CHECK_EQ(h.repo.sessions[1].finishedAtMs, std::optional<std::uint64_t>());
  CHECK(next.error == AppendError::none);
  CHECK_EQ(next.set->setNumber, 2);
}

// And dropping the settle from the prefill does not let it reach past a session abandoned with the
// tab shut: the log read the client boots on closes that one first, and a closed session is a last
// time like any other. Until then it is open, which is already not a last time.
TEST(last_time_sees_a_stale_session_once_the_log_read_has_settled_it) {
  Harness h;
  const std::uint64_t started = h.clock.now;
  h.startAt(started, "ses_00000001");
  AppendOutcome older =
      h.service.append(uid(), sid("ses_00000001"), h.bench("set_00000001", 80.0, started + 1));
  h.service.finish(uid(), sid("ses_00000001"), started + 2);
  const std::uint64_t abandonedStart = started + 10'000;
  const std::uint64_t abandonedSetAt = abandonedStart + 1;
  h.clock.now = abandonedStart;
  h.startAt(abandonedStart, "ses_00000002");
  AppendOutcome abandoned =
      h.service.append(uid(), sid("ses_00000002"), h.bench("set_00000002", 82.5, abandonedSetAt));
  h.clock.now = abandonedSetAt + kAutoCloseMs;

  LastTimeOutcome beforeTheLogRead = h.service.lastTime(uid(), ExerciseId{"bench-press"});
  h.logBefore(h.clock.now + 1);
  LastTimeOutcome afterTheLogRead = h.service.lastTime(uid(), ExerciseId{"bench-press"});

  CHECK_EQ(beforeTheLogRead.lastTime->session.id, sid("ses_00000001"));
  CHECK_EQ(beforeTheLogRead.lastTime->sets, std::vector<Set>{*older.set});
  CHECK_EQ(afterTheLogRead.lastTime->session.id, sid("ses_00000002"));
  CHECK_EQ(afterTheLogRead.lastTime->session.finishedAtMs,
           std::optional<std::uint64_t>(abandonedSetAt));
  CHECK_EQ(afterTheLogRead.lastTime->sets, std::vector<Set>{*abandoned.set});
}

// Last time is the newest SESSION, never the newest set instant. completedAt is the device's wall
// clock and nothing ties it to the session holding it, so one future-stamped set would otherwise
// pin the answer to a week-old session while the log listed a fresher one above it — the same
// product, two reads, two different answers to "what did I do last time".
TEST(last_time_is_the_newest_session_even_when_an_older_one_holds_a_future_stamped_set) {
  Harness h;
  const std::uint64_t day = 86'400'000;
  const std::uint64_t weekAgo = h.clock.now;
  h.startAt(weekAgo, "ses_00000001");
  h.service.append(uid(), sid("ses_00000001"), h.bench("set_00000001", 60.0, weekAgo + 30 * day));
  h.service.finish(uid(), sid("ses_00000001"), weekAgo + 1'000);
  h.clock.now = weekAgo + 7 * day;
  h.startAt(h.clock.now, "ses_00000002");
  AppendOutcome yesterday =
      h.service.append(uid(), sid("ses_00000002"), h.bench("set_00000002", 100.0, h.clock.now + 1));
  h.service.finish(uid(), sid("ses_00000002"), h.clock.now + 2);

  LastTimeOutcome last = h.service.lastTime(uid(), ExerciseId{"bench-press"});
  std::vector<SessionSummary> listed = h.logBefore(h.clock.now + 10'000);

  CHECK(last.error == LastTimeError::none);
  CHECK_EQ(last.lastTime->session.id, sid("ses_00000002"));
  CHECK_EQ(last.lastTime->sets, std::vector<Set>{*yesterday.set});
  CHECK_EQ(listed[0].session.id, last.lastTime->session.id);   // the two reads agree, by the key
}

// The name is read off the session's own frozen snapshot, and a snapshot is client data — so only
// a string is a routine name. jsonb renders an object, an array or a number as text, and that text
// would be printed verbatim into the card's cross-routine suffix.
TEST(last_time_names_the_routine_only_when_the_snapshot_holds_a_string) {
  const std::vector<std::pair<std::string, std::string>> snapshots{
      {R"({"routine":"Bench day","entries":[]})", "Bench day"},
      {R"({"routine":42})", ""},
      {R"({"routine":{"nested":1}})", ""},
      {R"({"routine":["a","b"]})", ""},
      {R"({"routine":null})", ""},
      {R"({"entries":[]})", ""},
      {R"(["a","b"])", ""},
      {R"("just a string")", ""},
      {"{not json at all", ""},
      {"", ""},
  };

  for (const auto& [snapshot, name] : snapshots) {
    Harness h;
    h.startAt(h.clock.now, "ses_00000001");
    AppendOutcome landed =
        h.service.append(uid(), sid("ses_00000001"), h.bench("set_00000001", 82.5, h.clock.now + 1));
    h.service.finish(uid(), sid("ses_00000001"), h.clock.now + 2);
    h.repo.sessions[0].planJson = snapshot;

    LastTimeOutcome last = h.service.lastTime(uid(), ExerciseId{"bench-press"});

    CHECK(last.error == LastTimeError::none);
    CHECK_EQ(last.lastTime->routineName, name);
    CHECK_EQ(last.lastTime->sets, std::vector<Set>{*landed.set});
  }
}

TEST(catalog_serves_seeds_plus_own_customs_ordered_by_pattern_then_name) {
  Harness h;
  Exercise mine{ExerciseId{"landmine-press"}, "Landmine Press", Pattern::press,
                Equipment::barbell, 2.5, true};
  h.repo.seedCustom(uid(), mine);
  h.repo.seedCustom(uid("u2"), Exercise{ExerciseId{"zercher-squat"}, "Zercher Squat",
                                        Pattern::squat, Equipment::barbell, 2.5, true});

  std::vector<Exercise> mineListed = h.service.catalog(uid());

  CHECK_EQ(mineListed, (std::vector<Exercise>{benchPress(), mine, backSquat()}));
}

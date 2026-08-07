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
const std::uint64_t kWeek = 604'800'000;

// One repo, one hand-driven clock, both seeds — every test starts here and perturbs one thing.
struct Harness {
  FakeTrainingRepository repo;
  wm::fake::FakeClock clock;
  wm::fake::FakeTokens tokens;
  LogService service{repo, clock, tokens};

  Harness() {
    repo.seed(benchPress());
    repo.seed(backSquat());
  }

  StartOutcome startAt(std::uint64_t ms, std::string id = "ses_00000001") {
    return service.start(uid(), SessionStart{sid(std::move(id)), ms});
  }

  // The other door into a workout: the day of the program, named by id and frozen by the server.
  StartOutcome startFrom(std::uint64_t ms, std::string id, std::string routine) {
    return service.start(uid(),
                         SessionStart{sid(std::move(id)), ms, true, rtId(std::move(routine))});
  }

  RoutineWrite pushAWrite(std::vector<RoutineEntry> entries = {benchEntry()},
                          std::string id = "rt_00000001", std::string name = "Push A") {
    return RoutineWrite{rtId(std::move(id)), std::move(name), 0, std::move(entries)};
  }

  // The other Start: "create exactly this session, which is not now" — backfill and lift-import.
  StartOutcome startExactly(std::uint64_t ms, std::string id) {
    return service.start(uid(), SessionStart{sid(std::move(id)), ms, false});
  }

  SetWrite bench(std::string id, double weightKg, std::uint64_t completedAtMs) {
    return SetWrite{setId(std::move(id)), ExerciseId{"bench-press"}, weightKg, 8,
                    SetKind::working, std::nullopt, "", completedAtMs};
  }

  // A whole workout of squats, start to finish — the door the finish surface is read behind. The
  // set ids come off the session's so no test has to mint one, and the sets land a minute apart.
  void trained(const std::string& session, std::uint64_t startedAtMs, double weightKg, int reps,
               int sets, std::optional<std::string> routine = std::nullopt) {
    service.start(uid(), SessionStart{sid(session), startedAtMs, true,
                                      routine ? std::optional<RoutineId>(rtId(*routine))
                                              : std::nullopt});
    for (int number = 1; number <= sets; ++number)
      service.append(uid(), sid(session),
                     SetWrite{setId("set_" + session.substr(4) + std::to_string(number)),
                              ExerciseId{"back-squat"}, weightKg, reps, SetKind::working,
                              std::nullopt, "",
                              startedAtMs + static_cast<std::uint64_t>(number) * 60'000});
    service.finish(uid(), sid(session), startedAtMs + 3'600'000);
  }

  // The same workout put straight into the store, for the one state the service's own doors cannot
  // produce: a session left open BEHIND a later one, which the one-open index makes unreachable
  // through start (and which a start would settle before it ever answered).
  void stored(const std::string& session, std::uint64_t startedAtMs,
              std::optional<std::uint64_t> finishedAtMs, double weightKg, int reps, int sets) {
    repo.sessions.push_back(Session{sid(session), uid(), startedAtMs, finishedAtMs});
    for (int number = 1; number <= sets; ++number)
      repo.sets.push_back(Set{setId("set_" + session.substr(4) + std::to_string(number)),
                              sid(session), ExerciseId{"back-squat"}, number, weightKg, reps,
                              SetKind::working, std::nullopt, "",
                              startedAtMs + static_cast<std::uint64_t>(number) * 60'000});
  }

  std::vector<SessionSummary> logBefore(std::uint64_t beforeMs, int limit = 50) {
    return service.log(uid(), LogCursor{beforeMs, std::nullopt, limit});
  }
};

// The two stores that lose a race the service cannot lose on its own — each one narrows the window
// between two of its statements to zero, which is the only way to drive from a test what a second
// device does between them.
struct ClosedUnderTheLock : FakeTrainingRepository {
  SetInsertOutcome insertSet(const Set&) override {
    return {std::nullopt, SetInsertError::finished};
  }
};

struct DiscardedUnderTheFinish : FakeTrainingRepository {
  void close(const SessionId& id, std::uint64_t finishedAtMs) override {
    FakeTrainingRepository::close(id, finishedAtMs);
    std::erase_if(sessions, [&](const Session& session) { return session.id == id; });
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
  REQUIRE_EQ(h.repo.sessions.size(), static_cast<std::size_t>(2));
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
  REQUIRE_EQ(h.repo.sets.size(), static_cast<std::size_t>(1));
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

// A set may not NAME a movement this account cannot see. A foreign key only asks whether the row
// exists, and another lifter's custom movement exists: named, its display name would print in this
// log, in this account's CSV export and in any workout it hands a coach — and the lifter who
// created it could never take it back, not even by deleting their account.
TEST(append_naming_another_accounts_private_movement_is_unknown_exercise) {
  Harness h;
  const Exercise theirs{ExerciseId{"ex_22222222"}, "Their Zercher Squat", Pattern::squat,
                        Equipment::barbell, 2.5, true};
  h.repo.seedCustom(uid("u2"), theirs);
  h.startAt(h.clock.now);

  AppendOutcome refused = h.service.append(
      uid(), sid(),
      SetWrite{setId("set_00000001"), ExerciseId{"ex_22222222"}, 100.0, 5, SetKind::working,
               std::nullopt, "", h.clock.now + 1});

  CHECK(refused.error == AppendError::unknownExercise);
  CHECK_FALSE(refused.set.has_value());
  CHECK(h.repo.sets.empty());

  // And it is a SCOPE, not a claim that the movement does not exist: its owner logs it as normal,
  // which is what makes the two accounts' answers differ without either learning about the other.
  h.service.start(uid("u2"), SessionStart{sid("ses_00000002"), h.clock.now});
  AppendOutcome mine = h.service.append(
      uid("u2"), sid("ses_00000002"),
      SetWrite{setId("set_00000002"), ExerciseId{"ex_22222222"}, 100.0, 5, SetKind::working,
               std::nullopt, "", h.clock.now + 2});
  CHECK(mine.error == AppendError::none);
  CHECK_EQ(mine.set->exercise, ExerciseId{"ex_22222222"});
}

// The finish boundary is the STORE's to hold, not only the read above it: the service checks the
// session it loaded, and a close landing between that read and the insert would otherwise let a set
// that never landed land after the workout ended — the one loss §3.3 says is impossible. The lock
// reads the state it locks, so the refusal is taken where the row is held.
TEST(append_that_reaches_a_session_closed_under_the_lock_is_refused_by_the_store) {
  Harness h;
  h.startAt(h.clock.now);
  h.service.finish(uid(), sid(), h.clock.now + 1'000);

  SetInsertOutcome landed =
      h.repo.insertSet(Set{setId("set_00000001"), sid(), ExerciseId{"bench-press"}, 0, 80.0, 8,
                           SetKind::working, std::nullopt, "", h.clock.now + 1});

  CHECK(landed.error == SetInsertError::finished);
  CHECK_FALSE(landed.set.has_value());
  CHECK(h.repo.sets.empty());
}

// And the service spells the store's refusal with the one it already had, so the wire learns
// nothing new: a client reads the same `finished` whichever of the two reads caught the close.
TEST(append_reports_the_stores_finish_refusal_as_the_finished_the_wire_already_knows) {
  ClosedUnderTheLock repo;
  wm::fake::FakeClock clock;
  wm::fake::FakeTokens tokens;
  LogService service{repo, clock, tokens};
  repo.seed(benchPress());
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
  REQUIRE_EQ(h.repo.sets.size(), static_cast<std::size_t>(1));
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

// Every other write in this service answers `none` with the row it resolved beside it; finish was
// the one that could answer `none` with nothing at all, when a discard from another device took the
// session in the window between the close and the read-back. Both wire edges dereference that
// optional, so the empty read-back is the fact the session was already gone.
TEST(finish_that_finds_the_session_gone_under_it_is_not_found_and_never_an_empty_none) {
  DiscardedUnderTheFinish repo;
  wm::fake::FakeClock clock;
  wm::fake::FakeTokens tokens;
  LogService service{repo, clock, tokens};
  service.start(uid(), SessionStart{sid(), clock.now});

  FinishOutcome outcome = service.finish(uid(), sid(), clock.now + 1'000);

  CHECK(outcome.error == FinishError::notFound);
  CHECK_FALSE(outcome.session.has_value());
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

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(1));
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

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(2));
  CHECK_EQ(listed[0].session.id.str(), std::string("ses_00000002"));
  CHECK_EQ(listed[0].setCount, 0);
  CHECK_EQ(listed[0].exerciseNames, std::vector<std::string>{});
  CHECK_EQ(listed[1].session.id.str(), std::string("ses_00000001"));
  CHECK_EQ(listed[1].setCount, 2);
  CHECK_EQ(listed[1].exerciseNames, (std::vector<std::string>{"Back Squat", "Bench Press"}));
}

// The log row's own two facts (§A2): the heaviest WORKING set of the session — ties to more reps,
// never volume, and a warmup is not what a session was — and whether the four-hour rule ended it.
TEST(log_carries_the_top_working_set_of_each_session) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.service.append(uid(), sid(), h.bench("set_00000001", 80.0, h.clock.now + 1));
  h.service.append(uid(), sid(),
                   SetWrite{setId("set_00000002"), ExerciseId{"back-squat"}, 100.0, 5,
                            SetKind::working, std::nullopt, "", h.clock.now + 2});
  h.service.append(uid(), sid(),
                   SetWrite{setId("set_00000003"), ExerciseId{"back-squat"}, 100.0, 8,
                            SetKind::working, std::nullopt, "", h.clock.now + 3});
  // Heavier than anything worked, and not a working set: a ramp-up is not what the row says.
  h.service.append(uid(), sid(),
                   SetWrite{setId("set_00000004"), ExerciseId{"back-squat"}, 140.0, 1,
                            SetKind::warmup, std::nullopt, "", h.clock.now + 4});
  h.service.finish(uid(), sid(), h.clock.now + 5);
  h.clock.now += 10'000;
  h.startAt(h.clock.now, "ses_00000002");   // nothing logged into it yet

  std::vector<SessionSummary> listed = h.logBefore(h.clock.now + 1);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(2));
  CHECK_EQ(listed[0].topSet, std::optional<TopWorkingSet>());   // no working set is not 0 kg × 0
  CHECK_EQ(listed[1].topSet, std::optional<TopWorkingSet>(TopWorkingSet{100.0, 8}));
}

// closedItself is inferred from the auto-close's own signature — finished_at at the last set's
// instant exactly, or at started_at for a session holding none — because the rule that writes it
// leaves nothing else behind. A lifter's own finish lands at the instant their device named.
TEST(log_says_which_sessions_the_four_hour_rule_closed) {
  Harness h;
  const std::uint64_t started = h.clock.now;
  h.startAt(started, "ses_00000001");
  h.service.append(uid(), sid("ses_00000001"), h.bench("set_00000001", 80.0, started + 60'000));
  h.service.finish(uid(), sid("ses_00000001"), started + 3'600'000);   // a tap, an hour later
  h.clock.now = started + 10'000'000;
  h.startAt(h.clock.now, "ses_00000002");   // left running, and never touched again
  h.service.append(uid(), sid("ses_00000002"),
                   h.bench("set_00000002", 80.0, h.clock.now + 60'000));
  const std::uint64_t abandoned = h.clock.now + 60'000;
  h.clock.now = abandoned + kAutoCloseMs;   // the next log read settles it

  std::vector<SessionSummary> listed = h.logBefore(h.clock.now + 1);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(2));
  CHECK_EQ(listed[0].session.finishedAtMs, std::optional<std::uint64_t>(abandoned));
  CHECK(listed[0].closedItself);
  CHECK_EQ(listed[1].session.finishedAtMs, std::optional<std::uint64_t>(started + 3'600'000));
  CHECK_FALSE(listed[1].closedItself);
}

// A session left running is not closed by anything yet, and a setless one the rule ended reads as
// its own start — the other branch of autoCloseAt, and the other half of the inference.
TEST(log_calls_an_open_session_closed_by_nothing_and_a_setless_auto_close_its_own_start) {
  Harness h;
  const std::uint64_t started = h.clock.now;
  h.startAt(started, "ses_00000001");

  std::vector<SessionSummary> running = h.logBefore(started + 1);
  h.clock.now = started + kAutoCloseMs;
  std::vector<SessionSummary> settled = h.logBefore(h.clock.now + 1);

  REQUIRE_EQ(running.size(), static_cast<std::size_t>(1));
  CHECK_EQ(running[0].session.finishedAtMs, std::optional<std::uint64_t>());
  CHECK_FALSE(running[0].closedItself);
  REQUIRE_EQ(settled.size(), static_cast<std::size_t>(1));
  CHECK_EQ(settled[0].session.finishedAtMs, std::optional<std::uint64_t>(started));
  CHECK(settled[0].closedItself);
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

  REQUIRE_EQ(first.size(), static_cast<std::size_t>(2));
  CHECK_EQ(first[0].session.id, sid("ses_00000001"));
  CHECK_EQ(first[1].session.id, sid("ses_00000003"));
  REQUIRE_EQ(second.size(), static_cast<std::size_t>(2));
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
  // The snapshot the start froze, placed on the stored row directly so this test stays about the
  // block and its order rather than about how a session came to carry a plan.
  h.repo.sessions[0].plan = PlanSnapshot{"Bench day", {}};

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

// The name is read off the session's own frozen snapshot, never off gym_routines: the prefill card
// names the day of the program that session WAS, as it was called then. A routine renamed — or
// deleted outright — since must not rewrite what the log says about the past.
TEST(last_time_names_the_routine_the_session_was_trained_under_not_the_one_stored_today) {
  Harness h;
  h.service.createRoutine(uid(), h.pushAWrite());
  h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  AppendOutcome landed =
      h.service.append(uid(), sid("ses_00000001"), h.bench("set_00000001", 82.5, h.clock.now + 1));
  h.service.finish(uid(), sid("ses_00000001"), h.clock.now + 2);

  h.service.replaceRoutine(uid(), rtId(), h.pushAWrite({benchEntry()}, "rt_00000001", "Bench day"));
  LastTimeOutcome afterRename = h.service.lastTime(uid(), ExerciseId{"bench-press"});
  h.service.deleteRoutine(uid(), rtId());
  LastTimeOutcome afterDelete = h.service.lastTime(uid(), ExerciseId{"bench-press"});

  CHECK(afterRename.error == LastTimeError::none);
  CHECK_EQ(afterRename.lastTime->routineName, std::string("Push A"));
  CHECK_EQ(afterDelete.lastTime->routineName, std::string("Push A"));
  // The pointer nulls with the row; the copy is what survives, and it is what the card prints.
  CHECK_EQ(afterDelete.lastTime->session.routine, std::optional<RoutineId>());
  CHECK_EQ(afterDelete.lastTime->session.plan,
           std::optional<PlanSnapshot>(PlanSnapshot{
               "Push A", {PlanEntry{ExerciseId{"bench-press"}, 5, 5, 82.5, 180}}}));
  CHECK_EQ(afterDelete.lastTime->sets, std::vector<Set>{*landed.set});
}

// ---- routines: the plan, written as one whole document ------------------------------------

TEST(create_routine_stores_the_document_and_reads_it_back) {
  Harness h;

  RoutineWriteOutcome created = h.service.createRoutine(
      uid(), h.pushAWrite({benchEntry(1), RoutineEntry{2, ExerciseId{"back-squat"}, 3, 8,
                                                       std::nullopt, std::nullopt}}));

  CHECK(created.error == RoutineWriteError::none);
  CHECK_EQ(*created.routine,
           Routine(rtId(), uid(), "Push A", 0,
                   {benchEntry(1),
                    RoutineEntry{2, ExerciseId{"back-squat"}, 3, 8, std::nullopt, std::nullopt}}));
  // Never trained yet, and that absence is the routines screen's own sentence.
  CHECK_EQ(created.routine->lastTrainedAtMs, std::optional<std::uint64_t>());
  CHECK_EQ(h.service.routine(uid(), rtId()), created.routine);
  CHECK_EQ(h.service.routine(uid("u2"), rtId()), std::optional<Routine>());
}

// The id is the idempotency key here exactly as it is for a session: a create that lost its reply
// and was sent again reads back what landed, and never appends a second copy of every line.
TEST(create_routine_replay_returns_the_stored_routine_untouched) {
  Harness h;
  RoutineWriteOutcome first = h.service.createRoutine(uid(), h.pushAWrite());

  RoutineWriteOutcome replayed = h.service.createRoutine(
      uid(), h.pushAWrite({benchEntry(1), benchEntry(2)}, "rt_00000001", "Renamed mid-flight"));

  CHECK(replayed.error == RoutineWriteError::none);
  CHECK_EQ(*replayed.routine, *first.routine);
  CHECK_EQ(h.repo.routineRows.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.routineRows[0].entries.size(), static_cast<std::size_t>(1));
}

TEST(create_routine_with_an_id_another_account_holds_is_id_taken) {
  Harness h;
  h.repo.routineRows.push_back(Routine{rtId(), uid("u2"), "Their plan", 0, {benchEntry()}});

  RoutineWriteOutcome created = h.service.createRoutine(uid(), h.pushAWrite());

  CHECK(created.error == RoutineWriteError::idTaken);
  CHECK_FALSE(created.routine.has_value());   // never the stranger's plan, not even to say it exists
  CHECK_EQ(h.repo.routineRows.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.routineRows[0].name, std::string("Their plan"));
  CHECK_EQ(h.service.routine(uid(), rtId()), std::optional<Routine>());
}

// The catalog is storage's to know, so the refusal is born there and travels as a value — the same
// fact a set naming an unknown movement gets. The whole document is one transaction, so a refused
// line leaves no half-written routine behind.
TEST(create_routine_naming_a_movement_no_catalog_holds_is_unknown_exercise) {
  Harness h;

  RoutineWriteOutcome created = h.service.createRoutine(
      uid(), h.pushAWrite({benchEntry(1), RoutineEntry{2, ExerciseId{"zercher-squat"}, 3, 8,
                                                       std::nullopt, std::nullopt}}));

  CHECK(created.error == RoutineWriteError::unknownExercise);
  CHECK_FALSE(created.routine.has_value());
  CHECK(h.repo.routineRows.empty());
  CHECK_EQ(h.service.routines(uid()), std::vector<Routine>{});
}

// The same scope the set write is held to, on the other door a movement id can travel through: a
// plan may not name another lifter's private movement either, or the routines screen would print
// their movement name every time it drew this day of the program — and the replace must not be the
// way around the create's refusal, since both halves write the same whole document.
TEST(a_routine_entry_naming_another_accounts_private_movement_is_unknown_exercise) {
  Harness h;
  h.repo.seedCustom(uid("u2"), Exercise{ExerciseId{"ex_22222222"}, "Their Zercher Squat",
                                        Pattern::squat, Equipment::barbell, 2.5, true});
  const RoutineEntry theirs{1, ExerciseId{"ex_22222222"}, 3, 8, 60.0, 120};

  RoutineWriteOutcome created = h.service.createRoutine(uid(), h.pushAWrite({theirs}));
  h.service.createRoutine(uid(), h.pushAWrite());
  RoutineWriteOutcome replaced = h.service.replaceRoutine(uid(), rtId(), h.pushAWrite({theirs}));

  CHECK(created.error == RoutineWriteError::unknownExercise);
  CHECK_FALSE(created.routine.has_value());
  CHECK(replaced.error == RoutineWriteError::unknownExercise);
  CHECK_FALSE(replaced.routine.has_value());
  REQUIRE_EQ(h.repo.routineRows.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.routineRows[0].entries, std::vector<RoutineEntry>{benchEntry()});
}

TEST(replace_routine_rewrites_the_whole_document) {
  Harness h;
  h.service.createRoutine(uid(), h.pushAWrite());

  RoutineWriteOutcome replaced = h.service.replaceRoutine(
      uid(), rtId(),
      h.pushAWrite({RoutineEntry{1, ExerciseId{"back-squat"}, 4, 6, 100.0, 240}, benchEntry(2)},
                   "rt_00000001", "Push A2"));

  CHECK(replaced.error == RoutineWriteError::none);
  CHECK_EQ(*replaced.routine,
           Routine(rtId(), uid(), "Push A2", 0,
                   {RoutineEntry{1, ExerciseId{"back-squat"}, 4, 6, 100.0, 240}, benchEntry(2)}));
  // A reorder, an insertion and a deletion are one write: the lines have no identity to churn.
  CHECK_EQ(h.repo.routineRows.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.service.routine(uid(), rtId()), replaced.routine);
}

TEST(replace_of_a_missing_or_anothers_routine_is_the_same_not_found) {
  Harness h;
  h.repo.routineRows.push_back(Routine{rtId("rt_00000002"), uid("u2"), "Their plan", 0,
                                       {benchEntry()}});

  RoutineWriteOutcome missing = h.service.replaceRoutine(uid(), rtId(), h.pushAWrite());
  RoutineWriteOutcome theirs = h.service.replaceRoutine(
      uid(), rtId("rt_00000002"), h.pushAWrite({benchEntry()}, "rt_00000002", "Mine now"));

  CHECK(missing.error == RoutineWriteError::notFound);
  CHECK(theirs.error == RoutineWriteError::notFound);
  CHECK_EQ(h.repo.routineRows[0].name, std::string("Their plan"));
  CHECK_EQ(h.repo.routineRows[0].user, uid("u2"));
}

TEST(delete_routine_takes_the_pointer_off_every_session_that_ran_it_and_leaves_the_snapshot) {
  Harness h;
  h.service.createRoutine(uid(), h.pushAWrite());
  h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  h.service.finish(uid(), sid("ses_00000001"), h.clock.now + 1);

  CHECK_FALSE(h.service.deleteRoutine(uid("u2"), rtId()));   // another account cannot reach it
  CHECK(h.service.deleteRoutine(uid(), rtId()));
  CHECK_FALSE(h.service.deleteRoutine(uid(), rtId()));       // and it is gone, not gone twice

  std::optional<SessionDetail> detail = h.service.detail(uid(), sid("ses_00000001"));
  REQUIRE(detail.has_value());
  CHECK_EQ(detail->session.routine, std::optional<RoutineId>());
  CHECK_EQ(detail->session.plan,
           std::optional<PlanSnapshot>(PlanSnapshot{
               "Push A", {PlanEntry{ExerciseId{"bench-press"}, 5, 5, 82.5, 180}}}));
  CHECK_EQ(h.service.routines(uid()), std::vector<Routine>{});
}

// The routines screen's order: most recently trained first, the never-trained after them rather
// than above them, and the instant is the store's own aggregate over the log — not a column anyone
// writes, so it cannot fall out of step with the sessions it describes.
TEST(routines_list_is_most_recently_trained_first_with_the_untrained_last) {
  Harness h;
  h.service.createRoutine(uid(), h.pushAWrite({benchEntry()}, "rt_00000001", "Push A"));
  h.service.createRoutine(uid(), h.pushAWrite({benchEntry()}, "rt_00000002", "Pull A"));
  h.service.createRoutine(uid(), h.pushAWrite({benchEntry()}, "rt_00000003", "Legs"));
  h.startFrom(h.clock.now, "ses_00000001", "rt_00000002");
  h.service.finish(uid(), sid("ses_00000001"), h.clock.now + 1);
  const std::uint64_t later = h.clock.now + 10'000;
  h.startFrom(later, "ses_00000002", "rt_00000001");
  h.service.finish(uid(), sid("ses_00000002"), later + 1);

  std::vector<Routine> listed = h.service.routines(uid());

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(3));
  CHECK_EQ(listed[0].name, std::string("Push A"));
  CHECK_EQ(listed[0].lastTrainedAtMs, std::optional<std::uint64_t>(later));
  CHECK_EQ(listed[1].name, std::string("Pull A"));
  CHECK_EQ(listed[1].lastTrainedAtMs, std::optional<std::uint64_t>(h.clock.now));
  CHECK_EQ(listed[2].name, std::string("Legs"));
  CHECK_EQ(listed[2].lastTrainedAtMs, std::optional<std::uint64_t>());
  CHECK_EQ(h.service.routines(uid("u2")), std::vector<Routine>{});
}

// ---- start from a routine: the server freezes the plan --------------------------------------

TEST(start_from_a_routine_freezes_its_name_and_entries_onto_the_session) {
  Harness h;
  h.service.createRoutine(uid(), h.pushAWrite({benchEntry(1), RoutineEntry{
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
  CHECK_EQ(h.repo.sessions[0], *started.session);
}

// `Chin-up 3 × max`, from the write to the frozen copy: a line that names no rep target is stored
// as naming none and freezes as naming none, so the logger asks for nothing rather than for zero.
TEST(a_routine_line_with_no_rep_target_survives_the_write_and_the_freeze) {
  Harness h;
  h.repo.seed(Exercise{ExerciseId{"chin-up"}, "Chin-up", Pattern::pull, Equipment::bodyweight, 2.5,
                       false});
  RoutineWriteOutcome created = h.service.createRoutine(
      uid(), h.pushAWrite({RoutineEntry{1, ExerciseId{"chin-up"}, 3, std::nullopt, std::nullopt,
                                        180}}));

  StartOutcome started = h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");

  CHECK(created.error == RoutineWriteError::none);
  CHECK_EQ(created.routine->entries[0].targetReps, std::optional<int>());
  CHECK_EQ(h.service.routine(uid(), rtId())->entries[0].targetReps, std::optional<int>());
  CHECK(started.error == StartError::none);
  CHECK_EQ(started.session->plan,
           std::optional<PlanSnapshot>(PlanSnapshot{
               "Push A", {PlanEntry{ExerciseId{"chin-up"}, 3, std::nullopt, std::nullopt, 180}}}));
}

// An unknown routine — or another account's, which is the same fact — is refused rather than
// started ad-hoc: a workout that quietly lost its plan has no targets and nothing on screen to say
// so. Nothing lands, so the same body works the moment the routine does exist.
TEST(start_naming_a_routine_this_account_cannot_read_is_refused) {
  Harness h;
  h.repo.routineRows.push_back(Routine{rtId("rt_00000002"), uid("u2"), "Their plan", 0,
                                       {benchEntry()}});

  StartOutcome unknown = h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  StartOutcome theirs = h.startFrom(h.clock.now, "ses_00000001", "rt_00000002");

  CHECK(unknown.error == StartError::unknownRoutine);
  CHECK(theirs.error == StartError::unknownRoutine);
  CHECK_FALSE(unknown.session.has_value());
  CHECK_FALSE(theirs.session.has_value());
  CHECK(h.repo.sessions.empty());
}

// Pressing Start cannot re-plan a workout that is already running: the join answers with the open
// session and ITS stored snapshot, whatever routine this call named. The sets already in it were
// logged against the plan it began with, and a second plan arriving mid-workout would make the
// comparison at the end a comparison against something that never happened.
TEST(start_that_joins_an_open_session_keeps_the_plan_that_session_began_with) {
  Harness h;
  h.service.createRoutine(uid(), h.pushAWrite({benchEntry()}, "rt_00000001", "Push A"));
  h.service.createRoutine(uid(), h.pushAWrite({benchEntry()}, "rt_00000002", "Legs"));
  StartOutcome live = h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");

  StartOutcome joined = h.startFrom(h.clock.now + 5, "ses_00000002", "rt_00000002");
  StartOutcome adHoc = h.startAt(h.clock.now + 6, "ses_00000003");

  CHECK(joined.error == StartError::none);
  CHECK_EQ(*joined.session, *live.session);
  CHECK_EQ(joined.session->plan->routineName, std::string("Push A"));
  CHECK(adHoc.error == StartError::none);
  CHECK_EQ(adHoc.session->plan->routineName, std::string("Push A"));
  CHECK_EQ(h.repo.sessions.size(), static_cast<std::size_t>(1));
}

// The same rule reached the other way: a replay of the caller's OWN id answers with the session as
// it is stored, so the plan it was started under outlives a body that has since changed its mind.
TEST(start_replay_keeps_the_plan_the_session_was_started_under) {
  Harness h;
  h.service.createRoutine(uid(), h.pushAWrite({benchEntry()}, "rt_00000001", "Push A"));
  h.service.createRoutine(uid(), h.pushAWrite({benchEntry()}, "rt_00000002", "Legs"));
  StartOutcome first = h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  h.service.finish(uid(), sid("ses_00000001"), h.clock.now + 1);

  StartOutcome replayed = h.startFrom(h.clock.now, "ses_00000001", "rt_00000002");

  CHECK(replayed.error == StartError::none);
  CHECK_EQ(replayed.session->plan->routineName, std::string("Push A"));
  CHECK_EQ(replayed.session->routine, std::optional<RoutineId>(rtId("rt_00000001")));
  CHECK_EQ(replayed.session->startedAtMs, first.session->startedAtMs);
  CHECK_EQ(h.repo.sessions.size(), static_cast<std::size_t>(1));
}

// The routine is loaded only where a session is actually CREATED. A replay and a join are not
// planning anything — they are being handed a session that already exists — so a routine deleted
// since the workout began cannot 404 either of them. It used to: the plan was frozen before the
// caller's own id was ever resolved, so a flush queue replaying its start read `no such routine`
// (terminal, by the ladder) for a session that was sitting in the store, and a phone pressing Start
// could not get back into its own live workout.
TEST(start_replay_and_join_survive_a_routine_deleted_since_the_workout_began) {
  Harness h;
  h.service.createRoutine(uid(), h.pushAWrite({benchEntry()}, "rt_00000001", "Push A"));
  StartOutcome live = h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  CHECK(h.service.deleteRoutine(uid(), rtId("rt_00000001")));

  StartOutcome replayed = h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  StartOutcome joined = h.startFrom(h.clock.now + 5, "ses_00000002", "rt_00000001");

  CHECK(live.error == StartError::none);
  CHECK(replayed.error == StartError::none);
  CHECK_EQ(replayed.session->id, sid("ses_00000001"));
  // The routine row is gone (`on delete set null`) and the frozen copy is what survives — which is
  // the whole reason the snapshot is a copy and not a pointer.
  CHECK_EQ(replayed.session->routine, std::optional<RoutineId>());
  CHECK_EQ(replayed.session->plan->routineName, std::string("Push A"));
  CHECK(joined.error == StartError::none);
  CHECK_EQ(joined.session->id, sid("ses_00000001"));
  CHECK_EQ(joined.session->plan->routineName, std::string("Push A"));
  CHECK_EQ(h.repo.sessions.size(), static_cast<std::size_t>(1));
}

// The same order, reached from the other side: a finished session replays even when the routine it
// names has since been deleted, and a caller that will NOT join is still refused rather than told
// the routine is missing — the refusal it gets is the one about its own open workout.
TEST(start_resolves_its_own_id_before_it_ever_looks_at_a_routine) {
  Harness h;
  h.service.createRoutine(uid(), h.pushAWrite({benchEntry()}, "rt_00000001", "Push A"));
  h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  h.service.finish(uid(), sid("ses_00000001"), h.clock.now + 1);
  h.startFrom(h.clock.now + 10, "ses_00000002", "rt_00000001");   // and this one stays open
  CHECK(h.service.deleteRoutine(uid(), rtId("rt_00000001")));

  StartOutcome finishedReplay = h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  StartOutcome willNotJoin = h.service.start(
      uid(), SessionStart{sid("ses_00000003"), h.clock.now + 20, false, rtId("rt_00000001")});

  CHECK(finishedReplay.error == StartError::none);
  CHECK_EQ(finishedReplay.session->finishedAtMs, std::optional<std::uint64_t>(h.clock.now + 1));
  CHECK(willNotJoin.error == StartError::alreadyOpen);
  CHECK_FALSE(willNotJoin.session.has_value());
  CHECK_EQ(h.repo.sessions.size(), static_cast<std::size_t>(2));
}

// ---- the catalog's one write ----------------------------------------------------------------

TEST(create_exercise_takes_the_equipments_default_step_and_joins_the_callers_catalog) {
  Harness h;

  ExerciseInsertOutcome created = h.service.createExercise(
      uid(), ExerciseWrite{ExerciseId{"ex_11111111"}, "Zercher Squat", Pattern::squat,
                           Equipment::machine, std::nullopt});
  ExerciseInsertOutcome stated = h.service.createExercise(
      uid(), ExerciseWrite{ExerciseId{"ex_22222222"}, "Landmine Press", Pattern::press,
                           Equipment::barbell, 1.25});

  CHECK(created.error == ExerciseInsertError::none);
  CHECK_EQ(*created.exercise, Exercise(ExerciseId{"ex_11111111"}, "Zercher Squat", Pattern::squat,
                                       Equipment::machine, 5.0, true));
  CHECK_EQ(stated.exercise->stepKg, 1.25);
  // Theirs alone: the catalog read serves the seeds plus the caller's own, never another's.
  CHECK_EQ(h.service.catalog(uid()),
           (std::vector<Exercise>{benchPress(), *stated.exercise, backSquat(), *created.exercise}));
  CHECK_EQ(h.service.catalog(uid("u2")), (std::vector<Exercise>{benchPress(), backSquat()}));
}

// A seed's slug is taken and stays taken; the caller's OWN id replays with the movement already
// under it, because the alternative is a lost reply re-minted into a second "Zercher Squat" —
// which is the identity fork §2.1 exists to make impossible.
TEST(create_exercise_refuses_a_spent_id_and_replays_the_callers_own) {
  Harness h;
  ExerciseInsertOutcome first = h.service.createExercise(
      uid(), ExerciseWrite{ExerciseId{"ex_11111111"}, "Zercher Squat", Pattern::squat,
                           Equipment::barbell, std::nullopt});
  h.repo.seedCustom(uid("u2"), Exercise{ExerciseId{"ex_99999999"}, "Their Movement",
                                        Pattern::pull, Equipment::cable, 2.5, true});

  ExerciseInsertOutcome seedSlug = h.service.createExercise(
      uid(), ExerciseWrite{ExerciseId{"bench-press"}, "My Bench", Pattern::press,
                           Equipment::barbell, std::nullopt});
  ExerciseInsertOutcome theirs = h.service.createExercise(
      uid(), ExerciseWrite{ExerciseId{"ex_99999999"}, "My Movement", Pattern::pull,
                           Equipment::cable, std::nullopt});
  ExerciseInsertOutcome replayed = h.service.createExercise(
      uid(), ExerciseWrite{ExerciseId{"ex_11111111"}, "Zercher Squat (renamed)", Pattern::squat,
                           Equipment::barbell, std::nullopt});

  CHECK(seedSlug.error == ExerciseInsertError::idTaken);
  CHECK_FALSE(seedSlug.exercise.has_value());
  CHECK(theirs.error == ExerciseInsertError::idTaken);
  CHECK_FALSE(theirs.exercise.has_value());   // never the stranger's row, not even to say it exists
  CHECK(replayed.error == ExerciseInsertError::none);
  CHECK_EQ(*replayed.exercise, *first.exercise);
  CHECK_EQ(h.service.catalog(uid()),
           (std::vector<Exercise>{benchPress(), backSquat(), *first.exercise}));
}

// A created movement is a movement: a set names it, a routine holds it, and the prefill answers for
// it. Nothing about it is second-class except that only its owner can see it.
TEST(a_created_movement_can_be_logged_and_planned_like_a_seeded_one) {
  Harness h;
  h.service.createExercise(uid(), ExerciseWrite{ExerciseId{"ex_11111111"}, "Zercher Squat",
                                                Pattern::squat, Equipment::barbell, std::nullopt});
  RoutineWriteOutcome created = h.service.createRoutine(
      uid(), h.pushAWrite({RoutineEntry{1, ExerciseId{"ex_11111111"}, 3, 8, 60.0, 120}}));
  h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  AppendOutcome landed = h.service.append(
      uid(), sid("ses_00000001"),
      SetWrite{setId("set_00000001"), ExerciseId{"ex_11111111"}, 60.0, 8, SetKind::working,
               std::nullopt, "", h.clock.now + 1});
  h.service.finish(uid(), sid("ses_00000001"), h.clock.now + 2);

  LastTimeOutcome last = h.service.lastTime(uid(), ExerciseId{"ex_11111111"});
  LastTimeOutcome theirs = h.service.lastTime(uid("u2"), ExerciseId{"ex_11111111"});

  CHECK(created.error == RoutineWriteError::none);
  CHECK(landed.error == AppendError::none);
  CHECK(last.error == LastTimeError::none);
  CHECK_EQ(last.lastTime->routineName, std::string("Push A"));
  CHECK_EQ(last.lastTime->sets, std::vector<Set>{*landed.set});
  CHECK(theirs.error == LastTimeError::unknownExercise);
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

// ---- the finish surface: the review read, and the one destructive door ------------------------

TEST(review_of_a_missing_or_anothers_session_is_the_same_absence) {
  Harness h;
  h.repo.sessions.push_back(Session{sid("ses_00000002"), uid("u2"), h.clock.now,
                                    h.clock.now + 3'600'000});

  CHECK_EQ(h.service.review(uid(), sid("ses_00000001")), std::optional<Review>());
  CHECK_EQ(h.service.review(uid(), sid("ses_00000002")), std::optional<Review>());
}

// The load-bearing case, and it is the ordinary one: the review is always read AFTER the finish, so
// if the session were part of its own history every set in it would tie itself and the record would
// silently disappear. It is excluded by the (startedAt, id) window the port applies.
TEST(review_reads_the_marks_of_earlier_sessions_and_never_the_one_it_is_reviewing) {
  Harness h;
  h.trained("ses_00000001", h.clock.now - 2 * kWeek, 100, 5, 4);
  h.trained("ses_00000002", h.clock.now - kWeek, 105, 5, 4);

  std::optional<Review> result = h.service.review(uid(), sid("ses_00000002"));
  std::optional<Review> again = h.service.review(uid(), sid("ses_00000002"));

  const PersonalRecord estimate{RecordKind::e1rm, ExerciseId{"back-squat"}, 122.5, 105.0, 5, 116.7,
                                h.clock.now - 2 * kWeek + 60'000};
  REQUIRE(result.has_value());
  REQUIRE(result->record.has_value());
  CHECK_EQ(*result->record, estimate);
  CHECK_EQ(result->stats.workingSets, 4);
  // Computed on every read and stored nowhere, so the second answer is the first one.
  CHECK_EQ(result, again);
}

// An open session is not history — today's sets are today's, and 200 kg sitting in a workout nobody
// ever closed cannot be a mark. Every row here is pushed straight in: a start would have settled the
// stale one before it answered, which is the very door this rule sits behind.
TEST(review_never_takes_a_session_still_running_as_history) {
  Harness h;
  h.stored("ses_00000001", h.clock.now - 2 * kWeek, std::nullopt, 200, 5, 4);
  h.stored("ses_00000002", h.clock.now - kWeek, h.clock.now - kWeek + 3'600'000, 100, 5, 4);
  h.stored("ses_00000003", h.clock.now - 3'600'000, h.clock.now, 105, 5, 4);

  std::optional<Review> result = h.service.review(uid(), sid("ses_00000003"));

  REQUIRE(result.has_value());
  REQUIRE(result->record.has_value());
  CHECK_EQ(result->record->previous, 116.7);   // the finished 100 × 5, never the open 200 × 5
}

TEST(review_stands_against_the_last_session_of_the_same_routine) {
  Harness h;
  h.service.createRoutine(
      uid(), h.pushAWrite({RoutineEntry{1, ExerciseId{"back-squat"}, 5, 5, 100.0, 180}}));
  h.trained("ses_00000001", h.clock.now - 2 * kWeek, 95, 5, 4, "rt_00000001");
  h.trained("ses_00000002", h.clock.now - kWeek, 100, 5, 4);   // the same movement, no day behind it
  h.trained("ses_00000003", h.clock.now - 3'600'000, 105, 5, 4, "rt_00000001");

  std::optional<Review> result = h.service.review(uid(), sid("ses_00000003"));

  const std::vector<AgainstMovement> movements{
      AgainstMovement{ExerciseId{"back-squat"}, TopSet{105, 5, 4}, TopSet{95, 5, 4},
                      PlanEntry{ExerciseId{"back-squat"}, 5, 5, 100.0, 180}}};
  REQUIRE(result.has_value());
  REQUIRE(result->against.has_value());
  // The ad-hoc session between them trained the same movement and is still not the day of the
  // program, so it is not what this session stands against.
  CHECK_EQ(result->against->session, sid("ses_00000001"));
  CHECK_EQ(result->against->routineName, std::string("Push A"));
  CHECK_EQ(result->against->startedAtMs, h.clock.now - 2 * kWeek);
  CHECK_EQ(result->against->movements, movements);
}

// Only the device holding the offline queue knows every set has landed, so a workout somebody may
// still be logging into is never deleted out from under it.
TEST(discard_refuses_a_session_that_is_still_running) {
  Harness h;
  h.startAt(h.clock.now);
  h.service.append(uid(), sid(), h.bench("set_00000001", 82.5, h.clock.now + 1));

  DiscardOutcome refused = h.service.discard(uid(), sid());

  CHECK(refused == DiscardOutcome::open);
  CHECK_EQ(h.repo.sessions.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.sets.size(), static_cast<std::size_t>(1));
}

TEST(discard_takes_the_session_and_its_sets_and_asking_twice_is_the_same_fact) {
  Harness h;
  h.trained("ses_00000001", h.clock.now - 3'600'000, 100, 5, 4);

  DiscardOutcome first = h.service.discard(uid(), sid("ses_00000001"));
  DiscardOutcome again = h.service.discard(uid(), sid("ses_00000001"));

  CHECK(first == DiscardOutcome::done);
  CHECK(again == DiscardOutcome::notFound);
  CHECK(h.repo.sessions.empty());
  CHECK(h.repo.sets.empty());   // the sets go with the row, never orphaned behind it
}

TEST(discard_never_reaches_another_accounts_session) {
  Harness h;
  h.repo.sessions.push_back(Session{sid("ses_00000002"), uid("u2"), h.clock.now,
                                    h.clock.now + 3'600'000});

  DiscardOutcome theirs = h.service.discard(uid(), sid("ses_00000002"));

  CHECK(theirs == DiscardOutcome::notFound);   // absent and forbidden are one answer
  CHECK_EQ(h.repo.sessions.size(), static_cast<std::size_t>(1));
}

// ---- statistics: one load, one pure rule, and only finished sessions ------------------------

TEST(statistics_draws_a_point_per_finished_session_and_leaves_the_open_one_out) {
  Harness h;
  h.trained("ses_00000001", h.clock.now - 2 * kWeek, 100, 5, 4);
  h.trained("ses_00000002", h.clock.now - kWeek, 105, 5, 4);
  h.startAt(h.clock.now, "ses_00000003");   // today's workout, still being logged into
  h.service.append(uid(), sid("ses_00000003"),
                   SetWrite{setId("set_99999999"), ExerciseId{"back-squat"}, 110, 5,
                            SetKind::working, std::nullopt, "", h.clock.now + 60'000});

  Statistics answer = h.service.statistics(uid());

  REQUIRE_EQ(answer.movements.size(), static_cast<std::size_t>(1));
  REQUIRE_EQ(answer.movements[0].points.size(), static_cast<std::size_t>(2));
  CHECK_EQ(answer.movements[0].points[0],
           (MovementPoint{h.clock.now - 2 * kWeek, 100, 5, 116.7}));
  CHECK_EQ(answer.movements[0].points[1], (MovementPoint{h.clock.now - kWeek, 105, 5, 122.5}));
  CHECK_EQ(answer.movements[0].lastTrainedAtMs, h.clock.now - kWeek);
}

// The third door that settles staleness, and it has to be one: the answer counts finished sessions
// only, so a workout the four-hour rule ended hours ago but nobody has read since would be a hole
// in the chart — and a hole reads as "I did not train that week".
TEST(statistics_settles_a_session_the_four_hour_rule_already_ended) {
  Harness h;
  const std::uint64_t began = h.clock.now - 6 * 3'600'000;
  h.startAt(began, "ses_00000001");
  h.service.append(uid(), sid("ses_00000001"), h.bench("set_00000001", 82.5, began + 60'000));

  Statistics answer = h.service.statistics(uid());

  REQUIRE_EQ(h.repo.sessions.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.sessions[0].finishedAtMs, std::optional<std::uint64_t>(began + 60'000));
  REQUIRE_EQ(answer.movements.size(), static_cast<std::size_t>(1));
  CHECK_EQ(answer.movements[0].exercise, ExerciseId{"bench-press"});
}

TEST(statistics_never_reaches_another_accounts_log) {
  Harness h;
  h.repo.sessions.push_back(Session{sid("ses_00000002"), uid("u2"), h.clock.now - kWeek,
                                    h.clock.now - kWeek + 3'600'000});
  h.repo.sets.push_back(Set{setId("set_00000002"), sid("ses_00000002"), ExerciseId{"back-squat"}, 1,
                            200, 5, SetKind::working, std::nullopt, "", h.clock.now - kWeek});

  Statistics answer = h.service.statistics(uid());

  CHECK_EQ(answer.movements.size(), static_cast<std::size_t>(0));
  CHECK_EQ(answer.weeks.size(), static_cast<std::size_t>(0));
}

// ---- export: everything, rendered by the store, and nothing written ------------------------

TEST(export_carries_every_set_the_account_holds_including_the_open_session) {
  Harness h;
  h.trained("ses_00000001", h.clock.now - kWeek, 100, 5, 2);
  h.startAt(h.clock.now, "ses_00000002");
  h.service.append(uid(), sid("ses_00000002"),
                   SetWrite{setId("set_99999999"), ExerciseId{"bench-press"}, 82.5, 8,
                            SetKind::warmup, 8.5, "felt light", h.clock.now + 60'000});

  std::vector<ExportedSet> rows = h.service.exportedSets(uid());

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
  h.service.append(uid(), sid("ses_00000001"), h.bench("set_00000001", 82.5, began + 60'000));

  CHECK_EQ(h.service.exportedSets(uid()).size(), static_cast<std::size_t>(1));

  CHECK_FALSE(h.repo.sessions[0].finishedAtMs);
}

TEST(export_never_reaches_another_accounts_sets) {
  Harness h;
  h.repo.sessions.push_back(Session{sid("ses_00000002"), uid("u2"), h.clock.now, h.clock.now + 1});
  h.repo.sets.push_back(Set{setId("set_00000002"), sid("ses_00000002"), ExerciseId{"back-squat"}, 1,
                            200, 5, SetKind::working, std::nullopt, "", h.clock.now});

  CHECK_EQ(h.service.exportedSets(uid()).size(), static_cast<std::size_t>(0));
}

// ---- the coach share: one workout, expiring, revocable -------------------------------------

TEST(share_is_idempotent_on_the_session) {
  Harness h;
  h.trained("ses_00000001", h.clock.now - kWeek, 100, 5, 4);

  std::optional<SessionShare> first = h.service.share(uid(), sid("ses_00000001"));
  std::optional<SessionShare> again = h.service.share(uid(), sid("ses_00000001"));

  REQUIRE(first);
  REQUIRE(again);
  CHECK_EQ(first->token, again->token);   // one link, not two capabilities to revoke separately
  CHECK_EQ(first->expiresAtMs, h.clock.now + kShareLifetimeMs);
  CHECK_EQ(h.repo.shares.size(), static_cast<std::size_t>(1));
}

TEST(share_of_an_absent_or_another_accounts_session_is_one_answer) {
  Harness h;
  h.repo.sessions.push_back(Session{sid("ses_00000002"), uid("u2"), h.clock.now, h.clock.now + 1});

  CHECK_FALSE(h.service.share(uid(), sid("ses_00000009")));
  CHECK_FALSE(h.service.share(uid(), sid("ses_00000002")));
  CHECK(h.repo.shares.empty());
}

// Re-sharing a workout a month later is a NEW capability, not the resurrection of one that ended,
// so the link that expired stays dead rather than coming back alive under the same token.
TEST(share_that_has_already_expired_is_replaced_rather_than_returned) {
  Harness h;
  h.trained("ses_00000001", h.clock.now - kWeek, 100, 5, 4);
  std::optional<SessionShare> first = h.service.share(uid(), sid("ses_00000001"));
  REQUIRE(first);
  h.clock.now += kShareLifetimeMs + 1;

  std::optional<SessionShare> minted = h.service.share(uid(), sid("ses_00000001"));

  REQUIRE(minted);
  CHECK(minted->token != first->token);
  CHECK_EQ(h.repo.shares.size(), static_cast<std::size_t>(1));
  CHECK_FALSE(h.service.shared(first->token));
}

TEST(shared_session_resolves_a_live_token_and_names_no_account) {
  Harness h;
  h.trained("ses_00000001", h.clock.now - kWeek, 100, 5, 4);
  std::optional<SessionShare> minted = h.service.share(uid(), sid("ses_00000001"));
  REQUIRE(minted);

  std::optional<SharedSession> read = h.service.shared(minted->token);

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
  std::optional<SessionShare> minted = h.service.share(uid(), sid("ses_00000001"));
  REQUIRE(minted);
  CHECK(h.service.shared(minted->token));

  CHECK(h.service.revokeShare(uid(), sid("ses_00000001")));

  CHECK_FALSE(h.service.shared(minted->token));
  CHECK_FALSE(h.service.shared("a token nobody ever minted"));
  CHECK_FALSE(h.service.revokeShare(uid(), sid("ses_00000001")));   // nothing left to revoke
  CHECK(h.repo.shares.empty());
}

// The end is not inclusive: at the instant it names, the link is already gone.
TEST(shared_session_stops_answering_the_moment_the_share_expires) {
  Harness h;
  h.trained("ses_00000001", h.clock.now - kWeek, 100, 5, 4);
  std::optional<SessionShare> minted = h.service.share(uid(), sid("ses_00000001"));
  REQUIRE(minted);

  h.clock.now = minted->expiresAtMs;

  CHECK_FALSE(h.service.shared(minted->token));
}

// A stranger holding a link must never be able to write to the owner's log — not even the
// four-hour close every signed-in read of it takes.
TEST(shared_session_never_settles_the_owners_open_session) {
  Harness h;
  const std::uint64_t began = h.clock.now - 6 * 3'600'000;
  h.stored("ses_00000001", began, std::nullopt, 100, 5, 2);
  std::optional<SessionShare> minted = h.service.share(uid(), sid("ses_00000001"));
  REQUIRE(minted);

  CHECK(h.service.shared(minted->token));

  CHECK_FALSE(h.repo.sessions[0].finishedAtMs);
}

TEST(revoke_never_reaches_another_accounts_share) {
  Harness h;
  h.repo.sessions.push_back(Session{sid("ses_00000002"), uid("u2"), h.clock.now, h.clock.now + 1});
  h.repo.shares.push_back(
      SessionShare{sid("ses_00000002"), uid("u2"), "theirs", h.clock.now + kShareLifetimeMs});

  CHECK_FALSE(h.service.revokeShare(uid(), sid("ses_00000002")));

  CHECK_EQ(h.repo.shares.size(), static_cast<std::size_t>(1));
  CHECK(h.service.shared("theirs"));   // and it is still live for the account that minted it
}

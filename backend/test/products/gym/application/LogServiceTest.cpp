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

  // The create as the app's own route makes it — the LIFTER's hand, which is the door §M is about
  // and the one that leaves the routine's history naming no agent. The tests that are about an
  // agent's create call the service directly and say which door.
  RoutineWriteOutcome create(const RoutineWrite& incoming) {
    return service.createRoutine(uid(), incoming, std::nullopt);
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

  std::vector<LogRow> logBefore(std::uint64_t beforeMs, int limit = 50) {
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

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 1);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(1));
  CHECK_EQ(listed[0].summary.session.finishedAtMs, std::optional<std::uint64_t>(started));
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

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 1);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(2));
  CHECK_EQ(listed[0].summary.topSet, std::optional<TopWorkingSet>());   // not 0 kg × 0
  CHECK_EQ(listed[1].summary.topSet, std::optional<TopWorkingSet>(TopWorkingSet{100.0, 8}));
}

// The two counts are different numbers on any session that warmed up, and the log screen prints the
// second one: setCount counted the ramp-up while the top set beside it — a working-sets-only pick —
// could not have come from it, so the row said "4 sets" over a number three sets earned. Tonnage
// obeys the same filter, so the caption and the count are about the same rows.
TEST(log_counts_the_working_sets_apart_from_every_set_and_sums_what_they_moved) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.service.append(uid(), sid(),
                   SetWrite{setId("set_00000001"), ExerciseId{"back-squat"}, 60.0, 10,
                            SetKind::warmup, std::nullopt, "", h.clock.now + 1});
  h.service.append(uid(), sid(),
                   SetWrite{setId("set_00000002"), ExerciseId{"back-squat"}, 100.0, 5,
                            SetKind::working, std::nullopt, "", h.clock.now + 2});
  h.service.append(uid(), sid(),
                   SetWrite{setId("set_00000003"), ExerciseId{"back-squat"}, 100.0, 5,
                            SetKind::working, std::nullopt, "", h.clock.now + 3});
  h.service.append(uid(), sid(), h.bench("set_00000004", 82.5, h.clock.now + 4));   // 82.5 × 8
  h.service.finish(uid(), sid(), h.clock.now + 5);

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 10);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(1));
  CHECK_EQ(listed[0].summary.setCount, 4);
  CHECK_EQ(listed[0].summary.workingSetCount, 3);
  CHECK_EQ(listed[0].summary.tonnageKg, 100.0 * 5 + 100.0 * 5 + 82.5 * 8);   // the warmup is not in
}

// Band-assisted work logs a NEGATIVE load, and an unclamped sum would let it subtract from a week
// somebody trained — the exact arithmetic gym refuses volume for. An assisted set moved no external
// load, so it adds nothing, and a session holding only such sets sums to zero: a real answer that
// means "nothing here moved a measurable load", which every surface draws as nothing at all.
TEST(log_gives_an_assisted_or_bodyweight_set_no_tonnage_rather_than_letting_it_subtract) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.service.append(uid(), sid(),
                   SetWrite{setId("set_00000001"), ExerciseId{"back-squat"}, 100.0, 5,
                            SetKind::working, std::nullopt, "", h.clock.now + 1});
  h.service.append(uid(), sid(),
                   SetWrite{setId("set_00000002"), ExerciseId{"bench-press"}, -20.0, 10,
                            SetKind::working, std::nullopt, "", h.clock.now + 2});
  h.service.finish(uid(), sid(), h.clock.now + 3);
  h.clock.now += 10'000;
  h.startAt(h.clock.now, "ses_00000002");
  h.service.append(uid(), sid("ses_00000002"),
                   SetWrite{setId("set_00000003"), ExerciseId{"bench-press"}, 0.0, 9,
                            SetKind::working, std::nullopt, "", h.clock.now + 1});
  h.service.finish(uid(), sid("ses_00000002"), h.clock.now + 2);

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 10);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(2));
  CHECK_EQ(listed[0].summary.workingSetCount, 1);
  CHECK_EQ(listed[0].summary.tonnageKg, 0.0);          // chin-ups moved no measurable load
  CHECK_EQ(listed[1].summary.workingSetCount, 2);
  CHECK_EQ(listed[1].summary.tonnageKg, 500.0);        // the assisted set took nothing away
}

// The split the row is built on: the store hands over the loads a session worked, the domain's
// Epley runs over them here, and no client ever computes a second copy. It is absent exactly where
// Epley is undefined — every working set at or below zero has no honest one-rep estimate — and the
// top set stays, so an unloaded movement still prints a load with no invented number over it.
TEST(log_puts_the_domains_estimate_on_the_row_and_omits_it_where_there_is_no_estimate) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.service.append(uid(), sid(),
                   SetWrite{setId("set_00000001"), ExerciseId{"back-squat"}, 100.0, 5,
                            SetKind::working, std::nullopt, "", h.clock.now + 1});
  h.service.finish(uid(), sid(), h.clock.now + 2);
  h.clock.now += 10'000;
  h.startAt(h.clock.now, "ses_00000002");
  h.service.append(uid(), sid("ses_00000002"),
                   SetWrite{setId("set_00000002"), ExerciseId{"bench-press"}, 0.0, 9,
                            SetKind::working, std::nullopt, "", h.clock.now + 1});
  h.service.finish(uid(), sid("ses_00000002"), h.clock.now + 2);
  h.clock.now += 10'000;
  h.startAt(h.clock.now, "ses_00000003");   // warmed up and nothing else
  h.service.append(uid(), sid("ses_00000003"),
                   SetWrite{setId("set_00000003"), ExerciseId{"bench-press"}, 40.0, 10,
                            SetKind::warmup, std::nullopt, "", h.clock.now + 1});
  h.service.finish(uid(), sid("ses_00000003"), h.clock.now + 2);

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 10);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(3));
  CHECK_EQ(listed[0].summary.topSet, std::optional<TopWorkingSet>());
  CHECK_EQ(listed[0].topE1rm, std::optional<double>());
  CHECK_EQ(listed[1].summary.topSet, std::optional<TopWorkingSet>(TopWorkingSet{0.0, 9}));
  CHECK_EQ(listed[1].topE1rm, std::optional<double>());
  CHECK_EQ(listed[2].summary.topSet, std::optional<TopWorkingSet>(TopWorkingSet{100.0, 5}));
  CHECK_EQ(listed[2].topE1rm, e1rm(100.0, 5));         // 116.7, and the one copy that computes it
}

// The ordinary top-set-and-back-offs session, and the reason the row cannot run Epley on `topSet`:
// the heaviest set is 100 × 5 and the best estimate belongs to a lighter one. The row and the finish
// screen come through the same `topE1rmOf`, so they answer with one number — the log said 116.7
// under a finish screen saying 126.7 until 2026-08-12, on one session, two taps apart.
TEST(log_and_the_finish_screen_agree_on_a_session_whose_back_offs_beat_its_top_set) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.service.append(uid(), sid(),
                   SetWrite{setId("set_00000001"), ExerciseId{"back-squat"}, 100.0, 5,
                            SetKind::working, std::nullopt, "", h.clock.now + 1});
  for (int number = 2; number <= 4; ++number)
    h.service.append(uid(), sid(),
                     SetWrite{setId("set_0000000" + std::to_string(number)),
                              ExerciseId{"back-squat"}, 95.0, 10, SetKind::working, std::nullopt,
                              "", h.clock.now + static_cast<std::uint64_t>(number)});
  h.service.finish(uid(), sid(), h.clock.now + 5);

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 10);
  std::optional<Review> finished = h.service.review(uid(), sid());

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(1));
  // The store still picks the HEAVIEST set — that is an ordering and it has its own readers — and
  // the estimate beside it is the session's, off the back-offs the heaviest set did not earn.
  CHECK_EQ(listed[0].summary.topSet, std::optional<TopWorkingSet>(TopWorkingSet{100.0, 5}));
  CHECK_EQ(listed[0].topE1rm, e1rm(95.0, 10));         // 126.7, not the top set's 116.7
  CHECK_EQ(listed[0].topE1rm, finished->stats.topE1rm);
  CHECK(e1rm(95.0, 10) > e1rm(100.0, 5));              // the two really do disagree
}

// The store hands over one row per LOAD carrying the best reps at it, not one row per set, and that
// projection is only sound because Epley rises with reps at a fixed load. Three sets at 95 collapse
// to the ten-rep one, and the estimate is the same number a walk over all three would have found.
TEST(log_reads_the_stores_per_load_projection_and_lands_where_a_walk_over_every_set_would) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.service.append(uid(), sid(),
                   SetWrite{setId("set_00000001"), ExerciseId{"back-squat"}, 95.0, 6,
                            SetKind::working, std::nullopt, "", h.clock.now + 1});
  h.service.append(uid(), sid(),
                   SetWrite{setId("set_00000002"), ExerciseId{"back-squat"}, 95.0, 10,
                            SetKind::working, std::nullopt, "", h.clock.now + 2});
  h.service.append(uid(), sid(),
                   SetWrite{setId("set_00000003"), ExerciseId{"back-squat"}, 95.0, 8,
                            SetKind::working, std::nullopt, "", h.clock.now + 3});
  h.service.append(uid(), sid(),
                   SetWrite{setId("set_00000004"), ExerciseId{"bench-press"}, 60.0, 12,
                            SetKind::warmup, std::nullopt, "", h.clock.now + 4});
  h.service.finish(uid(), sid(), h.clock.now + 5);

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 10);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(1));
  // One load, its best reps, and the warmup nowhere in it — a ramp-up is not what a session was.
  // Dated by the SESSION's start rather than by the set that hit those reps: a store's mark belongs
  // to the workout, not to whatever the device's clock said mid-set (domain/Review.h).
  CHECK_EQ(listed[0].summary.workingMarks,
           (std::vector<PriorMark>{PriorMark{ExerciseId{"back-squat"}, 95.0, 10, h.clock.now}}));
  CHECK_EQ(listed[0].topE1rm, e1rm(95.0, 10));
  CHECK_EQ(topE1rmOf(std::vector<PriorMark>{PriorMark{ExerciseId{"back-squat"}, 95.0, 6, 1},
                                            PriorMark{ExerciseId{"back-squat"}, 95.0, 10, 2},
                                            PriorMark{ExerciseId{"back-squat"}, 95.0, 8, 3}}),
           listed[0].topE1rm);
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

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 1);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(2));
  CHECK_EQ(listed[0].summary.session.finishedAtMs, std::optional<std::uint64_t>(abandoned));
  CHECK(listed[0].summary.closedItself);
  CHECK_EQ(listed[1].summary.session.finishedAtMs,
           std::optional<std::uint64_t>(started + 3'600'000));
  CHECK_FALSE(listed[1].summary.closedItself);
}

// A session left running is not closed by anything yet, and a setless one the rule ended reads as
// its own start — the other branch of autoCloseAt, and the other half of the inference.
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

// Two sessions sharing a start instant across a page edge: on a cursor of the instant alone the
// second one is in no page, ever. The compound cursor walks the whole log.
TEST(log_pages_across_a_tied_start_instant_without_losing_a_session) {
  Harness h;
  const std::uint64_t tied = h.clock.now;
  h.repo.sessions.push_back(Session{sid("ses_00000001"), uid(), tied + 3, tied + 4});
  h.repo.sessions.push_back(Session{sid("ses_00000002"), uid(), tied + 2, tied + 4});
  h.repo.sessions.push_back(Session{sid("ses_00000003"), uid(), tied + 2, tied + 4});
  h.repo.sessions.push_back(Session{sid("ses_00000004"), uid(), tied + 1, tied + 4});

  std::vector<LogRow> first = h.service.log(uid(), LogCursor{tied + 9, std::nullopt, 2});
  std::vector<LogRow> second =
      h.service.log(uid(), LogCursor{first.back().summary.session.startedAtMs,
                                     first.back().summary.session.id, 2});
  std::vector<LogRow> third =
      h.service.log(uid(), LogCursor{second.back().summary.session.startedAtMs,
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
  std::vector<LogRow> listed = h.logBefore(h.clock.now + 10'000);

  CHECK(last.error == LastTimeError::none);
  CHECK_EQ(last.lastTime->session.id, sid("ses_00000002"));
  CHECK_EQ(last.lastTime->sets, std::vector<Set>{*yesterday.set});
  // The two reads agree about which session is newest, because both sort on the same key.
  CHECK_EQ(listed[0].summary.session.id, last.lastTime->session.id);
}

// The name is read off the session's own frozen snapshot, never off gym_routines: the prefill card
// names the day of the program that session WAS, as it was called then. A routine renamed — or
// deleted outright — since must not rewrite what the log says about the past.
TEST(last_time_names_the_routine_the_session_was_trained_under_not_the_one_stored_today) {
  Harness h;
  h.create(h.pushAWrite());
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

  RoutineWriteOutcome created = h.create(h.pushAWrite({benchEntry(1), RoutineEntry{2, ExerciseId{"back-squat"}, 3, 8,
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
  RoutineWriteOutcome first = h.create(h.pushAWrite());

  RoutineWriteOutcome replayed = h.create(h.pushAWrite({benchEntry(1), benchEntry(2)}, "rt_00000001", "Renamed mid-flight"));

  CHECK(replayed.error == RoutineWriteError::none);
  CHECK_EQ(*replayed.routine, *first.routine);
  CHECK_EQ(h.repo.routineRows.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.routineRows[0].entries.size(), static_cast<std::size_t>(1));
}

TEST(create_routine_with_an_id_another_account_holds_is_id_taken) {
  Harness h;
  h.repo.routineRows.push_back(Routine{rtId(), uid("u2"), "Their plan", 0, {benchEntry()}});

  RoutineWriteOutcome created = h.create(h.pushAWrite());

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

  RoutineWriteOutcome created = h.create(h.pushAWrite({benchEntry(1), RoutineEntry{2, ExerciseId{"zercher-squat"}, 3, 8,
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

  RoutineWriteOutcome created = h.create(h.pushAWrite({theirs}));
  h.create(h.pushAWrite());
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
  h.create(h.pushAWrite());

  RoutineWriteOutcome replaced = h.service.replaceRoutine(
      uid(), rtId(),
      h.pushAWrite({RoutineEntry{1, ExerciseId{"back-squat"}, 4, 6, 100.0, 240}, benchEntry(2)},
                   "rt_00000001", "Push A2"));

  CHECK(replaced.error == RoutineWriteError::none);
  // The revision moves on a write that changes the document, which is what a proposal is minted
  // against and superseded by (domain/Proposal.h).
  CHECK_EQ(*replaced.routine,
           Routine(rtId(), uid(), "Push A2", 0,
                   {RoutineEntry{1, ExerciseId{"back-squat"}, 4, 6, 100.0, 240}, benchEntry(2)},
                   std::nullopt, 2));
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
  h.create(h.pushAWrite());
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
  h.create(h.pushAWrite({benchEntry()}, "rt_00000001", "Push A"));
  h.create(h.pushAWrite({benchEntry()}, "rt_00000002", "Pull A"));
  h.create(h.pushAWrite({benchEntry()}, "rt_00000003", "Legs"));
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

// A routine built at the kitchen table is savable while it is still incomplete: the open line is
// stored as naming nothing and FREEZES as naming nothing, so the session it starts asks at the rack
// rather than reading a target nobody typed. It is the difference between `3 × 5` and `you decide`,
// and the snapshot is where it would have been lost.
TEST(a_routine_saves_with_an_open_line_and_freezes_it_open) {
  Harness h;
  h.repo.seed(Exercise{ExerciseId{"barbell-row"}, "Barbell Row", Pattern::pull, Equipment::barbell,
                       2.5, false});
  RoutineWriteOutcome created =
      h.create(h.pushAWrite({benchEntry(1), RoutineEntry{2, ExerciseId{"barbell-row"}, std::nullopt,
                                                         std::nullopt, std::nullopt, std::nullopt}}));
  // UNTESTED until its first session, and that is an absence rather than a flag: it needs nothing
  // written to become true and nothing unwritten to stop being true.
  const std::optional<std::uint64_t> beforeItRan = h.service.routines(uid())[0].lastTrainedAtMs;

  StartOutcome started = h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");

  CHECK(created.error == RoutineWriteError::none);
  CHECK_EQ(created.routine->entries[1].targetSets, std::optional<int>());
  CHECK_EQ(started.session->plan,
           std::optional<PlanSnapshot>(PlanSnapshot{
               "Push A",
               {PlanEntry{ExerciseId{"bench-press"}, 5, 5, 82.5, 180},
                PlanEntry{ExerciseId{"barbell-row"}, std::nullopt, std::nullopt, std::nullopt,
                          std::nullopt}}}));
  CHECK_EQ(beforeItRan, std::optional<std::uint64_t>());
  // And the first session is what ends it — the badge is off the moment the day is trained, with
  // nothing to write and nothing that could be left standing after a discard.
  CHECK_EQ(h.service.routines(uid())[0].lastTrainedAtMs,
           std::optional<std::uint64_t>(h.clock.now));
  h.service.finish(uid(), sid("ses_00000001"), h.clock.now + 1);
  h.service.discard(uid(), sid("ses_00000001"));
  CHECK_EQ(h.service.routines(uid())[0].lastTrainedAtMs, std::optional<std::uint64_t>());
}

// The day's own history, and the row §M30 draws at the bottom of it: when it was built, by whom,
// and how many movements it was built with. The lifter's own hand names no door, and that absence
// is what the screen reads as `created by you`.
TEST(a_routine_built_by_hand_carries_its_creation_in_its_history) {
  Harness h;
  h.create(h.pushAWrite({benchEntry(1), RoutineEntry{2, ExerciseId{"back-squat"}, 3, 8,
                                                     std::nullopt, std::nullopt}}));

  const std::vector<RoutineEvent> history = h.service.routineHistory(uid(), rtId());

  REQUIRE_EQ(history.size(), static_cast<std::size_t>(1));
  CHECK(history[0].kind == RoutineEventKind::created);
  CHECK_EQ(history[0].atMs, h.clock.now);
  CHECK_EQ(history[0].door, std::optional<ProposalDoor>());
  CHECK_EQ(history[0].movements, std::optional<int>(2));
  CHECK_EQ(history[0].proposal, std::optional<ProposalHead>());
  // Another account's routine has no history at all, which is the one fact every read here gives.
  CHECK(h.service.routineHistory(uid("u2"), rtId()).empty());
}

// A day an AGENT typed says so. `create_routine` is a real door onto this table — a routine that
// does not exist yet takes nothing away, so it lands immediately rather than as a proposal — and a
// history that said `created by you` about it would be putting words in a lifter's mouth.
TEST(a_routine_an_agent_created_names_the_door_it_came_through) {
  Harness h;
  h.service.createRoutine(uid(), h.pushAWrite(), ProposalDoor::mcp);

  const std::vector<RoutineEvent> history = h.service.routineHistory(uid(), rtId());

  REQUIRE_EQ(history.size(), static_cast<std::size_t>(1));
  CHECK_EQ(history[0].door, std::optional<ProposalDoor>(ProposalDoor::mcp));
}

// ---- start from a routine: the server freezes the plan --------------------------------------

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
  CHECK_EQ(h.repo.sessions[0], *started.session);
}

// `Chin-up 3 × max`, from the write to the frozen copy: a line that names no rep target is stored
// as naming none and freezes as naming none, so the logger asks for nothing rather than for zero.
TEST(a_routine_line_with_no_rep_target_survives_the_write_and_the_freeze) {
  Harness h;
  h.repo.seed(Exercise{ExerciseId{"chin-up"}, "Chin-up", Pattern::pull, Equipment::bodyweight, 2.5,
                       false});
  RoutineWriteOutcome created = h.create(h.pushAWrite({RoutineEntry{1, ExerciseId{"chin-up"}, 3, std::nullopt, std::nullopt,
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
  CHECK_EQ(h.repo.sessions.size(), static_cast<std::size_t>(1));
}

// The same rule reached the other way: a replay of the caller's OWN id answers with the session as
// it is stored, so the plan it was started under outlives a body that has since changed its mind.
TEST(start_replay_keeps_the_plan_the_session_was_started_under) {
  Harness h;
  h.create(h.pushAWrite({benchEntry()}, "rt_00000001", "Push A"));
  h.create(h.pushAWrite({benchEntry()}, "rt_00000002", "Legs"));
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
  h.create(h.pushAWrite({benchEntry()}, "rt_00000001", "Push A"));
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
  h.create(h.pushAWrite({benchEntry()}, "rt_00000001", "Push A"));
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
  RoutineWriteOutcome created = h.create(h.pushAWrite({RoutineEntry{1, ExerciseId{"ex_11111111"}, 3, 8, 60.0, 120}}));
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

  // The beaten mark is dated by the SESSION that set it — the day the record line prints beside the
  // number, and not the instant a device stamped on the set inside it (domain/Review.h).
  const PersonalRecord estimate{RecordKind::e1rm, ExerciseId{"back-squat"}, 122.5, 105.0, 5, 116.7,
                                h.clock.now - 2 * kWeek};
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
  h.create(h.pushAWrite({RoutineEntry{1, ExerciseId{"back-squat"}, 5, 5, 100.0, 180}}));
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

// ---- the log's gold dot, the rename, and a movement's record ---------------------------------

// The dot walks the page forward: the first squat day claims nothing (no mark to pass), the second
// beats it, the third repeats what stands. The page comes back newest first and the walk does not
// reorder it.
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

// A page is judged against the history in front of it, not against itself: the same session that
// claimed nothing as the first row of a page earns the dot once the page before it exists — the
// store's standing marks are what carry that across the page edge.
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

// The two halves of one history, filtered the same way. The page carries the OPEN workout as a row;
// the marks standing before the page — and the finish read of every session — count FINISHED ones
// alone. A page is not sorted by finishedness: started_at is the device's, one-open-at-a-time is
// the only rule, and a queued offline start flushed after a later session finished puts the open row
// in the middle. Fold it and the row above is judged against 110 × 5 that its own finish screen
// cannot see, and a real record goes dark on the log while the finish screen still prints it.
TEST(a_still_open_workout_on_the_page_never_stands_under_the_row_above_it) {
  Harness h;
  h.stored("ses_00000001", h.clock.now, h.clock.now + 3'600'000, 100, 5, 4);
  h.stored("ses_00000002", h.clock.now + kWeek, std::nullopt, 110, 5, 4);   // never finished
  h.stored("ses_00000003", h.clock.now + 2 * kWeek, h.clock.now + 2 * kWeek + 3'600'000, 105, 5, 4);

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 3 * kWeek);
  std::optional<Review> finish = h.service.review(uid(), sid("ses_00000003"));

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(3));
  REQUIRE(finish.has_value());
  CHECK_EQ(listed[0].summary.session.id, sid("ses_00000003"));
  CHECK_EQ(listed[0].record, finish->record.has_value());   // the row and the screen, one judgement
  CHECK(listed[0].record);
  // The open workout is judged like any other row — its own finish screen judges it mid-session —
  // and the first day claims nothing, having passed no mark.
  CHECK_EQ(listed[1].summary.session.id, sid("ses_00000002"));
  CHECK(listed[1].record);
  CHECK_FALSE(listed[2].record);
}

// A three-set session says nothing on its finish screen, so it says nothing on its row either.
TEST(a_slight_session_gets_no_dot_however_heavy_it_was) {
  Harness h;
  h.trained("ses_00000001", h.clock.now, 100, 5, 4);
  h.trained("ses_00000002", h.clock.now + kWeek, 140, 5, kSlightWorkingSets - 1);

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 2 * kWeek);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(2));
  CHECK_EQ(listed[0].summary.session.id, sid("ses_00000002"));
  CHECK_FALSE(listed[0].record);
}

// THE HAZARD, in one case: a seed is a global row, so renaming one may not touch what any other
// account sees. The caller reads their own name back; the stranger reads the seed's.
TEST(renaming_a_seed_is_this_accounts_alone_and_the_id_never_moves) {
  Harness h;
  h.trained("ses_00000001", h.clock.now, 100, 5, 4);

  std::optional<Exercise> renamed = h.service.renameExercise(uid(), ExerciseId{"back-squat"},
                                                             "Low-bar Squat");

  REQUIRE(renamed.has_value());
  CHECK_EQ(renamed->id, ExerciseId{"back-squat"});
  CHECK_EQ(renamed->name, std::string("Low-bar Squat"));
  CHECK_EQ(renamed->custom, false);
  // What the catalog says to each account, which is the whole of the hazard.
  CHECK_EQ(h.service.catalog(uid())[1].name, std::string("Low-bar Squat"));
  CHECK_EQ(h.service.catalog(uid("u2"))[1].name, std::string("Back Squat"));
  // And the history is whole: the log row still names the movement, under its new name.
  std::vector<LogRow> listed = h.logBefore(h.clock.now + kWeek);
  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(1));
  CHECK_EQ(listed[0].summary.exerciseNames, std::vector<std::string>{"Low-bar Squat"});
}

// Renaming back to the seed's own name clears the line rather than storing a copy of it: an
// override that says nothing is not an override.
TEST(renaming_a_seed_back_to_its_own_name_clears_the_line) {
  Harness h;
  h.service.renameExercise(uid(), ExerciseId{"back-squat"}, "Low-bar Squat");

  std::optional<Exercise> restored =
      h.service.renameExercise(uid(), ExerciseId{"back-squat"}, "Back Squat");

  REQUIRE(restored.has_value());
  CHECK_EQ(restored->name, std::string("Back Squat"));
  CHECK(h.repo.displayNames.empty());
}

// A movement the caller created is their own row and renames in place — no line, nothing global.
TEST(renaming_a_movement_of_your_own_edits_its_row) {
  Harness h;
  h.service.createExercise(uid(), ExerciseWrite{ExerciseId{"ex_00000001"}, "Zercher Squat",
                                                Pattern::squat, Equipment::barbell, std::nullopt});

  std::optional<Exercise> renamed =
      h.service.renameExercise(uid(), ExerciseId{"ex_00000001"}, "Zercher");

  REQUIRE(renamed.has_value());
  CHECK_EQ(renamed->name, std::string("Zercher"));
  CHECK_EQ(renamed->custom, true);
  CHECK(h.repo.displayNames.empty());
}

// Absent, and another lifter's private movement, are the one fact — and a name the store could not
// hold is refused where every other value is, by constructing the entity.
TEST(a_rename_refuses_a_movement_this_account_cannot_see_and_a_name_it_cannot_hold) {
  Harness h;
  h.repo.seedCustom(uid("u2"), Exercise{ExerciseId{"ex_00000002"}, "Theirs", Pattern::squat,
                                        Equipment::barbell, 2.5, true});

  CHECK_EQ(h.service.renameExercise(uid(), ExerciseId{"ex_00000002"}, "Mine"), std::nullopt);
  CHECK_EQ(h.service.renameExercise(uid(), ExerciseId{"no-such"}, "Mine"), std::nullopt);
  bool refused = false;
  try {
    h.service.renameExercise(uid(), ExerciseId{"back-squat"}, std::string(kMaxNameLength + 1, 'x'));
  } catch (const InvalidTraining&) {
    refused = true;
  }
  CHECK(refused);
  // A name of nothing but blanks is the empty name in disguise, and it landed until 2026-08-12 —
  // the movement then had no name to find it by anywhere it was drawn.
  bool blankRefused = false;
  try {
    h.service.renameExercise(uid(), ExerciseId{"back-squat"}, "   ");
  } catch (const InvalidTraining&) {
    blankRefused = true;
  }
  CHECK(blankRefused);
  CHECK(h.repo.displayNames.empty());
}

// The record page, end to end through the service: the tiles and the ladder off the sessions, the
// count off the routines that name it, and the movement under the name this account gave it.
TEST(a_movements_record_answers_the_whole_page_from_one_read) {
  Harness h;
  h.create(h.pushAWrite({RoutineEntry{1, ExerciseId{"back-squat"}, 5, 5, 100.0, 180}}));
  h.trained("ses_00000001", h.clock.now, 100, 5, 4);
  h.trained("ses_00000002", h.clock.now + kWeek, 105, 5, 4);
  h.service.renameExercise(uid(), ExerciseId{"back-squat"}, "Low-bar Squat");

  std::optional<MovementRecord> page = h.service.movementRecord(uid(), ExerciseId{"back-squat"});

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

// A movement in the catalog nobody has lifted answers with its counts at zero and nothing else —
// a fact, not a fault, and the sentence the picker draws as `never logged`. A movement no catalog
// holds is the different answer.
TEST(a_record_of_a_movement_never_lifted_is_empty_and_of_an_unknown_one_is_absent) {
  Harness h;

  std::optional<MovementRecord> page = h.service.movementRecord(uid(), ExerciseId{"bench-press"});

  REQUIRE(page.has_value());
  CHECK_EQ(page->sessions, 0);
  CHECK(page->routines.empty());
  CHECK_EQ(page->bestE1rm, std::nullopt);
  CHECK(page->series.empty());
  CHECK_EQ(h.service.movementRecord(uid(), ExerciseId{"no-such"}), std::nullopt);
}

// ---- the fix: the log moves, the routine does not -------------------------------------------

TEST(a_fix_rewrites_the_stored_set_and_keeps_the_version_it_replaced) {
  Harness h;
  h.startAt(h.clock.now);
  h.service.append(uid(), sid(), h.bench("set_00000001", 82.5, h.clock.now + 60'000));
  SetFix fix;
  fix.weightKg = 80.0;
  fix.reps = 5;

  std::optional<Set> fixed = h.service.fixSet(uid(), sid(), setId("set_00000001"), fix);

  REQUIRE(fixed.has_value());
  CHECK_EQ(*fixed, Set(setId("set_00000001"), sid(), ExerciseId{"bench-press"}, 1, 80.0, 5,
                       SetKind::working, std::nullopt, "", h.clock.now + 60'000));
  CHECK_EQ(h.repo.sets, std::vector<Set>{*fixed});
  REQUIRE_EQ(h.repo.kept.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.kept[0],
           (FakeTrainingRepository::KeptSet{
               Set{setId("set_00000001"), sid(), ExerciseId{"bench-press"}, 1, 82.5, 8,
                   SetKind::working, std::nullopt, "", h.clock.now + 60'000},
               false}));
}

// A correction assigns absolute values, so sending it again is sending the same values again: the
// second reply is the first, and the only trace is the second version kept beside the first.
TEST(a_replayed_fix_answers_the_same_row) {
  Harness h;
  h.startAt(h.clock.now);
  h.service.append(uid(), sid(), h.bench("set_00000001", 82.5, h.clock.now + 60'000));
  SetFix fix;
  fix.weightKg = 80.0;

  std::optional<Set> first = h.service.fixSet(uid(), sid(), setId("set_00000001"), fix);
  std::optional<Set> replayed = h.service.fixSet(uid(), sid(), setId("set_00000001"), fix);

  CHECK_EQ(first, replayed);
  CHECK_EQ(h.repo.sets.size(), static_cast<std::size_t>(1));
}

// Absent, another account's, and this account's set in a DIFFERENT workout are one answer — a set
// id that resolved anywhere the caller could reach would be a way to walk one workout from another.
TEST(a_fix_reaches_no_set_outside_the_workout_the_path_names) {
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.service.append(uid(), sid("ses_00000001"), h.bench("set_00000001", 82.5, h.clock.now + 60'000));
  h.service.finish(uid(), sid("ses_00000001"), h.clock.now + 3'600'000);
  h.startAt(h.clock.now + 4'000'000, "ses_00000002");
  h.repo.sessions.push_back(Session{sid("ses_00000009"), uid("u2"), h.clock.now});
  h.repo.sets.push_back(Set{setId("set_00000009"), sid("ses_00000009"), ExerciseId{"bench-press"},
                            1, 100.0, 3, SetKind::working, std::nullopt, "", h.clock.now});
  SetFix fix;
  fix.weightKg = 60.0;

  CHECK_EQ(h.service.fixSet(uid(), sid("ses_00000002"), setId("set_00000001"), fix), std::nullopt);
  CHECK_EQ(h.service.fixSet(uid(), sid("ses_00000001"), setId("set_99999999"), fix), std::nullopt);
  CHECK_EQ(h.service.fixSet(uid(), sid("ses_00000009"), setId("set_00000009"), fix), std::nullopt);
  CHECK_EQ(h.repo.sets[0].weightKg, 82.5);
  CHECK_EQ(h.repo.sets[1].weightKg, 100.0);
  CHECK(h.repo.kept.empty());
}

// A lifter reads the log AFTER the workout, which is exactly when they see the 4 they meant to log
// as a 5. So a finished session is correctable — the one refusal this route does NOT have.
TEST(a_finished_workout_is_still_correctable) {
  Harness h;
  h.startAt(h.clock.now);
  h.service.append(uid(), sid(), h.bench("set_00000001", 82.5, h.clock.now + 60'000));
  h.service.finish(uid(), sid(), h.clock.now + 3'600'000);
  SetFix fix;
  fix.reps = 5;

  std::optional<Set> fixed = h.service.fixSet(uid(), sid(), setId("set_00000001"), fix);

  REQUIRE(fixed.has_value());
  CHECK_EQ(fixed->reps, 5);
}

// The delete: the set leaves the live log and moves whole into the kept rows, marked. Nothing a
// lifter logged is destroyed — and nothing anywhere offers it back, which is why the mark exists
// for the promise rather than for a screen.
TEST(a_deleted_set_leaves_the_log_and_is_kept_marked_deleted) {
  Harness h;
  h.startAt(h.clock.now);
  h.service.append(uid(), sid(), h.bench("set_00000001", 82.5, h.clock.now + 60'000));
  h.service.append(uid(), sid(), h.bench("set_00000002", 85.0, h.clock.now + 120'000));

  h.service.deleteSet(uid(), sid(), setId("set_00000001"));

  REQUIRE_EQ(h.repo.sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.sets[0].id, setId("set_00000002"));
  REQUIRE_EQ(h.repo.kept.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.kept[0],
           (FakeTrainingRepository::KeptSet{
               Set{setId("set_00000001"), sid(), ExerciseId{"bench-press"}, 1, 82.5, 8,
                   SetKind::working, std::nullopt, "", h.clock.now + 60'000},
               true}));
}

// The delete's whole idempotency story, and the reason it answers nothing: a client whose reply was
// lost sends it again. A second delete keeps no second copy, and another account's set is untouched.
TEST(deleting_a_set_twice_is_the_same_silence_and_reaches_nobody_elses) {
  Harness h;
  h.startAt(h.clock.now);
  h.service.append(uid(), sid(), h.bench("set_00000001", 82.5, h.clock.now + 60'000));
  h.repo.sessions.push_back(Session{sid("ses_00000009"), uid("u2"), h.clock.now});
  h.repo.sets.push_back(Set{setId("set_00000009"), sid("ses_00000009"), ExerciseId{"bench-press"},
                            1, 100.0, 3, SetKind::working, std::nullopt, "", h.clock.now});

  h.service.deleteSet(uid(), sid(), setId("set_00000001"));
  h.service.deleteSet(uid(), sid(), setId("set_00000001"));
  h.service.deleteSet(uid(), sid("ses_00000009"), setId("set_00000009"));

  CHECK_EQ(h.repo.sets, std::vector<Set>{Set(setId("set_00000009"), sid("ses_00000009"),
                                             ExerciseId{"bench-press"}, 1, 100.0, 3,
                                             SetKind::working, std::nullopt, "", h.clock.now)});
  CHECK_EQ(h.repo.kept.size(), static_cast<std::size_t>(1));
}

// THE REPLAY THAT WOULD UNDO A DELETE, and it is the ordinary one: a POST whose 200 was lost stays
// on the device's queue and goes again, or a claim replays the device's own log. `setOf` reads the
// rows that STAND, so it resolves to nothing here — the append falls through to the insert, and on
// the primary key alone the id is free and the set lands again under a fresh number. `deleted` is
// the store's refusal for it, and it is not `idTaken` for the reason that word exists: every queue
// repairs a spent id by minting a new one, which is exactly how the deletion would undo itself.
TEST(a_deleted_set_is_never_logged_again_by_the_queue_that_replays_it) {
  Harness h;
  h.startAt(h.clock.now);
  h.service.append(uid(), sid(), h.bench("set_00000001", 80.0, h.clock.now + 60'000));
  h.service.append(uid(), sid(), h.bench("set_00000002", 82.5, h.clock.now + 120'000));
  h.service.deleteSet(uid(), sid(), setId("set_00000002"));

  AppendOutcome replayed =
      h.service.append(uid(), sid(), h.bench("set_00000002", 82.5, h.clock.now + 120'000));

  CHECK_EQ(replayed.set, std::optional<Set>());
  CHECK(replayed.error == AppendError::deleted);
  CHECK_EQ(h.repo.sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.sets[0].id, setId("set_00000001"));
  CHECK_EQ(h.repo.kept.size(), static_cast<std::size_t>(1));
  // And it stays refused after the workout ends, under its own word — `session-finished` would tell
  // the queue this set never reached the log, and it reached it and was taken out by hand.
  h.service.finish(uid(), sid(), h.clock.now + 300'000);
  CHECK(h.service.append(uid(), sid(), h.bench("set_00000002", 82.5, h.clock.now + 120'000)).error ==
        AppendError::deleted);
  CHECK_EQ(h.repo.sets.size(), static_cast<std::size_t>(1));
}

// A CORRECTION THAT MOVED NOTHING KEEPS NOTHING. `{}` is a legal fix and the reply to a lost one is
// the same bytes again, so a copy taken unconditionally would grow a version per retry standing for
// a change nobody made — in a table nothing reads and nothing prunes.
TEST(a_fix_that_changes_nothing_answers_the_row_and_keeps_no_version_of_it) {
  Harness h;
  h.startAt(h.clock.now);
  h.service.append(uid(), sid(), h.bench("set_00000001", 82.5, h.clock.now + 60'000));

  for (int retry = 0; retry < 4; ++retry) {
    std::optional<Set> answered = h.service.fixSet(uid(), sid(), setId("set_00000001"), SetFix{});
    REQUIRE(answered.has_value());
    CHECK_EQ(answered->weightKg, 82.5);
  }
  CHECK_EQ(h.repo.kept.size(), static_cast<std::size_t>(0));

  SetFix moves;
  moves.weightKg = 90.0;
  h.service.fixSet(uid(), sid(), setId("set_00000001"), moves);
  REQUIRE_EQ(h.repo.kept.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.kept[0].set.weightKg, 82.5);
  CHECK_FALSE(h.repo.kept[0].deleted);
}

// Numbers are not closed up behind a delete, and that is the rule max+1 numbering was chosen for:
// deleting set 2 of 3 leaves 1 and 3, and the next set is 4. count+1 would mint a second 3.
TEST(a_delete_leaves_the_numbers_alone_and_the_next_set_never_reuses_one) {
  Harness h;
  h.startAt(h.clock.now);
  h.service.append(uid(), sid(), h.bench("set_00000001", 80.0, h.clock.now + 60'000));
  h.service.append(uid(), sid(), h.bench("set_00000002", 82.5, h.clock.now + 120'000));
  h.service.append(uid(), sid(), h.bench("set_00000003", 85.0, h.clock.now + 180'000));

  h.service.deleteSet(uid(), sid(), setId("set_00000002"));
  AppendOutcome next = h.service.append(uid(), sid(), h.bench("set_00000004", 87.5,
                                                              h.clock.now + 240'000));

  REQUIRE(next.set.has_value());
  CHECK_EQ(next.set->setNumber, 4);
  std::vector<int> numbers;
  for (const Set& set : h.repo.sets) numbers.push_back(set.setNumber);
  CHECK_EQ(numbers, (std::vector<int>{1, 3, 4}));
}

// The caption of the whole screen, proved rather than trusted: *Push A keeps its own numbers.* A
// correction and a delete both run against a session started from a routine, and neither the frozen
// snapshot on the session nor the routine's own entries move a byte.
TEST(fixing_and_deleting_a_set_never_touch_the_frozen_plan_or_the_routine) {
  Harness h;
  h.create(h.pushAWrite());
  h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  h.service.append(uid(), sid(), h.bench("set_00000001", 82.5, h.clock.now + 60'000));
  h.service.append(uid(), sid(), h.bench("set_00000002", 82.5, h.clock.now + 120'000));
  const std::optional<PlanSnapshot> frozen = h.repo.sessions[0].plan;
  const std::vector<RoutineEntry> planned = h.repo.routineRows[0].entries;
  REQUIRE(frozen.has_value());

  SetFix fix;
  fix.weightKg = 60.0;
  fix.reps = 3;
  h.service.fixSet(uid(), sid(), setId("set_00000001"), fix);
  h.service.deleteSet(uid(), sid(), setId("set_00000002"));

  CHECK_EQ(h.repo.sessions[0].plan, frozen);
  CHECK_EQ(*h.repo.sessions[0].plan,
           (PlanSnapshot{"Push A", {PlanEntry{ExerciseId{"bench-press"}, 5, 5, 82.5, 180}}}));
  CHECK_EQ(h.repo.routineRows[0].entries, planned);
  CHECK_EQ(h.repo.routineRows[0].name, std::string("Push A"));
  CHECK_EQ(h.repo.sessions[0].routine, std::optional<RoutineId>(rtId()));
}

// The honesty sweep, end to end: every read in the product is computed from the live rows on each
// call, so a correction has to move ALL of them at once — and this is the case that proves it
// rather than trusting it. A record is set, then corrected downward, and the record goes with it.
TEST(a_correction_moves_the_record_and_every_read_that_stands_on_it) {
  Harness h;
  h.trained("ses_00000001", h.clock.now, 100, 5, 4);
  h.service.start(uid(), SessionStart{sid("ses_00000002"), h.clock.now + kWeek});
  for (int number = 1; number <= 3; ++number)
    h.service.append(uid(), sid("ses_00000002"),
                     SetWrite{setId("set_0000002" + std::to_string(number)),
                              ExerciseId{"back-squat"}, 100, 5, SetKind::working, std::nullopt, "",
                              h.clock.now + kWeek + number * 60'000});
  h.service.append(uid(), sid("ses_00000002"),
                   SetWrite{setId("set_00000024"), ExerciseId{"back-squat"}, 120, 5,
                            SetKind::working, std::nullopt, "", h.clock.now + kWeek + 240'000});
  h.service.finish(uid(), sid("ses_00000002"), h.clock.now + kWeek + 3'600'000);
  REQUIRE(h.service.review(uid(), sid("ses_00000002"))->record.has_value());   // 120 kg, the PR
  SetFix fix;
  fix.weightKg = 90.0;

  std::optional<Set> fixed =
      h.service.fixSet(uid(), sid("ses_00000002"), setId("set_00000024"), fix);

  REQUIRE(fixed.has_value());
  // the session itself
  CHECK_EQ(h.service.detail(uid(), sid("ses_00000002"))->sets[3].weightKg, 90.0);
  // the finish readout — the loud line is gone with the load that earned it
  std::optional<Review> review = h.service.review(uid(), sid("ses_00000002"));
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
  std::optional<MovementRecord> page = h.service.movementRecord(uid(), ExerciseId{"back-squat"});
  REQUIRE(page.has_value());
  CHECK_EQ(page->heaviest, std::optional<Best>(Best{100, 5, h.clock.now, e1rm(100, 5)}));
  CHECK_EQ(page->bestE1rm, std::optional<Best>(Best{100, 5, h.clock.now, e1rm(100, 5)}));
  // the statistics engine
  Statistics stats = h.service.statistics(uid());
  REQUIRE_EQ(stats.movements.size(), static_cast<std::size_t>(1));
  CHECK_EQ(stats.movements[0].heaviest,
           std::optional<Best>(Best{100, 5, h.clock.now, e1rm(100, 5)}));
  // the prefill the logger puts on screen before a lifter touches anything
  LastTimeOutcome prefill = h.service.lastTime(uid(), ExerciseId{"back-squat"});
  REQUIRE(prefill.lastTime.has_value());
  CHECK_EQ(prefill.lastTime->sets[3].weightKg, 90.0);
  // and the file a lifter walks away with
  std::vector<ExportedSet> exported = h.service.exportedSets(uid());
  REQUIRE_EQ(exported.size(), static_cast<std::size_t>(8));
  CHECK_EQ(exported[7].weightKg, std::string("90.00"));
}

// A deleted set is gone from every one of those reads too, by the same construction — and the one
// number the log prints beside a session moves with it.
TEST(a_deleted_set_is_gone_from_the_log_the_review_and_the_export) {
  Harness h;
  h.trained("ses_00000001", h.clock.now, 100, 5, 3);

  h.service.deleteSet(uid(), sid("ses_00000001"), setId("set_000000012"));

  std::vector<LogRow> rows = h.logBefore(h.clock.now + kWeek);
  REQUIRE_EQ(rows.size(), static_cast<std::size_t>(1));
  CHECK_EQ(rows[0].summary.setCount, 2);
  CHECK_EQ(rows[0].summary.workingSetCount, 2);
  CHECK_EQ(rows[0].summary.tonnageKg, 1000.0);
  CHECK_EQ(h.service.review(uid(), sid("ses_00000001"))->stats.workingSets, 2);
  CHECK_EQ(h.service.detail(uid(), sid("ses_00000001"))->sets.size(),
           static_cast<std::size_t>(2));
  CHECK_EQ(h.service.exportedSets(uid()).size(), static_cast<std::size_t>(2));
}

// ---- the proposal ledger ----------------------------------------------------------------------

namespace {
ProposalWrite proposalFor(std::vector<RoutineEntry> entries, std::string id = "prop_00000001",
                          std::optional<std::string> name = std::nullopt) {
  return ProposalWrite{ProposalId{std::move(id)},
                       rtId(),
                       std::move(name),
                       "Heavier triples.",
                       std::move(entries),
                       ProposalSource{ProposalDoor::mcp, "", ""}};
}

RoutineEntry benchAt(double weightKg, int reps = 5, int position = 1) {
  return RoutineEntry{position, ExerciseId{"bench-press"}, 5, reps, weightKg, 180};
}
}

// ONE list, both kinds of row: every proposal ever minted against the day, newest first, and the
// creation row under them. A screen handed two lists would merge them itself, three surfaces three
// ways.
TEST(a_routines_history_holds_its_proposals_and_its_creation_in_one_list) {
  Harness h;
  h.create(h.pushAWrite());
  h.service.propose(uid(), proposalFor({benchAt(87.5, 3)}));
  h.clock.now += 1'000;
  h.service.propose(uid(), proposalFor({benchAt(90.0, 3)}, "prop_00000002"));

  const std::vector<RoutineEvent> history = h.service.routineHistory(uid(), rtId());

  REQUIRE_EQ(history.size(), static_cast<std::size_t>(3));
  CHECK(history[0].kind == RoutineEventKind::proposal);
  CHECK_EQ(history[0].proposal->id, ProposalId{"prop_00000002"});
  CHECK(history[0].proposal->state == ProposalState::pending);
  // The one it replaced is still here — superseded, dated, and part of the program's past.
  CHECK_EQ(history[1].proposal->id, ProposalId{"prop_00000001"});
  CHECK(history[1].proposal->state == ProposalState::superseded);
  CHECK(history[2].kind == RoutineEventKind::created);
  CHECK_EQ(history[2].movements, std::optional<int>(1));
}

// The mint's whole promise: a typed diff against the routine as it stands, frozen at its revision,
// and NOTHING written to the program.
TEST(a_proposal_is_minted_against_the_routine_and_changes_nothing) {
  Harness h;
  h.create(h.pushAWrite());
  const std::vector<Routine> before = h.repo.routineRows;

  ProposalMintOutcome minted = h.service.propose(uid(), proposalFor({benchAt(87.5, 3)}));

  REQUIRE(minted.proposal.has_value());
  CHECK(minted.error == ProposalMintError::none);
  CHECK_EQ(h.repo.routineRows, before);
  CHECK_EQ(minted.proposal->head.state, ProposalState::pending);
  CHECK_EQ(minted.proposal->head.intent, ProposalIntent::revise);
  CHECK_EQ(minted.proposal->baseRevision, 1);
  CHECK_EQ(minted.proposal->baseName, std::string("Push A"));
  CHECK_EQ(minted.proposal->proposedName, std::string("Push A"));   // absent name keeps the one it has
  CHECK_EQ(minted.proposal->head.changes, 1);
  REQUIRE_EQ(minted.proposal->changes.size(), static_cast<std::size_t>(1));
  CHECK_EQ(minted.proposal->changes[0].kind, ChangeKind::retargeted);
  CHECK_EQ(minted.proposal->changes[0].before,
           std::optional<EntryTargets>(EntryTargets{5, 5, 82.5, 180}));
  CHECK_EQ(minted.proposal->changes[0].after,
           std::optional<EntryTargets>(EntryTargets{5, 3, 87.5, 180}));
}

// A document a plan could not hold is refused at the MINT, through the Routine constructor, so a
// proposal a lifter reads and cannot apply never reaches their screen.
TEST(a_proposal_that_could_not_be_stored_as_a_plan_is_refused_before_it_is_minted) {
  Harness h;
  h.create(h.pushAWrite());

  bool refused = false;
  try {
    h.service.propose(uid(), proposalFor({}));   // a routine with no movement is not a plan
  } catch (const InvalidTraining&) {
    refused = true;
  }

  CHECK(refused);
  CHECK(h.repo.proposalRows.empty());
}

TEST(a_proposal_naming_a_routine_this_account_cannot_read_is_the_one_absent_fact) {
  Harness h;
  h.repo.routineRows.push_back(Routine{rtId(), uid("u2"), "Their plan", 0, {benchEntry()}});

  ProposalMintOutcome minted = h.service.propose(uid(), proposalFor({benchAt(87.5)}));

  CHECK(minted.error == ProposalMintError::unknownRoutine);
  CHECK_EQ(minted.proposal, std::optional<RoutineProposal>());
}

// THE TAP, and the two things it has to be: atomic, and against the base the diff was computed
// from. The routine takes the whole document or none of it, and the proposal becomes a dated record.
TEST(applying_a_proposal_writes_the_whole_document_and_dates_the_record) {
  Harness h;
  h.create(h.pushAWrite());
  h.service.propose(uid(), proposalFor({benchAt(87.5, 3), RoutineEntry{2, ExerciseId{"back-squat"},
                                                                      3, 8, 100.0, 180}},
                                       "prop_00000001", "Push A — heavy"));
  h.clock.now += 60'000;

  ProposalSettleOutcome tapped = h.service.apply(uid(), ProposalId{"prop_00000001"});

  REQUIRE(tapped.proposal.has_value());
  REQUIRE(tapped.routine.has_value());
  CHECK(tapped.error == ProposalSettleError::none);
  CHECK_EQ(tapped.proposal->head.state, ProposalState::applied);
  CHECK_EQ(tapped.proposal->head.settledAtMs, std::optional<std::uint64_t>(h.clock.now));
  CHECK_EQ(tapped.routine->name, std::string("Push A — heavy"));
  CHECK_EQ(tapped.routine->revision, 2);
  REQUIRE_EQ(tapped.routine->entries.size(), static_cast<std::size_t>(2));
  CHECK_EQ(tapped.routine->entries[0].targetWeightKg, std::optional<double>(87.5));
  CHECK_EQ(tapped.routine->entries[1].exercise, ExerciseId{"back-squat"});
  // It stays in the routine's history rather than disappearing.
  CHECK_EQ(h.service.proposals(uid(), ProposalQuery{rtId(), false}).size(),
           static_cast<std::size_t>(1));
  CHECK(h.service.proposals(uid(), ProposalQuery{rtId(), true}).empty());
}

// THE LINE THIS WHOLE WAVE TURNS ON. The mid-session "Save 87.5 to Push A" is a full
// read-modify-write PUT, and before the revision existed it would have left a proposal standing
// against a document that was gone. Now the lifter's own hand supersedes it, and the tap refuses.
TEST(a_lifter_rewriting_the_routine_supersedes_a_proposal_rather_than_merging_it) {
  Harness h;
  h.create(h.pushAWrite());
  h.service.propose(uid(), proposalFor({benchAt(87.5, 3)}));
  h.clock.now += 60'000;

  h.service.replaceRoutine(uid(), rtId(),
                           h.pushAWrite({benchAt(85.0)}, "rt_00000001", "Push A"));
  ProposalSettleOutcome tapped = h.service.apply(uid(), ProposalId{"prop_00000001"});

  CHECK(tapped.error == ProposalSettleError::superseded);
  CHECK_EQ(tapped.routine, std::optional<Routine>());
  // The lifter's own numbers stand, untouched by the diff that was waiting.
  CHECK_EQ(h.service.routine(uid(), rtId())->entries[0].targetWeightKg, std::optional<double>(85.0));
  CHECK_EQ(h.service.routine(uid(), rtId())->revision, 2);
  // And the superseded proposal is a dated record on the routine rather than a row that vanished.
  const std::vector<ProposalHead> history = h.service.proposals(uid(), ProposalQuery{rtId(), false});
  REQUIRE_EQ(history.size(), static_cast<std::size_t>(1));
  CHECK_EQ(history[0].state, ProposalState::superseded);
  CHECK_EQ(history[0].settledAtMs, std::optional<std::uint64_t>(h.clock.now));
}

// THE OTHER HALF OF THAT RULE, and without it the rule is a card that dies for nothing. A PUT that
// lands the bytes already standing — a routine editor saving on close, the mid-session save writing
// the whole document back to change one weight it did not change — destroyed no base, so it moves no
// revision and settles nothing. Where the day sits in the week is not part of any proposal either:
// an apply keeps the base's own position, so dragging a routine up the list leaves the card waiting.
TEST(a_put_that_changes_neither_the_document_nor_the_name_leaves_a_pending_proposal_standing) {
  Harness h;
  h.create(h.pushAWrite());
  h.service.propose(uid(), proposalFor({benchAt(87.5, 3)}));
  h.clock.now += 60'000;

  h.service.replaceRoutine(uid(), rtId(), h.pushAWrite());                              // identical
  h.service.replaceRoutine(uid(), rtId(), RoutineWrite{rtId(), "Push A", 3, {benchEntry()}});

  CHECK_EQ(h.service.routine(uid(), rtId())->revision, 1);
  CHECK_EQ(h.service.routine(uid(), rtId())->position, 3);
  const std::vector<ProposalHead> waiting = h.service.proposals(uid(), ProposalQuery{rtId(), true});
  REQUIRE_EQ(waiting.size(), static_cast<std::size_t>(1));
  CHECK_EQ(waiting[0].state, ProposalState::pending);
  // And the tap it was minted for still lands, because nothing about its base moved.
  CHECK(h.service.apply(uid(), ProposalId{"prop_00000001"}).error == ProposalSettleError::none);
  CHECK_EQ(h.service.routine(uid(), rtId())->entries[0].targetWeightKg, std::optional<double>(87.5));
  CHECK_EQ(h.service.routine(uid(), rtId())->position, 3);
}

// A resent id carrying a DIFFERENT document is not a replay, and answering it with the stored
// proposal would throw this one away while telling the caller something of theirs is waiting. It is
// refused as a value, nothing is written, and the proposal already standing is untouched.
TEST(a_spent_proposal_id_carrying_a_different_document_is_refused_rather_than_replayed) {
  Harness h;
  h.create(h.pushAWrite());
  h.service.propose(uid(), proposalFor({benchAt(87.5, 3)}));

  ProposalMintOutcome second = h.service.propose(uid(), proposalFor({benchAt(60.0, 12)}));
  ProposalMintOutcome replayed = h.service.propose(uid(), proposalFor({benchAt(87.5, 3)}));

  CHECK(second.error == ProposalMintError::idReused);
  CHECK_EQ(second.proposal, std::optional<RoutineProposal>());
  REQUIRE_EQ(h.repo.proposalRows.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.proposalRows[0].changes[0].after,
           std::optional<EntryTargets>(EntryTargets{5, 3, 87.5, 180}));
  CHECK_EQ(h.repo.proposalRows[0].head.state, ProposalState::pending);
  // The identical document under that id still replays, which is what the id is for.
  CHECK(replayed.error == ProposalMintError::none);
  REQUIRE(replayed.proposal.has_value());
  CHECK_EQ(replayed.proposal->head.id, ProposalId{"prop_00000001"});
}

// A day is trained top to bottom, so moving a movement to the front is a real change to the program
// — and the rows say it by their order alone. It used to be refused as "that document is what the
// routine already says", which was false about the one thing the refusal claimed to know.
TEST(a_proposal_that_only_reorders_the_day_is_minted_rather_than_called_no_change) {
  Harness h;
  h.create(h.pushAWrite({benchEntry(),
                                               RoutineEntry{2, ExerciseId{"back-squat"}, 3, 8,
                                                            100.0, 180}}));

  ProposalMintOutcome minted = h.service.propose(
      uid(), proposalFor({RoutineEntry{1, ExerciseId{"back-squat"}, 3, 8, 100.0, 180},
                          benchEntry(2)}));

  REQUIRE(minted.proposal.has_value());
  CHECK(minted.error == ProposalMintError::none);
  CHECK_EQ(minted.proposal->head.changes, 1);
  CHECK_EQ(minted.proposal->changes[0].kind, ChangeKind::kept);
  CHECK_EQ(minted.proposal->changes[1].kind, ChangeKind::kept);
  // And the tap writes the order the lifter read.
  CHECK(h.service.apply(uid(), ProposalId{"prop_00000001"}).error == ProposalSettleError::none);
  CHECK_EQ(h.service.routine(uid(), rtId())->entries[0].exercise, ExerciseId{"back-squat"});
  CHECK_EQ(h.service.routine(uid(), rtId())->entries[1].exercise, ExerciseId{"bench-press"});
}

// Applying one proposal moves the routine, so every OTHER proposal waiting on it is now against a
// base that is gone — settled the same way the lifter's own write settles them.
TEST(applying_one_proposal_supersedes_every_other_waiting_on_that_routine) {
  Harness h;
  h.create(h.pushAWrite());
  h.service.propose(uid(), proposalFor({benchAt(87.5, 3)}, "prop_00000001"));
  // A second door's proposal on the same routine: pending beside the first rather than superseding
  // it, because the pending rule is per (routine, door, connection).
  h.repo.proposalRows.push_back(
      RoutineProposal{ProposalHead{ProposalId{"prop_00000002"}, rtId(), uid(),
                                   ProposalIntent::revise, ProposalState::pending,
                                   ProposalSource{ProposalDoor::ask, "", ""}, "", 1, h.clock.now,
                                   std::nullopt},
                      1, "Push A", "Push A", changesBetween({benchEntry()}, {benchAt(90.0)})});
  h.clock.now += 60'000;

  h.service.apply(uid(), ProposalId{"prop_00000001"});

  const std::vector<ProposalHead> history = h.service.proposals(uid(), ProposalQuery{rtId(), false});
  REQUIRE_EQ(history.size(), static_cast<std::size_t>(2));
  CHECK(h.service.proposals(uid(), ProposalQuery{rtId(), true}).empty());
  for (const ProposalHead& head : history)
    CHECK(head.state == ProposalState::applied || head.state == ProposalState::superseded);
}

// No reason is asked for, nothing changes, and it stays in the routine's history in case the lifter
// wants it back.
TEST(dismissing_a_proposal_changes_nothing_and_keeps_it_in_the_history) {
  Harness h;
  h.create(h.pushAWrite());
  h.service.propose(uid(), proposalFor({benchAt(87.5, 3)}));
  const std::vector<Routine> before = h.repo.routineRows;
  h.clock.now += 60'000;

  ProposalSettleOutcome dismissed = h.service.dismiss(uid(), ProposalId{"prop_00000001"});

  REQUIRE(dismissed.proposal.has_value());
  CHECK(dismissed.error == ProposalSettleError::none);
  CHECK_EQ(dismissed.proposal->head.state, ProposalState::dismissed);
  CHECK_EQ(dismissed.proposal->head.settledAtMs, std::optional<std::uint64_t>(h.clock.now));
  CHECK_EQ(dismissed.routine, std::optional<Routine>());
  CHECK_EQ(h.repo.routineRows, before);
}

// A settle asked for what it already did is a REPLAY and answers 200 with the stored row, so a
// double tap on a slow connection cannot report a failure. Asked for the OTHER decision, it refuses.
TEST(a_settled_proposal_replays_its_own_decision_and_refuses_the_other_one) {
  Harness h;
  h.create(h.pushAWrite());
  h.service.propose(uid(), proposalFor({benchAt(87.5, 3)}));
  h.service.apply(uid(), ProposalId{"prop_00000001"});

  ProposalSettleOutcome again = h.service.apply(uid(), ProposalId{"prop_00000001"});
  ProposalSettleOutcome other = h.service.dismiss(uid(), ProposalId{"prop_00000001"});

  CHECK(again.error == ProposalSettleError::none);
  REQUIRE(again.proposal.has_value());
  CHECK_EQ(again.proposal->head.state, ProposalState::applied);
  CHECK_EQ(h.service.routine(uid(), rtId())->revision, 2);   // and it did not apply twice
  CHECK(other.error == ProposalSettleError::settled);
}

// Every proposal read and write is owner-scoped, and absent is byte-identical to another account's.
TEST(a_proposal_of_another_account_is_the_same_fact_as_no_proposal_at_all) {
  Harness h;
  h.repo.routineRows.push_back(Routine{rtId("rt_00000002"), uid("u2"), "Their plan", 0,
                                       {benchEntry()}});
  h.repo.proposalRows.push_back(
      RoutineProposal{ProposalHead{ProposalId{"prop_00000001"}, rtId("rt_00000002"), uid("u2"),
                                   ProposalIntent::revise, ProposalState::pending,
                                   ProposalSource{ProposalDoor::mcp, "", ""}, "", 1, h.clock.now,
                                   std::nullopt},
                      1, "Their plan", "Their plan",
                      changesBetween({benchEntry()}, {benchAt(90.0)})});

  CHECK_EQ(h.service.proposal(uid(), ProposalId{"prop_00000001"}),
           std::optional<RoutineProposal>());
  CHECK(h.service.proposals(uid(), ProposalQuery{std::nullopt, false}).empty());
  CHECK(h.service.apply(uid(), ProposalId{"prop_00000001"}).error ==
        ProposalSettleError::notFound);
  CHECK(h.service.dismiss(uid(), ProposalId{"prop_00000001"}).error ==
        ProposalSettleError::notFound);
  // And their plan is exactly where it was.
  CHECK_EQ(h.service.routine(uid("u2"), rtId("rt_00000002"))->entries[0].targetWeightKg,
           std::optional<double>(82.5));
}

// Applying a removal takes the day out of the program — and the history goes with it, because a day
// that has left has no editor to draw a History section in.
TEST(applying_a_removal_takes_the_day_out_and_leaves_the_log_alone) {
  Harness h;
  h.create(h.pushAWrite());
  h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  h.service.finish(uid(), sid("ses_00000001"), h.clock.now + 1);
  h.service.proposeRemoval(uid(), ProposalId{"prop_00000001"}, rtId(), "Not trained in months.",
                           ProposalSource{ProposalDoor::mcp, "", ""});
  h.clock.now += 60'000;

  ProposalSettleOutcome tapped = h.service.apply(uid(), ProposalId{"prop_00000001"});

  REQUIRE(tapped.proposal.has_value());
  CHECK(tapped.error == ProposalSettleError::none);
  CHECK_EQ(tapped.proposal->head.state, ProposalState::applied);
  CHECK_EQ(tapped.routine, std::optional<Routine>());
  CHECK_EQ(h.service.routine(uid(), rtId()), std::optional<Routine>());
  // The frozen copy survives the plan it was taken from — the log still says what the workout was.
  CHECK_EQ(h.service.detail(uid(), sid("ses_00000001"))->session.plan->routineName,
           std::string("Push A"));
}

// --- The threads export: an archive, and archives have no ceiling ------------------------------

// THE EXPORT IS NOT A SCREEN. Its outcomes used to be stamped from the LIST read, which stops at
// kThreadList — so a lifter's oldest conversations exported with a blank outcome while the app's own
// read of the very same thread said `applied · 4 · Push A`, under a route whose comment promises
// nothing omitted. Every thread carries its outcome now, however many there are.
TEST(a_thread_past_the_list_ceiling_still_exports_the_outcome_the_app_shows_it) {
  Harness h;
  h.create(h.pushAWrite());
  const std::uint64_t opened = 1'700'000'000'000ull;
  for (int number = 0; number <= kThreadList; ++number) {
    const std::string id = "thr_probe" + std::to_string(1000 + number);
    h.repo.threadRows.push_back(AskThread{ThreadId{id}, uid(), "question " + id,
                                          opened + static_cast<std::uint64_t>(number),
                                          opened + static_cast<std::uint64_t>(number),
                                          {ThreadTurn{true, "question " + id, opened}},
                                          {}});
  }
  // The OLDEST thread — the one the newest-first list read drops — is the one that applied.
  h.repo.proposalRows.push_back(RoutineProposal{
      ProposalHead{ProposalId{"prop_00000001"}, rtId(), uid(), ProposalIntent::revise,
                   ProposalState::applied,
                   ProposalSource{ProposalDoor::ask, "", "", ThreadId{"thr_probe1000"}}, "", 4,
                   opened, std::nullopt},
      1, "Push A", "Push A", changesBetween({benchEntry()}, {benchAt(90.0)})});

  const std::vector<ExportedThreadTurn> exported = h.service.exportedThreadTurns(uid());

  CHECK_EQ(exported.size(), static_cast<std::size_t>(kThreadList) + 1);
  CHECK_EQ(exported[0].threadId, std::string("thr_probe1000"));
  CHECK_EQ(exported[0].outcome, std::string("applied"));
  CHECK_EQ(exported[0].changes, std::string("4"));
  CHECK_EQ(exported[0].routine, std::string("Push A"));
  // And it is the same sentence the thread's own read gives — which is the whole of the complaint.
  CHECK_EQ(toString(outcomeOf(*h.service.thread(uid(), ThreadId{"thr_probe1000"})).kind),
           std::string("applied"));
}

// A THREAD WITH NO TURNS IS REAL, AND IT IS IN THE FILE. The row is committed before the model runs,
// so one exists for the whole of every in-flight ask and stays if the process died before the answer
// came back. It is listed on screen and it is the lifter's to delete, so an export that dropped it
// would be quietly smaller than the list under a route promising nothing omitted.
TEST(a_conversation_whose_run_never_answered_exports_as_itself_with_nothing_under_it) {
  Harness h;
  h.repo.threadRows.push_back(AskThread{ThreadId{"thr_orphan01"}, uid(),
                                        "a question whose run never came back", 1'700'000'009'000,
                                        1'700'000'009'000, {}, {}});

  const std::vector<ExportedThreadTurn> exported = h.service.exportedThreadTurns(uid());

  REQUIRE(exported.size() == 1u);
  CHECK_EQ(exported[0].threadId, std::string("thr_orphan01"));
  CHECK_EQ(exported[0].title, std::string("a question whose run never came back"));
  CHECK_EQ(exported[0].outcome, std::string("read-only"));
  CHECK_EQ(exported[0].changes, std::string(""));
  CHECK_EQ(exported[0].turnNumber, std::string(""));
  CHECK_EQ(exported[0].from, std::string(""));
  CHECK_EQ(exported[0].text, std::string(""));
  CHECK_EQ(exported[0].saidAt, std::string(""));
  // The same thread the list read carries, so the two doors agree about what this account holds.
  CHECK_EQ(h.service.threads(uid()).size(), 1u);
}

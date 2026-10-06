#include "test/products/gym/sync/adapters/postgres/GymDoorFixture.h"
#include "test/testing.h"

#include "products/gym/adapters/json/TrainingJson.h"

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <optional>
#include <string>
#include <utility>
#include <vector>

using namespace wm;
using namespace wm::gym;
using namespace wm::gym::fake;

namespace {

const std::uint64_t kWeek = 604'800'000;

// A row of gym_set_revisions: the version an edit replaced, or the whole set a delete took out of the log.
struct Kept {
  Set set;
  bool deleted;

  bool operator==(const Kept&) const = default;
};

// One account's gym over the real door, on a clock the engine reads too; every test perturbs one thing.
struct Harness : wm::gym::doortest::Harness {
  StartOutcome startAt(std::uint64_t ms, std::string id = "ses_00000001") {
    return training.start(user, SessionStart{sid(std::move(id)), ms});
  }

  StartOutcome startFrom(std::uint64_t ms, std::string id, std::string routine) {
    return training.start(user, SessionStart{sid(std::move(id)), ms, true, rtId(std::move(routine))});
  }

  // Backfill: create exactly this session, which is not now.
  StartOutcome startExactly(std::uint64_t ms, std::string id) {
    return training.start(user, SessionStart{sid(std::move(id)), ms, false});
  }

  RoutineWrite pushAWrite(std::vector<RoutineEntry> entries = {benchEntry()},
                          std::string id = "rt_00000001", std::string name = "Push A") {
    return RoutineWrite{rtId(std::move(id)), std::move(name), 0, std::move(entries)};
  }

  // The LIFTER's door: the create a phone makes, naming no agent.
  RoutineWriteOutcome create(const RoutineWrite& incoming) {
    return program.createRoutine(user, incoming, std::nullopt);
  }

  SetWrite bench(std::string id, double weightKg, std::uint64_t completedAtMs) {
    return SetWrite{setId(std::move(id)), ExerciseId{"bench-press"}, weightKg, 8,
                    SetKind::working, std::nullopt, "", completedAtMs};
  }

  // A workout's squats, one a minute from its start, under set ids its session's id names.
  std::vector<SetWrite> squats(const std::string& session, std::uint64_t startedAtMs, double weightKg,
                               int reps, int sets) {
    std::vector<SetWrite> written;
    for (int number = 1; number <= sets; ++number)
      written.push_back(SetWrite{setId("set_" + session.substr(4) + std::to_string(number)),
                                 ExerciseId{"back-squat"}, weightKg, reps, SetKind::working,
                                 std::nullopt, "",
                                 startedAtMs + static_cast<std::uint64_t>(number) * 60'000});
    return written;
  }

  // A whole workout of squats, finished an hour in; the clock is never behind the start or the finish tap.
  void trained(const std::string& session, std::uint64_t startedAtMs, double weightKg, int reps,
               int sets, std::optional<std::string> routine = std::nullopt) {
    const std::uint64_t held = clock.now;
    clock.now = std::max(held, startedAtMs);
    training.start(user, SessionStart{sid(session), startedAtMs, true,
                                      routine ? std::optional<RoutineId>(rtId(*routine)) : std::nullopt});
    for (const SetWrite& set : squats(session, startedAtMs, weightKg, reps, sets))
      training.append(user, sid(session), set);
    clock.now = std::max(held, startedAtMs + 3'600'000);
    training.finish(user, sid(session), startedAtMs + 3'600'000);
    clock.now = held;
  }

  // A finished workout of squats written whole, the way an agent imports one.
  void imported(const std::string& session, std::uint64_t startedAtMs, std::uint64_t finishedAtMs,
                double weightKg, int reps, int sets) {
    training.importSession(user, SessionImport{sid(session), startedAtMs, finishedAtMs, std::nullopt,
                                               squats(session, startedAtMs, weightKg, reps, sets)});
  }

  // A workout of squats still running: started at its instant, never finished, and settled by no read yet.
  void running(const std::string& session, std::uint64_t startedAtMs, double weightKg, int reps,
               int sets) {
    training.start(user, SessionStart{sid(session), startedAtMs, false});
    for (const SetWrite& set : squats(session, startedAtMs, weightKg, reps, sets))
      training.append(user, sid(session), set);
  }

  std::vector<LogRow> logBefore(std::uint64_t beforeMs, int limit = 50) {
    return training.log(user, LogCursor{beforeMs, std::nullopt, limit});
  }

  // A record a phone edited: its field delta, admitted.
  void edit(const std::string& type, const std::string& id, const Json::Value& fields) {
    GymDoor::requireOk(admit(user, {GymDoor::delta(type, id, fields)}));
  }

  // A finished workout a phone corrected: the whole workout as it should stand, pushed as its command.
  void correct(const SessionId& session, const SessionCorrectionIn& incoming) {
    Json::Value args = toJson(incoming);
    args["sessionId"] = session.str();
    GymDoor::requireOk(door.command(user, "gym.correctSession", args));
  }

  // Every account's sessions, oldest start first.
  std::vector<Session> sessions() {
    std::vector<std::pair<std::string, std::string>> keys;
    {
      PgLease lease{*wm::gym::doortest::pool()};
      pqxx::read_transaction sql{*lease};
      for (const auto& row : sql.exec("select user_id::text, id from gym_sessions order by started_at, id"))
        keys.emplace_back(row[0].as<std::string>(), row[1].as<std::string>());
    }
    std::vector<Session> stored;
    for (const auto& [owner, id] : keys) stored.push_back(*repo.log.session(UserId{owner}, SessionId{id}));
    return stored;
  }

  // Every account's standing sets, in completion order.
  std::vector<Set> sets() {
    std::vector<std::pair<std::string, std::string>> keys;
    {
      PgLease lease{*wm::gym::doortest::pool()};
      pqxx::read_transaction sql{*lease};
      for (const auto& row :
           sql.exec("select user_id::text, id from gym_sets order by completed_at, set_number, id"))
        keys.emplace_back(row[0].as<std::string>(), row[1].as<std::string>());
    }
    std::vector<Set> stored;
    for (const auto& [owner, id] : keys) stored.push_back(*repo.log.setOf(UserId{owner}, SetId{id}));
    return stored;
  }

  std::vector<Kept> kept() {
    PgLease lease{*wm::gym::doortest::pool()};
    pqxx::read_transaction sql{*lease};
    std::vector<Kept> rows;
    for (const auto& row : sql.exec(
             "select set_id, session_id, exercise_id, set_number, weight_kg::float8, reps, kind, rpe::float8, "
             "note, (extract(epoch from completed_at) * 1000)::bigint, deleted "
             "from gym_set_revisions order by revision_id")) {
      std::optional<double> rpe;
      if (!row[7].is_null()) rpe = row[7].as<double>();
      rows.push_back(Kept{Set{SetId{row[0].as<std::string>()}, SessionId{row[1].as<std::string>()},
                              ExerciseId{row[2].as<std::string>()}, row[3].as<int>(), row[4].as<double>(),
                              row[5].as<int>(), setKindFromStored(row[6].as<std::string>()), rpe,
                              row[8].as<std::string>(), row[9].as<std::uint64_t>()},
                          row[10].as<bool>()});
    }
    return rows;
  }

  std::vector<SessionShare> shares() {
    PgLease lease{*wm::gym::doortest::pool()};
    pqxx::read_transaction sql{*lease};
    std::vector<SessionShare> rows;
    for (const auto& row : sql.exec(
             "select session_id, user_id::text, token, (extract(epoch from expires_at) * 1000)::bigint "
             "from gym_session_shares order by session_id"))
      rows.push_back(SessionShare{SessionId{row[0].as<std::string>()}, UserId{row[1].as<std::string>()},
                                  row[2].as<std::string>(), row[3].as<std::uint64_t>()});
    return rows;
  }
};

}

TEST(start_stores_and_returns_the_fresh_session) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;

  StartOutcome started = h.startAt(h.clock.now);

  CHECK(started.error == StartError::none);
  CHECK_EQ(started.session, std::optional<Session>(Session(sid(), h.user, h.clock.now)));
  CHECK_EQ(h.sessions(), std::vector<Session>{Session(sid(), h.user, h.clock.now)});
}

TEST(start_refuses_a_session_that_begins_in_the_logs_future) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;

  StartOutcome ahead = h.startAt(h.clock.now + kMaxClockAheadMs + 60'000);

  CHECK(ahead.error == StartError::clockAhead);
  CHECK_FALSE(ahead.session.has_value());
  CHECK_EQ(ahead.clockAheadMs, kMaxClockAheadMs + 60'000);
  CHECK_EQ(h.sessions(), std::vector<Session>{});

  StartOutcome live = h.startAt(h.clock.now);
  h.clock.now -= 60 * 60 * 1000;  // the server's clock now reads an hour BEHIND the open workout
  StartOutcome joined = h.startAt(h.clock.now + 24ull * 60 * 60 * 1000, "ses_00000002");
  REQUIRE(live.session.has_value());
  CHECK(joined.error == StartError::none);
  CHECK_EQ(joined.session, live.session);
}

TEST(start_replay_converges_on_the_same_session) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  StartOutcome first = h.startAt(h.clock.now);

  StartOutcome replayed = h.startAt(h.clock.now);

  REQUIRE(first.session.has_value());
  CHECK(replayed.error == StartError::none);
  CHECK_EQ(replayed.session, first.session);
  CHECK_EQ(h.sessions(), std::vector<Session>{Session(sid(), h.user, h.clock.now)});
}

TEST(start_double_tap_with_two_ids_joins_the_first_taps_session) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  StartOutcome first = h.startAt(h.clock.now, "ses_00000001");

  StartOutcome second = h.startAt(h.clock.now + 5, "ses_00000002");   // the first tap's session is open

  REQUIRE(first.session.has_value());
  CHECK(second.error == StartError::none);
  CHECK_EQ(second.session, first.session);
  CHECK_EQ(h.sessions(), std::vector<Session>{Session(sid("ses_00000001"), h.user, h.clock.now)});
}

TEST(start_refuses_a_session_id_that_belongs_to_another_account) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.training.start(h.other, SessionStart{sid(), h.clock.now - 5'000});   // another lifter's

  StartOutcome started = h.startAt(h.clock.now);

  CHECK(started.error == StartError::idTaken);
  CHECK_FALSE(started.session.has_value());
  CHECK_EQ(h.sessions(), std::vector<Session>{Session(sid(), h.other, h.clock.now - 5'000)});
  CHECK_EQ(h.training.detail(h.user, sid()), std::optional<SessionDetail>());
}

TEST(start_replay_of_an_already_finished_start_returns_the_stored_session) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now);
  h.training.finish(h.user, sid(), h.clock.now + 1'000);

  StartOutcome replayed = h.startAt(h.clock.now);

  const Session finished(sid(), h.user, h.clock.now, std::optional<std::uint64_t>(h.clock.now + 1'000),
                         std::nullopt, std::nullopt, ClosedBy::finish);
  CHECK(replayed.error == StartError::none);
  CHECK_EQ(replayed.session, std::optional<Session>(finished));
  CHECK_EQ(h.sessions(), std::vector<Session>{finished});
}

TEST(start_auto_closes_a_stale_setless_session_at_its_start_instant) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t firstStart = h.clock.now;
  h.startAt(firstStart, "ses_00000001");
  h.clock.now += kAutoCloseMs;

  StartOutcome second = h.startAt(h.clock.now, "ses_00000002");

  CHECK_EQ(second.session, std::optional<Session>(Session(sid("ses_00000002"), h.user, h.clock.now)));
  CHECK_EQ(h.sessions(), (std::vector<Session>{
      Session(sid("ses_00000001"), h.user, firstStart, firstStart, std::nullopt, std::nullopt, ClosedBy::stale),
      Session(sid("ses_00000002"), h.user, h.clock.now)}));
}

TEST(start_auto_closes_a_stale_session_at_its_last_set_instant) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t firstStart = h.clock.now;
  h.startAt(firstStart, "ses_00000001");
  const std::uint64_t lastSetAt = h.clock.now + 60'000;
  h.training.append(h.user, sid(), h.bench("set_00000001", 80.0, lastSetAt));
  h.clock.now = lastSetAt + kAutoCloseMs;

  h.startAt(h.clock.now, "ses_00000002");

  CHECK_EQ(h.sessions(), (std::vector<Session>{
      Session(sid("ses_00000001"), h.user, firstStart, lastSetAt, std::nullopt, std::nullopt, ClosedBy::stale),
      Session(sid("ses_00000002"), h.user, h.clock.now)}));
}

TEST(start_leaves_a_live_open_session_alone_and_joins_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t started = h.clock.now;
  StartOutcome first = h.startAt(started, "ses_00000001");
  h.clock.now += kAutoCloseMs - 1;   // one ms shy of stale

  StartOutcome second = h.startAt(h.clock.now, "ses_00000002");

  REQUIRE(first.session.has_value());
  CHECK_EQ(second.session, first.session);
  CHECK_EQ(h.sessions(), std::vector<Session>{Session(sid("ses_00000001"), h.user, started)});
}

TEST(start_that_will_not_join_is_refused_while_another_session_is_open) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");

  StartOutcome backfill = h.startExactly(h.clock.now - kAutoCloseMs, "ses_00000002");

  CHECK(backfill.error == StartError::alreadyOpen);
  CHECK(!backfill.session.has_value());
  // The refusal touches nothing: the live session is still the only row, and still open.
  CHECK_EQ(h.sessions(), std::vector<Session>{Session(sid("ses_00000001"), h.user, h.clock.now)});
}

TEST(start_that_will_not_join_stores_the_session_it_named_when_nothing_is_open) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  std::uint64_t yesterday = h.clock.now - kAutoCloseMs;

  StartOutcome backfill = h.startExactly(yesterday, "ses_00000002");

  CHECK(backfill.error == StartError::none);
  CHECK_EQ(backfill.session, std::optional<Session>(Session(sid("ses_00000002"), h.user, yesterday)));
}

TEST(start_that_will_not_join_still_replays_its_own_open_session) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  // Minutes ago, not hours: a start a full auto-close window old would be settled by the second call.
  std::uint64_t justBefore = h.clock.now - 60'000;
  StartOutcome first = h.startExactly(justBefore, "ses_00000002");

  StartOutcome replayed = h.startExactly(justBefore, "ses_00000002");

  REQUIRE(first.session.has_value());
  CHECK(replayed.error == StartError::none);
  CHECK_EQ(replayed.session, first.session);
  CHECK_EQ(h.sessions(), std::vector<Session>{Session(sid("ses_00000002"), h.user, justBefore)});
}

TEST(append_to_a_missing_session_is_not_found) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;

  AppendOutcome outcome = h.training.append(h.user, sid(), h.bench("set_00000001", 80.0, 1'000));

  CHECK(outcome.error == AppendError::notFound);
  CHECK_FALSE(outcome.set.has_value());
  CHECK_EQ(h.sets(), std::vector<Set>{});
}

TEST(append_to_anothers_session_is_the_same_not_found) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now);

  AppendOutcome outcome =
      h.training.append(h.other, sid(), h.bench("set_00000001", 80.0, h.clock.now));

  CHECK(outcome.error == AppendError::notFound);
  CHECK_EQ(h.sets(), std::vector<Set>{});
}

TEST(append_of_a_new_set_to_a_finished_session_is_finished) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now);
  h.training.finish(h.user, sid(), h.clock.now + 1'000);

  AppendOutcome outcome =
      h.training.append(h.user, sid(), h.bench("set_00000001", 80.0, h.clock.now));

  CHECK(outcome.error == AppendError::finished);
  CHECK_FALSE(outcome.set.has_value());
  CHECK_EQ(h.sets(), std::vector<Set>{});
}

TEST(append_of_owed_sets_reopens_a_stale_close_and_moves_the_finish_forward) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t lastNight = h.clock.now;
  h.startAt(lastNight);
  h.training.append(h.user, sid(), h.bench("set_00000001", 80.0, lastNight + 60'000));
  h.clock.now += kAutoCloseMs + 3'600'000;   // a read the next morning settles it stale…
  h.training.log(h.user, LogCursor{kMaxInstantMs, std::nullopt, 10});
  REQUIRE_EQ(h.repo.log.session(h.user, sid()),
             std::optional<Session>(Session(sid(), h.user, lastNight, lastNight + 60'000, std::nullopt,
                                            std::nullopt, ClosedBy::stale)));

  AppendOutcome second = h.training.append(h.user, sid(), h.bench("set_00000002", 82.5, lastNight + 120'000));
  AppendOutcome third = h.training.append(h.user, sid(), h.bench("set_00000003", 85.0, lastNight + 180'000));
  AppendOutcome tomorrow = h.training.append(h.user, sid(), h.bench("set_00000004", 60.0, h.clock.now));

  CHECK(second.error == AppendError::none);
  CHECK(third.error == AppendError::none);
  CHECK(tomorrow.error == AppendError::finished);
  CHECK_EQ(h.sets(), (std::vector<Set>{
      Set(setId("set_00000001"), sid(), ExerciseId{"bench-press"}, 1, 80.0, 8, SetKind::working,
          std::nullopt, "", lastNight + 60'000),
      Set(setId("set_00000002"), sid(), ExerciseId{"bench-press"}, 2, 82.5, 8, SetKind::working,
          std::nullopt, "", lastNight + 120'000),
      Set(setId("set_00000003"), sid(), ExerciseId{"bench-press"}, 3, 85.0, 8, SetKind::working,
          std::nullopt, "", lastNight + 180'000)}));
  // The finish followed the last owed set, and is still the log's word, still revisable.
  CHECK_EQ(h.repo.log.session(h.user, sid()),
           std::optional<Session>(Session(sid(), h.user, lastNight, lastNight + 180'000, std::nullopt,
                                          std::nullopt, ClosedBy::stale)));
}

TEST(finish_upgrades_a_stale_close_so_the_lifters_word_ends_the_workout) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now);
  const std::uint64_t t0 = h.clock.now;
  h.training.append(h.user, sid(), h.bench("set_00000001", 80.0, t0 + 600'000));
  h.clock.now = t0 + 5 * 3'600'000;
  h.training.detail(h.user, sid());                                    // the mirror settles it stale
  REQUIRE_EQ(h.repo.log.session(h.user, sid()),
             std::optional<Session>(Session(sid(), h.user, t0, t0 + 600'000, std::nullopt, std::nullopt,
                                            ClosedBy::stale)));

  FinishOutcome finished = h.training.finish(h.user, sid(), t0 + 2 * 3'600'000);
  AppendOutcome after = h.training.append(h.user, sid(), h.bench("set_00000002", 82.5, t0 + 3 * 3'600'000));

  CHECK(finished.error == FinishError::none);
  CHECK_EQ(finished.session, std::optional<Session>(Session(sid(), h.user, t0, t0 + 2 * 3'600'000,
                                                            std::nullopt, std::nullopt, ClosedBy::finish)));
  CHECK(after.error == AppendError::finished);
  CHECK_EQ(h.sets(), std::vector<Set>{Set(setId("set_00000001"), sid(), ExerciseId{"bench-press"}, 1, 80.0,
                                          8, SetKind::working, std::nullopt, "", t0 + 600'000)});
  // A finish EARLIER than the stale close keeps the later instant, and still becomes the lifter's word.
  h.startAt(h.clock.now, "ses_00000002");
  h.training.append(h.user, sid("ses_00000002"), h.bench("set_00000003", 80.0, h.clock.now + 600'000));
  const std::uint64_t t1 = h.clock.now;
  h.clock.now = t1 + 5 * 3'600'000;
  h.training.detail(h.user, sid("ses_00000002"));
  FinishOutcome early = h.training.finish(h.user, sid("ses_00000002"), t1 + 60'000);
  CHECK_EQ(early.session, std::optional<Session>(Session(sid("ses_00000002"), h.user, t1, t1 + 600'000,
                                                         std::nullopt, std::nullopt, ClosedBy::finish)));
  // A tap hours after the last set keeps the end at that set; only the word changes.
  h.startAt(h.clock.now, "ses_00000003");
  h.training.append(h.user, sid("ses_00000003"), h.bench("set_00000004", 80.0, h.clock.now + 600'000));
  const std::uint64_t t2 = h.clock.now;
  h.clock.now = t2 + 5 * 3'600'000;
  h.training.detail(h.user, sid("ses_00000003"));
  FinishOutcome late = h.training.finish(h.user, sid("ses_00000003"), h.clock.now);
  CHECK_EQ(late.session, std::optional<Session>(Session(sid("ses_00000003"), h.user, t2, t2 + 600'000,
                                                        std::nullopt, std::nullopt, ClosedBy::finish)));
}

TEST(append_after_the_lifters_own_finish_never_lands_however_close) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now);
  h.training.append(h.user, sid(), h.bench("set_00000001", 80.0, h.clock.now + 60'000));
  h.training.finish(h.user, sid(), h.clock.now + 120'000);

  AppendOutcome late = h.training.append(h.user, sid(), h.bench("set_00000002", 82.5, h.clock.now + 90'000));

  CHECK(late.error == AppendError::finished);
  CHECK_EQ(h.sets(), std::vector<Set>{Set(setId("set_00000001"), sid(), ExerciseId{"bench-press"}, 1, 80.0,
                                          8, SetKind::working, std::nullopt, "", h.clock.now + 60'000)});
  CHECK_EQ(h.sessions(), std::vector<Session>{Session(sid(), h.user, h.clock.now, h.clock.now + 120'000,
                                                      std::nullopt, std::nullopt, ClosedBy::finish)});
}

// A set that is ALREADY durable must never answer 409: the flush queue treats 409 as terminal.
TEST(append_replays_an_already_stored_set_across_the_finish_boundary) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now);
  AppendOutcome landed = h.training.append(h.user, sid(), h.bench("set_00000001", 80.0, h.clock.now + 1));
  h.training.finish(h.user, sid(), h.clock.now + 1'000);

  AppendOutcome replayed =
      h.training.append(h.user, sid(), h.bench("set_00000001", 80.0, h.clock.now + 1));

  const Set stored(setId("set_00000001"), sid(), ExerciseId{"bench-press"}, 1, 80.0, 8, SetKind::working,
                   std::nullopt, "", h.clock.now + 1);
  CHECK(replayed.error == AppendError::none);
  CHECK_EQ(landed.set, std::optional<Set>(stored));
  CHECK_EQ(replayed.set, std::optional<Set>(stored));
  CHECK_EQ(h.sets(), std::vector<Set>{stored});
}

TEST(append_refuses_a_set_id_minted_by_another_account) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.training.start(h.other, SessionStart{sid("ses_00000002"), h.clock.now});
  h.training.append(h.other, sid("ses_00000002"),
                    SetWrite{setId("set_00000001"), ExerciseId{"bench-press"}, 142.5, 3, SetKind::working,
                             std::optional<double>(9.5), "knee felt off, deload next week", h.clock.now});
  h.startAt(h.clock.now);

  AppendOutcome outcome =
      h.training.append(h.user, sid(), h.bench("set_00000001", 7.5, h.clock.now + 1));

  CHECK(outcome.error == AppendError::idTaken);
  CHECK_FALSE(outcome.set.has_value());   // never the stranger's row, not even to say it exists
  CHECK_EQ(h.sets(), std::vector<Set>{Set(setId("set_00000001"), sid("ses_00000002"),
                                          ExerciseId{"bench-press"}, 1, 142.5, 3, SetKind::working,
                                          std::optional<double>(9.5), "knee felt off, deload next week",
                                          h.clock.now)});
  CHECK_EQ(h.training.detail(h.user, sid()),
           std::optional<SessionDetail>(SessionDetail{Session(sid(), h.user, h.clock.now), {}}));
}

TEST(append_refuses_a_set_id_the_same_lifter_spent_in_another_session) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.training.append(h.user, sid("ses_00000001"), h.bench("set_00000001", 80.0, h.clock.now + 1));
  h.training.finish(h.user, sid("ses_00000001"), h.clock.now + 2);
  h.startAt(h.clock.now + 3, "ses_00000002");

  AppendOutcome outcome = h.training.append(
      h.user, sid("ses_00000002"),
      SetWrite{setId("set_00000001"), ExerciseId{"back-squat"}, 222.5, 9, SetKind::working,
               std::nullopt, "", h.clock.now + 4});

  CHECK(outcome.error == AppendError::idTaken);
  CHECK_FALSE(outcome.set.has_value());   // the old row is NOT reported as this write's result
  CHECK_EQ(h.sets(), std::vector<Set>{Set(setId("set_00000001"), sid("ses_00000001"),
                                          ExerciseId{"bench-press"}, 1, 80.0, 8, SetKind::working,
                                          std::nullopt, "", h.clock.now + 1)});
  CHECK_EQ(h.training.detail(h.user, sid("ses_00000002")),
           std::optional<SessionDetail>(SessionDetail{Session(sid("ses_00000002"), h.user, h.clock.now + 3), {}}));
}

TEST(append_of_a_movement_no_catalog_holds_is_unknown_exercise) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now);

  AppendOutcome outcome = h.training.append(
      h.user, sid(),
      SetWrite{setId("set_00000001"), ExerciseId{"zercher-squat"}, 100.0, 5, SetKind::working,
               std::nullopt, "", h.clock.now + 1});

  CHECK(outcome.error == AppendError::unknownExercise);
  CHECK_FALSE(outcome.set.has_value());
  CHECK_EQ(h.sets(), std::vector<Set>{});
  CHECK_EQ(h.training.detail(h.user, sid()),
           std::optional<SessionDetail>(SessionDetail{Session(sid(), h.user, h.clock.now), {}}));
}

TEST(append_naming_another_accounts_private_movement_is_unknown_exercise) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.catalog.createExercise(h.other, ExerciseWrite{ExerciseId{"ex_22222222"}, "Their Zercher Squat",
                                                  Pattern::squat, Equipment::barbell, 2.5});
  h.startAt(h.clock.now);

  AppendOutcome refused = h.training.append(
      h.user, sid(),
      SetWrite{setId("set_00000001"), ExerciseId{"ex_22222222"}, 100.0, 5, SetKind::working,
               std::nullopt, "", h.clock.now + 1});

  CHECK(refused.error == AppendError::unknownExercise);
  CHECK_FALSE(refused.set.has_value());
  CHECK_EQ(h.sets(), std::vector<Set>{});

  h.training.start(h.other, SessionStart{sid("ses_00000002"), h.clock.now});
  AppendOutcome mine = h.training.append(
      h.other, sid("ses_00000002"),
      SetWrite{setId("set_00000002"), ExerciseId{"ex_22222222"}, 100.0, 5, SetKind::working,
               std::nullopt, "", h.clock.now + 2});
  CHECK(mine.error == AppendError::none);
  CHECK_EQ(mine.set, std::optional<Set>(Set(setId("set_00000002"), sid("ses_00000002"),
                                            ExerciseId{"ex_22222222"}, 1, 100.0, 5, SetKind::working,
                                            std::nullopt, "", h.clock.now + 2)));
}

// Admission re-checks the finish under the scope lock and refuses a phone's set into a finished workout.
TEST(append_into_a_finished_workout_is_refused_by_admission_too_and_answers_finished) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now);
  h.training.finish(h.user, sid(), h.clock.now + 1'000);
  Json::Value fields(Json::objectValue);
  fields["sessionId"] = sid().str();
  fields["exerciseId"] = "bench-press";
  fields["weightKg"] = 80.0;
  fields["reps"] = 8;
  fields["kind"] = "working";
  fields["note"] = "";
  fields["completedAt"] = Json::UInt64(h.clock.now + 1);

  const std::string pushed =
      GymDoor::refusal(h.admit(h.user, {GymDoor::delta("set", "set_00000001", fields, true)}));
  AppendOutcome refused = h.training.append(h.user, sid(), h.bench("set_00000001", 80.0, h.clock.now + 1));

  CHECK_EQ(pushed, std::string("session-finished"));
  CHECK(refused.error == AppendError::finished);
  CHECK_FALSE(refused.set.has_value());
  CHECK_EQ(h.sets(), std::vector<Set>{});
}

TEST(append_numbers_max_plus_one_per_exercise_across_interleaving) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now);
  SetWrite squat{setId("set_00000002"), ExerciseId{"back-squat"}, 100.0, 5, SetKind::working,
                 std::nullopt, "", h.clock.now + 2};

  AppendOutcome bench1 = h.training.append(h.user, sid(), h.bench("set_00000001", 80.0, h.clock.now + 1));
  AppendOutcome squat1 = h.training.append(h.user, sid(), squat);
  AppendOutcome bench2 = h.training.append(h.user, sid(), h.bench("set_00000003", 82.5, h.clock.now + 3));

  REQUIRE(bench1.set.has_value());
  REQUIRE(squat1.set.has_value());
  REQUIRE(bench2.set.has_value());
  CHECK_EQ(bench1.set->setNumber, 1);
  CHECK_EQ(squat1.set->setNumber, 1);   // its own count, not the session's
  CHECK_EQ(bench2.set->setNumber, 2);
}

TEST(append_replay_returns_the_stored_row_byte_for_byte) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now);
  AppendOutcome first = h.training.append(h.user, sid(), h.bench("set_00000001", 80.0, h.clock.now + 1));

  // The replay arrives with a different weight — the flush queue re-sending after a lost reply.
  AppendOutcome replayed =
      h.training.append(h.user, sid(), h.bench("set_00000001", 90.0, h.clock.now + 99));

  const Set stored(setId("set_00000001"), sid(), ExerciseId{"bench-press"}, 1, 80.0, 8, SetKind::working,
                   std::nullopt, "", h.clock.now + 1);
  CHECK(replayed.error == AppendError::none);
  CHECK_EQ(first.set, std::optional<Set>(stored));
  CHECK_EQ(replayed.set, std::optional<Set>(stored));
  CHECK_EQ(h.sets(), std::vector<Set>{stored});
}

TEST(finish_is_idempotent_and_keeps_the_first_instant) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now);

  FinishOutcome first = h.training.finish(h.user, sid(), h.clock.now + 1'000);
  FinishOutcome replayed = h.training.finish(h.user, sid(), h.clock.now + 2'000);

  CHECK(first.error == FinishError::none);
  CHECK_EQ(first.session, std::optional<Session>(Session(sid(), h.user, h.clock.now, h.clock.now + 1'000,
                                                         std::nullopt, std::nullopt, ClosedBy::finish)));
  CHECK(replayed.error == FinishError::none);
  CHECK_EQ(replayed.session, first.session);

  FinishOutcome unknown = h.training.finish(h.user, SessionId{"ses_unknown1"}, h.clock.now + 1);
  CHECK(unknown.error == FinishError::notFound);
  CHECK_FALSE(unknown.session.has_value());
}

// Admission refuses the finish of a discarded workout, and the door answers as for one never started.
TEST(finish_of_a_session_the_engine_holds_dead_is_not_found_and_never_an_empty_none) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now);
  h.training.finish(h.user, sid(), h.clock.now + 1'000);
  REQUIRE(h.training.discard(h.user, sid()) == DiscardOutcome::done);
  Json::Value args(Json::objectValue);
  args["sessionId"] = sid().str();
  args["finishedAt"] = Json::UInt64(h.clock.now + 2'000);

  const std::string pushed = GymDoor::refusal(h.door.command(h.user, "gym.finish", args));
  FinishOutcome outcome = h.training.finish(h.user, sid(), h.clock.now + 2'000);

  CHECK_EQ(pushed, std::string("record-dead"));
  CHECK(outcome.error == FinishError::notFound);
  CHECK_FALSE(outcome.session.has_value());
}

// close is first-writer-wins, so a nonsense instant would be the session's end forever.
TEST(finish_refuses_an_instant_the_session_could_not_have_ended_at) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t started = h.clock.now;
  h.startAt(started);

  FinishOutcome zero = h.training.finish(h.user, sid(), 0);
  FinishOutcome beforeStart = h.training.finish(h.user, sid(), started - 1);
  FinishOutcome pastTheCeiling = h.training.finish(h.user, sid(), kMaxInstantMs + 1);

  CHECK(zero.error == FinishError::badInstant);
  CHECK(beforeStart.error == FinishError::badInstant);
  CHECK(pastTheCeiling.error == FinishError::badInstant);
  CHECK_FALSE(zero.session.has_value());
  CHECK_EQ(h.sessions(), std::vector<Session>{Session(sid(), h.user, started)});

  FinishOutcome atTheStart = h.training.finish(h.user, sid(), started);   // a workout with one rep
  CHECK(atTheStart.error == FinishError::none);
  CHECK_EQ(atTheStart.session, std::optional<Session>(Session(sid(), h.user, started, started, std::nullopt,
                                                              std::nullopt, ClosedBy::finish)));
}

TEST(log_auto_closes_the_stale_open_session_before_listing) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t started = h.clock.now;
  h.startAt(started);
  h.clock.now += kAutoCloseMs;

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 1);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(1));
  CHECK_EQ(listed[0].summary.session.finishedAtMs, std::optional<std::uint64_t>(started));
  CHECK_EQ(h.sessions(), std::vector<Session>{Session(sid(), h.user, started, started, std::nullopt,
                                                      std::nullopt, ClosedBy::stale)});
}

TEST(log_lists_newest_first_with_counts_and_sorted_names) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.training.append(h.user, sid(), h.bench("set_00000001", 80.0, h.clock.now + 1));
  h.training.append(h.user, sid(),
                    SetWrite{setId("set_00000002"), ExerciseId{"back-squat"}, 100.0, 5,
                             SetKind::working, std::nullopt, "", h.clock.now + 2});
  h.training.finish(h.user, sid(), h.clock.now + 3);
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
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.training.append(h.user, sid(), h.bench("set_00000001", 80.0, h.clock.now + 1));
  h.training.append(h.user, sid(),
                    SetWrite{setId("set_00000002"), ExerciseId{"back-squat"}, 100.0, 5,
                             SetKind::working, std::nullopt, "", h.clock.now + 2});
  h.training.append(h.user, sid(),
                    SetWrite{setId("set_00000003"), ExerciseId{"back-squat"}, 100.0, 8,
                             SetKind::working, std::nullopt, "", h.clock.now + 3});
  h.training.append(h.user, sid(),
                    SetWrite{setId("set_00000004"), ExerciseId{"back-squat"}, 140.0, 1,
                             SetKind::warmup, std::nullopt, "", h.clock.now + 4});
  h.training.finish(h.user, sid(), h.clock.now + 5);
  h.clock.now += 10'000;
  h.startAt(h.clock.now, "ses_00000002");   // nothing logged into it yet

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 1);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(2));
  CHECK_EQ(listed[0].summary.topSet, std::optional<TopWorkingSet>());   // not 0 kg × 0
  CHECK_EQ(listed[1].summary.topSet, std::optional<TopWorkingSet>(TopWorkingSet{100.0, 8}));
}

TEST(log_counts_the_working_sets_apart_from_every_set_and_sums_what_they_moved) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.training.append(h.user, sid(),
                    SetWrite{setId("set_00000001"), ExerciseId{"back-squat"}, 60.0, 10,
                             SetKind::warmup, std::nullopt, "", h.clock.now + 1});
  h.training.append(h.user, sid(),
                    SetWrite{setId("set_00000002"), ExerciseId{"back-squat"}, 100.0, 5,
                             SetKind::working, std::nullopt, "", h.clock.now + 2});
  h.training.append(h.user, sid(),
                    SetWrite{setId("set_00000003"), ExerciseId{"back-squat"}, 100.0, 5,
                             SetKind::working, std::nullopt, "", h.clock.now + 3});
  h.training.append(h.user, sid(), h.bench("set_00000004", 82.5, h.clock.now + 4));   // 82.5 × 8
  h.training.finish(h.user, sid(), h.clock.now + 5);

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 10);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(1));
  CHECK_EQ(listed[0].summary.setCount, 4);
  CHECK_EQ(listed[0].summary.workingSetCount, 3);
  CHECK_EQ(listed[0].summary.tonnageKg, 100.0 * 5 + 100.0 * 5 + 82.5 * 8);   // the warmup is not in
}

// Band-assisted work logs a NEGATIVE load, which adds no tonnage rather than subtracting from it.
TEST(log_gives_an_assisted_or_bodyweight_set_no_tonnage_rather_than_letting_it_subtract) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.training.append(h.user, sid(),
                    SetWrite{setId("set_00000001"), ExerciseId{"back-squat"}, 100.0, 5,
                             SetKind::working, std::nullopt, "", h.clock.now + 1});
  h.training.append(h.user, sid(),
                    SetWrite{setId("set_00000002"), ExerciseId{"bench-press"}, -20.0, 10,
                             SetKind::working, std::nullopt, "", h.clock.now + 2});
  h.training.finish(h.user, sid(), h.clock.now + 3);
  h.clock.now += 10'000;
  h.startAt(h.clock.now, "ses_00000002");
  h.training.append(h.user, sid("ses_00000002"),
                    SetWrite{setId("set_00000003"), ExerciseId{"bench-press"}, 0.0, 9,
                             SetKind::working, std::nullopt, "", h.clock.now + 1});
  h.training.finish(h.user, sid("ses_00000002"), h.clock.now + 2);

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 10);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(2));
  CHECK_EQ(listed[0].summary.workingSetCount, 1);
  CHECK_EQ(listed[0].summary.tonnageKg, 0.0);          // chin-ups moved no measurable load
  CHECK_EQ(listed[1].summary.workingSetCount, 2);
  CHECK_EQ(listed[1].summary.tonnageKg, 500.0);        // the assisted set took nothing away
}

// The estimate is absent exactly where Epley is undefined: a working set at or below zero.
TEST(log_puts_the_domains_estimate_on_the_row_and_omits_it_where_there_is_no_estimate) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.training.append(h.user, sid(),
                    SetWrite{setId("set_00000001"), ExerciseId{"back-squat"}, 100.0, 5,
                             SetKind::working, std::nullopt, "", h.clock.now + 1});
  h.training.finish(h.user, sid(), h.clock.now + 2);
  h.clock.now += 10'000;
  h.startAt(h.clock.now, "ses_00000002");
  h.training.append(h.user, sid("ses_00000002"),
                    SetWrite{setId("set_00000002"), ExerciseId{"bench-press"}, 0.0, 9,
                             SetKind::working, std::nullopt, "", h.clock.now + 1});
  h.training.finish(h.user, sid("ses_00000002"), h.clock.now + 2);
  h.clock.now += 10'000;
  h.startAt(h.clock.now, "ses_00000003");   // warmed up and nothing else
  h.training.append(h.user, sid("ses_00000003"),
                    SetWrite{setId("set_00000003"), ExerciseId{"bench-press"}, 40.0, 10,
                             SetKind::warmup, std::nullopt, "", h.clock.now + 1});
  h.training.finish(h.user, sid("ses_00000003"), h.clock.now + 2);

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
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.training.append(h.user, sid(),
                    SetWrite{setId("set_00000001"), ExerciseId{"back-squat"}, 100.0, 5,
                             SetKind::working, std::nullopt, "", h.clock.now + 1});
  for (int number = 2; number <= 4; ++number)
    h.training.append(h.user, sid(),
                      SetWrite{setId("set_0000000" + std::to_string(number)),
                               ExerciseId{"back-squat"}, 95.0, 10, SetKind::working, std::nullopt,
                               "", h.clock.now + static_cast<std::uint64_t>(number)});
  h.training.finish(h.user, sid(), h.clock.now + 5);

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 10);
  std::optional<Review> finished = h.training.review(h.user, sid());

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(1));
  REQUIRE(finished.has_value());
  CHECK_EQ(listed[0].summary.topSet, std::optional<TopWorkingSet>(TopWorkingSet{100.0, 5}));
  CHECK_EQ(listed[0].topE1rm, e1rm(95.0, 10));         // 126.7, not the top set's 116.7
  CHECK_EQ(listed[0].topE1rm, finished->stats.topE1rm);
  CHECK(e1rm(95.0, 10) > e1rm(100.0, 5));              // the two really do disagree
}

// The store hands over one row per LOAD carrying the best reps at it; Epley rises with reps at a fixed load.
TEST(log_reads_the_stores_per_load_projection_and_lands_where_a_walk_over_every_set_would) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.training.append(h.user, sid(),
                    SetWrite{setId("set_00000001"), ExerciseId{"back-squat"}, 95.0, 6,
                             SetKind::working, std::nullopt, "", h.clock.now + 1});
  h.training.append(h.user, sid(),
                    SetWrite{setId("set_00000002"), ExerciseId{"back-squat"}, 95.0, 10,
                             SetKind::working, std::nullopt, "", h.clock.now + 2});
  h.training.append(h.user, sid(),
                    SetWrite{setId("set_00000003"), ExerciseId{"back-squat"}, 95.0, 8,
                             SetKind::working, std::nullopt, "", h.clock.now + 3});
  h.training.append(h.user, sid(),
                    SetWrite{setId("set_00000004"), ExerciseId{"bench-press"}, 60.0, 12,
                             SetKind::warmup, std::nullopt, "", h.clock.now + 4});
  h.training.finish(h.user, sid(), h.clock.now + 5);

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
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t started = h.clock.now;
  h.startAt(started, "ses_00000001");
  h.training.append(h.user, sid("ses_00000001"), h.bench("set_00000001", 80.0, started + 60'000));
  h.clock.now = started + 3'600'000;
  h.training.finish(h.user, sid("ses_00000001"), started + 3'600'000);   // a tap, an hour later
  h.clock.now = started + 10'000'000;
  h.startAt(h.clock.now, "ses_00000002");   // left running, and never touched again
  h.training.append(h.user, sid("ses_00000002"),
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
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
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
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t tied = h.clock.now;
  for (const auto& [id, startedAtMs] : std::vector<std::pair<std::string, std::uint64_t>>{
           {"ses_00000001", tied + 3}, {"ses_00000002", tied + 2}, {"ses_00000003", tied + 2},
           {"ses_00000004", tied + 1}}) {
    h.startAt(startedAtMs, id);
    h.training.finish(h.user, sid(id), tied + 4);
  }

  std::vector<LogRow> first = h.training.log(h.user, LogCursor{tied + 9, std::nullopt, 2});
  REQUIRE_EQ(first.size(), static_cast<std::size_t>(2));
  std::vector<LogRow> second =
      h.training.log(h.user, LogCursor{first.back().summary.session.startedAtMs,
                                       first.back().summary.session.id, 2});
  REQUIRE_EQ(second.size(), static_cast<std::size_t>(2));
  std::vector<LogRow> third =
      h.training.log(h.user, LogCursor{second.back().summary.session.startedAtMs,
                                       second.back().summary.session.id, 2});

  CHECK_EQ(first[0].summary.session.id, sid("ses_00000001"));
  CHECK_EQ(first[1].summary.session.id, sid("ses_00000003"));
  CHECK_EQ(second[0].summary.session.id, sid("ses_00000002"));   // the tie the old cursor skipped
  CHECK_EQ(second[1].summary.session.id, sid("ses_00000004"));
  CHECK(third.empty());
}

TEST(detail_returns_the_session_with_its_sets_in_completion_order) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now);
  AppendOutcome second = h.training.append(h.user, sid(), h.bench("set_00000002", 82.5, h.clock.now + 2));
  AppendOutcome first = h.training.append(h.user, sid(), h.bench("set_00000001", 80.0, h.clock.now + 1));

  std::optional<SessionDetail> detail = h.training.detail(h.user, sid());

  REQUIRE(detail.has_value());
  REQUIRE(first.set.has_value());
  REQUIRE(second.set.has_value());
  CHECK_EQ(detail->session.id, sid());
  CHECK_EQ(detail->sets, (std::vector<Set>{*first.set, *second.set}));
  CHECK_EQ(h.training.detail(h.other, sid()), std::optional<SessionDetail>());
}

// The read settles the four-hour rule and ends the session STALE, so a phone's owed set still lands.
TEST(detail_settles_a_stale_open_session_at_its_last_set_and_leaves_the_close_revisable) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now);
  h.training.append(h.user, sid(), h.bench("set_00000001", 80.0, h.clock.now + 60'000));
  h.clock.now += kAutoCloseMs + 3'600'000;

  std::optional<SessionDetail> detail = h.training.detail(h.user, sid());

  REQUIRE(detail.has_value());
  CHECK_EQ(detail->session.finishedAtMs, std::optional<std::uint64_t>(h.clock.now - kAutoCloseMs - 3'600'000 + 60'000));
  CHECK(detail->session.closedBy == std::optional<ClosedBy>(ClosedBy::stale));
  AppendOutcome owed = h.training.append(h.user, sid(), h.bench("set_00000002", 82.5, h.clock.now - kAutoCloseMs - 3'600'000 + 120'000));
  CHECK(owed.error == AppendError::none);
}

TEST(last_time_is_the_most_recent_finished_session_never_the_open_one) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  h.training.append(h.user, sid("ses_00000001"), h.bench("set_00000001", 80.0, h.clock.now + 1));
  h.training.finish(h.user, sid("ses_00000001"), h.clock.now + 2);
  h.clock.now += 10'000;
  h.startAt(h.clock.now, "ses_00000002");
  AppendOutcome top =
      h.training.append(h.user, sid("ses_00000002"), h.bench("set_00000002", 82.5, h.clock.now + 1));
  AppendOutcome backOff =
      h.training.append(h.user, sid("ses_00000002"), h.bench("set_00000003", 80.0, h.clock.now + 2));
  h.training.finish(h.user, sid("ses_00000002"), h.clock.now + 3);
  h.clock.now += 10'000;
  h.startAt(h.clock.now, "ses_00000003");
  h.training.append(h.user, sid("ses_00000003"), h.bench("set_00000004", 100.0, h.clock.now + 1));

  LastTimeOutcome last = h.training.lastTime(h.user, ExerciseId{"bench-press"});

  REQUIRE(last.lastTime.has_value());
  REQUIRE(top.set.has_value());
  REQUIRE(backOff.set.has_value());
  CHECK(last.error == LastTimeError::none);
  CHECK_EQ(last.lastTime->session.id, sid("ses_00000002"));
  CHECK_EQ(last.lastTime->routineName, std::string(""));
  CHECK_EQ(last.lastTime->sets, (std::vector<Set>{*top.set, *backOff.set}));
  CHECK_EQ(h.repo.log.session(h.user, sid("ses_00000003")),
           std::optional<Session>(Session(sid("ses_00000003"), h.user, h.clock.now)));
}

TEST(last_time_is_the_working_block_in_set_order_and_never_the_warmups) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.create(h.pushAWrite({benchEntry()}, "rt_00000001", "Bench day"));
  h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  h.training.append(h.user, sid("ses_00000001"),
                    SetWrite{setId("set_00000001"), ExerciseId{"bench-press"}, 40.0, 10,
                             SetKind::warmup, std::nullopt, "", h.clock.now + 1});
  AppendOutcome first =
      h.training.append(h.user, sid("ses_00000001"), h.bench("set_00000002", 82.5, h.clock.now + 2));
  AppendOutcome second =
      h.training.append(h.user, sid("ses_00000001"), h.bench("set_00000003", 82.5, h.clock.now + 3));
  AppendOutcome third =
      h.training.append(h.user, sid("ses_00000001"), h.bench("set_00000004", 80.0, h.clock.now + 4));
  h.training.append(h.user, sid("ses_00000001"),
                    SetWrite{setId("set_00000005"), ExerciseId{"back-squat"}, 100.0, 5,
                             SetKind::working, std::nullopt, "", h.clock.now + 5});
  h.training.finish(h.user, sid("ses_00000001"), h.clock.now + 6);

  LastTimeOutcome last = h.training.lastTime(h.user, ExerciseId{"bench-press"});

  REQUIRE(last.lastTime.has_value());
  REQUIRE(first.set.has_value());
  REQUIRE(second.set.has_value());
  REQUIRE(third.set.has_value());
  CHECK(last.error == LastTimeError::none);
  CHECK_EQ(last.lastTime->routineName, std::string("Bench day"));
  CHECK_EQ(last.lastTime->sets, (std::vector<Set>{*first.set, *second.set, *third.set}));
  // Numbering counts the warmup (max+1 per session and exercise), so the block starts at 2.
  CHECK_EQ(last.lastTime->sets[0].setNumber, 2);
}

TEST(last_time_steps_over_a_session_that_only_warmed_this_movement_up) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  AppendOutcome worked =
      h.training.append(h.user, sid("ses_00000001"), h.bench("set_00000001", 82.5, h.clock.now + 1));
  h.training.finish(h.user, sid("ses_00000001"), h.clock.now + 2);
  h.clock.now += 10'000;
  h.startAt(h.clock.now, "ses_00000002");
  h.training.append(h.user, sid("ses_00000002"),
                    SetWrite{setId("set_00000002"), ExerciseId{"bench-press"}, 40.0, 10,
                             SetKind::warmup, std::nullopt, "", h.clock.now + 1});
  h.training.finish(h.user, sid("ses_00000002"), h.clock.now + 2);

  LastTimeOutcome last = h.training.lastTime(h.user, ExerciseId{"bench-press"});

  REQUIRE(last.lastTime.has_value());
  REQUIRE(worked.set.has_value());
  CHECK(last.error == LastTimeError::none);
  CHECK_EQ(last.lastTime->session.id, sid("ses_00000001"));
  CHECK_EQ(last.lastTime->sets, std::vector<Set>{*worked.set});
}

TEST(last_time_never_reaches_into_another_accounts_log) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  AppendOutcome mine =
      h.training.append(h.user, sid("ses_00000001"), h.bench("set_00000001", 82.5, h.clock.now + 1));
  h.training.finish(h.user, sid("ses_00000001"), h.clock.now + 2);
  h.training.start(h.other, SessionStart{sid("ses_00000009"), h.clock.now + 10});
  AppendOutcome stranger = h.training.append(
      h.other, sid("ses_00000009"),
      SetWrite{setId("set_00000009"), ExerciseId{"bench-press"}, 142.5, 3, SetKind::working,
               std::nullopt, "", h.clock.now + 20});
  h.training.finish(h.other, sid("ses_00000009"), h.clock.now + 30);

  LastTimeOutcome ours = h.training.lastTime(h.user, ExerciseId{"bench-press"});
  LastTimeOutcome theirs = h.training.lastTime(h.other, ExerciseId{"bench-press"});

  REQUIRE(ours.lastTime.has_value());
  REQUIRE(theirs.lastTime.has_value());
  REQUIRE(mine.set.has_value());
  REQUIRE(stranger.set.has_value());
  CHECK(ours.error == LastTimeError::none);
  CHECK_EQ(ours.lastTime->session.id, sid("ses_00000001"));
  CHECK_EQ(ours.lastTime->sets, std::vector<Set>{*mine.set});
  CHECK(theirs.error == LastTimeError::none);
  CHECK_EQ(theirs.lastTime->session.id, sid("ses_00000009"));
  CHECK_EQ(theirs.lastTime->sets, std::vector<Set>{*stranger.set});
}

// Never trained and no such movement are different answers, and only the store can tell them apart.
TEST(last_time_of_a_first_ever_movement_is_a_fact_and_of_an_unknown_one_is_a_fault) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now);
  h.training.append(h.user, sid(), h.bench("set_00000001", 82.5, h.clock.now + 1));
  h.training.finish(h.user, sid(), h.clock.now + 2);
  h.catalog.createExercise(h.other, ExerciseWrite{ExerciseId{"landmine-press"}, "Landmine Press",
                                                  Pattern::press, Equipment::barbell, 2.5});

  LastTimeOutcome firstEver = h.training.lastTime(h.user, ExerciseId{"back-squat"});
  LastTimeOutcome unknown = h.training.lastTime(h.user, ExerciseId{"zercher-squat"});
  LastTimeOutcome anothersCustom = h.training.lastTime(h.user, ExerciseId{"landmine-press"});

  CHECK(firstEver.error == LastTimeError::none);
  CHECK_FALSE(firstEver.lastTime.has_value());
  CHECK(unknown.error == LastTimeError::unknownExercise);
  CHECK_FALSE(unknown.lastTime.has_value());
  CHECK(anothersCustom.error == LastTimeError::unknownExercise);
  CHECK_FALSE(anothersCustom.lastTime.has_value());
}

// The prefill must leave the workout the lifter is in open: a close nobody can see refuses every set after it.
TEST(last_time_never_closes_the_session_the_lifter_is_in) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t started = h.clock.now;
  h.startAt(started, "ses_00000001");
  AppendOutcome lastWeek =
      h.training.append(h.user, sid("ses_00000001"), h.bench("set_00000001", 82.5, started + 1));
  h.training.finish(h.user, sid("ses_00000001"), started + 2);
  const std::uint64_t liveSetAt = started + 4;
  h.clock.now = started + 3;
  h.startAt(h.clock.now, "ses_00000002");
  h.training.append(h.user, sid("ses_00000002"), h.bench("set_00000002", 100.0, liveSetAt));
  h.clock.now = liveSetAt + kAutoCloseMs;   // the live workout now reads as idle past the window

  LastTimeOutcome last = h.training.lastTime(h.user, ExerciseId{"bench-press"});
  AppendOutcome next =
      h.training.append(h.user, sid("ses_00000002"), h.bench("set_00000003", 102.5, h.clock.now + 1));

  REQUIRE(last.lastTime.has_value());
  REQUIRE(lastWeek.set.has_value());
  CHECK(last.error == LastTimeError::none);
  CHECK_EQ(last.lastTime->session.id, sid("ses_00000001"));   // never the live one, closed or not
  CHECK_EQ(last.lastTime->sets, std::vector<Set>{*lastWeek.set});
  CHECK_EQ(h.repo.log.session(h.user, sid("ses_00000002")),
           std::optional<Session>(Session(sid("ses_00000002"), h.user, started + 3)));
  CHECK(next.error == AppendError::none);
  REQUIRE(next.set.has_value());
  CHECK_EQ(next.set->setNumber, 2);
}

TEST(last_time_sees_a_stale_session_once_the_log_read_has_settled_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t started = h.clock.now;
  h.startAt(started, "ses_00000001");
  AppendOutcome older =
      h.training.append(h.user, sid("ses_00000001"), h.bench("set_00000001", 80.0, started + 1));
  h.training.finish(h.user, sid("ses_00000001"), started + 2);
  const std::uint64_t abandonedStart = started + 10'000;
  const std::uint64_t abandonedSetAt = abandonedStart + 1;
  h.clock.now = abandonedStart;
  h.startAt(abandonedStart, "ses_00000002");
  AppendOutcome abandoned =
      h.training.append(h.user, sid("ses_00000002"), h.bench("set_00000002", 82.5, abandonedSetAt));
  h.clock.now = abandonedSetAt + kAutoCloseMs;

  LastTimeOutcome beforeTheLogRead = h.training.lastTime(h.user, ExerciseId{"bench-press"});
  h.logBefore(h.clock.now + 1);
  LastTimeOutcome afterTheLogRead = h.training.lastTime(h.user, ExerciseId{"bench-press"});

  REQUIRE(beforeTheLogRead.lastTime.has_value());
  REQUIRE(afterTheLogRead.lastTime.has_value());
  REQUIRE(older.set.has_value());
  REQUIRE(abandoned.set.has_value());
  CHECK_EQ(beforeTheLogRead.lastTime->session.id, sid("ses_00000001"));
  CHECK_EQ(beforeTheLogRead.lastTime->sets, std::vector<Set>{*older.set});
  CHECK_EQ(afterTheLogRead.lastTime->session.id, sid("ses_00000002"));
  CHECK_EQ(afterTheLogRead.lastTime->session.finishedAtMs,
           std::optional<std::uint64_t>(abandonedSetAt));
  CHECK_EQ(afterTheLogRead.lastTime->sets, std::vector<Set>{*abandoned.set});
}

// Last time is the newest SESSION, never the newest set instant.
TEST(last_time_is_the_newest_session_even_when_an_older_one_holds_a_future_stamped_set) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t day = 86'400'000;
  const std::uint64_t weekAgo = h.clock.now;
  h.startAt(weekAgo, "ses_00000001");
  h.training.append(h.user, sid("ses_00000001"), h.bench("set_00000001", 60.0, weekAgo + 30 * day));
  h.training.finish(h.user, sid("ses_00000001"), weekAgo + 1'000);
  h.clock.now = weekAgo + 7 * day;
  h.startAt(h.clock.now, "ses_00000002");
  AppendOutcome yesterday =
      h.training.append(h.user, sid("ses_00000002"), h.bench("set_00000002", 100.0, h.clock.now + 1));
  h.training.finish(h.user, sid("ses_00000002"), h.clock.now + 2);

  LastTimeOutcome last = h.training.lastTime(h.user, ExerciseId{"bench-press"});
  std::vector<LogRow> listed = h.logBefore(h.clock.now + 10'000);

  REQUIRE(last.lastTime.has_value());
  REQUIRE(yesterday.set.has_value());
  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(2));
  CHECK(last.error == LastTimeError::none);
  CHECK_EQ(last.lastTime->session.id, sid("ses_00000002"));
  CHECK_EQ(last.lastTime->sets, std::vector<Set>{*yesterday.set});
  CHECK_EQ(listed[0].summary.session.id, last.lastTime->session.id);
}

TEST(last_time_names_the_routine_the_session_was_trained_under_not_the_one_stored_today) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.create(h.pushAWrite());
  h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  AppendOutcome landed =
      h.training.append(h.user, sid("ses_00000001"), h.bench("set_00000001", 82.5, h.clock.now + 1));
  h.training.finish(h.user, sid("ses_00000001"), h.clock.now + 2);
  Json::Value renamed(Json::objectValue);
  renamed["name"] = "Bench day";

  h.edit("routine", "rt_00000001", renamed);
  LastTimeOutcome afterRename = h.training.lastTime(h.user, ExerciseId{"bench-press"});
  h.kill(h.user, "routine", "rt_00000001");
  LastTimeOutcome afterDelete = h.training.lastTime(h.user, ExerciseId{"bench-press"});

  REQUIRE(afterRename.lastTime.has_value());
  REQUIRE(afterDelete.lastTime.has_value());
  REQUIRE(landed.set.has_value());
  CHECK(afterRename.error == LastTimeError::none);
  CHECK_EQ(afterRename.lastTime->routineName, std::string("Push A"));
  CHECK_EQ(afterDelete.lastTime->routineName, std::string("Push A"));
  CHECK_EQ(afterDelete.lastTime->session.routine, std::optional<RoutineId>());
  CHECK_EQ(afterDelete.lastTime->session.plan,
           std::optional<PlanSnapshot>(PlanSnapshot{
               "Push A", {PlanEntry{ExerciseId{"bench-press"}, straight(5, 5, 82.5), 180}}}));
  CHECK_EQ(afterDelete.lastTime->sets, std::vector<Set>{*landed.set});
}

TEST(start_from_a_routine_freezes_its_name_and_entries_onto_the_session) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.create(h.pushAWrite(
      {benchEntry(1),
       RoutineEntry{2, ExerciseId{"back-squat"}, straight(3, 8, std::nullopt), std::nullopt}}));

  StartOutcome started = h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");

  const Session frozen(sid("ses_00000001"), h.user, h.clock.now, std::nullopt, rtId(),
                       PlanSnapshot{"Push A",
                                    {PlanEntry{ExerciseId{"bench-press"}, straight(5, 5, 82.5), 180},
                                     PlanEntry{ExerciseId{"back-squat"}, straight(3, 8, std::nullopt),
                                               std::nullopt}}});
  CHECK(started.error == StartError::none);
  CHECK_EQ(started.session, std::optional<Session>(frozen));
  CHECK_EQ(h.sessions(), std::vector<Session>{frozen});
}

TEST(a_routine_line_with_no_rep_target_survives_the_write_and_the_freeze) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  RoutineWriteOutcome created = h.create(h.pushAWrite(
      {RoutineEntry{1, ExerciseId{"dip"}, straight(3, std::nullopt, std::nullopt), 180}}));

  StartOutcome started = h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");

  CHECK(created.error == RoutineWriteError::none);
  REQUIRE(created.routine.has_value());
  CHECK_EQ(created.routine->entries[0].sets, straight(3, std::nullopt, std::nullopt));
  std::optional<Routine> stored = h.program.routine(h.user, rtId());
  REQUIRE(stored.has_value());
  CHECK_EQ(stored->entries[0].sets, straight(3, std::nullopt, std::nullopt));
  CHECK(started.error == StartError::none);
  REQUIRE(started.session.has_value());
  CHECK_EQ(started.session->plan,
           std::optional<PlanSnapshot>(PlanSnapshot{
               "Push A", {PlanEntry{ExerciseId{"dip"}, straight(3, std::nullopt, std::nullopt), 180}}}));
}

// A ramp freezes set for set: the snapshot is the scheme as it stood, not a summary of it.
TEST(start_from_a_routine_holding_a_ramp_freezes_the_ramp_set_for_set) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.create(h.pushAWrite({RoutineEntry{1, ExerciseId{"back-squat"}, ramp(), 240}, benchEntry(2)},
                        "rt_00000001", "Lower A"));

  StartOutcome started = h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");

  CHECK(started.error == StartError::none);
  const PlanSnapshot frozen{"Lower A",
                            {PlanEntry{ExerciseId{"back-squat"}, ramp(), 240},
                             PlanEntry{ExerciseId{"bench-press"}, straight(5, 5, 82.5), 180}}};
  REQUIRE(started.session.has_value());
  CHECK_EQ(started.session->plan, std::optional<PlanSnapshot>(frozen));
  CHECK_EQ(h.sessions(), std::vector<Session>{Session(sid("ses_00000001"), h.user, h.clock.now, std::nullopt,
                                                      rtId(), frozen)});
  std::optional<SessionDetail> detail = h.training.detail(h.user, sid("ses_00000001"));
  REQUIRE(detail.has_value());
  CHECK_EQ(detail->session.plan, std::optional<PlanSnapshot>(frozen));
}

TEST(start_naming_a_routine_this_account_cannot_read_is_refused) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.program.createRoutine(h.other, h.pushAWrite({benchEntry()}, "rt_00000002", "Their plan"), std::nullopt);

  StartOutcome unknown = h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  StartOutcome theirs = h.startFrom(h.clock.now, "ses_00000001", "rt_00000002");

  CHECK(unknown.error == StartError::unknownRoutine);
  CHECK(theirs.error == StartError::unknownRoutine);
  CHECK_FALSE(unknown.session.has_value());
  CHECK_FALSE(theirs.session.has_value());
  CHECK_EQ(h.sessions(), std::vector<Session>{});
}

TEST(start_that_joins_an_open_session_keeps_the_plan_that_session_began_with) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.create(h.pushAWrite({benchEntry()}, "rt_00000001", "Push A"));
  h.create(h.pushAWrite({benchEntry()}, "rt_00000002", "Legs"));
  StartOutcome live = h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");

  StartOutcome joined = h.startFrom(h.clock.now + 5, "ses_00000002", "rt_00000002");
  StartOutcome adHoc = h.startAt(h.clock.now + 6, "ses_00000003");

  const Session pushDay(sid("ses_00000001"), h.user, h.clock.now, std::nullopt, rtId("rt_00000001"),
                        PlanSnapshot{"Push A", {PlanEntry{ExerciseId{"bench-press"}, straight(5, 5, 82.5), 180}}});
  CHECK_EQ(live.session, std::optional<Session>(pushDay));
  CHECK(joined.error == StartError::none);
  CHECK_EQ(joined.session, std::optional<Session>(pushDay));
  CHECK(adHoc.error == StartError::none);
  CHECK_EQ(adHoc.session, std::optional<Session>(pushDay));
  CHECK_EQ(h.sessions(), std::vector<Session>{pushDay});
}

TEST(start_replay_keeps_the_plan_the_session_was_started_under) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.create(h.pushAWrite({benchEntry()}, "rt_00000001", "Push A"));
  h.create(h.pushAWrite({benchEntry()}, "rt_00000002", "Legs"));
  StartOutcome first = h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  h.training.finish(h.user, sid("ses_00000001"), h.clock.now + 1);

  StartOutcome replayed = h.startFrom(h.clock.now, "ses_00000001", "rt_00000002");

  const Session pushDay(sid("ses_00000001"), h.user, h.clock.now, h.clock.now + 1, rtId("rt_00000001"),
                        PlanSnapshot{"Push A", {PlanEntry{ExerciseId{"bench-press"}, straight(5, 5, 82.5), 180}}},
                        ClosedBy::finish);
  REQUIRE(first.session.has_value());
  REQUIRE(replayed.session.has_value());
  CHECK(replayed.error == StartError::none);
  CHECK_EQ(replayed.session, std::optional<Session>(pushDay));
  CHECK_EQ(replayed.session->startedAtMs, first.session->startedAtMs);
  CHECK_EQ(h.sessions(), std::vector<Session>{pushDay});
}

// The routine is loaded only where a session is actually CREATED, so a replay and a join cannot 404.
TEST(start_replay_and_join_survive_a_routine_deleted_since_the_workout_began) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.create(h.pushAWrite({benchEntry()}, "rt_00000001", "Push A"));
  StartOutcome live = h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  h.kill(h.user, "routine", "rt_00000001");

  StartOutcome replayed = h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  StartOutcome joined = h.startFrom(h.clock.now + 5, "ses_00000002", "rt_00000001");

  const Session orphaned(sid("ses_00000001"), h.user, h.clock.now, std::nullopt, std::nullopt,
                         PlanSnapshot{"Push A", {PlanEntry{ExerciseId{"bench-press"}, straight(5, 5, 82.5), 180}}});
  CHECK(live.error == StartError::none);
  CHECK(replayed.error == StartError::none);
  CHECK_EQ(replayed.session, std::optional<Session>(orphaned));
  CHECK(joined.error == StartError::none);
  CHECK_EQ(joined.session, std::optional<Session>(orphaned));
  CHECK_EQ(h.sessions(), std::vector<Session>{orphaned});
}

TEST(start_resolves_its_own_id_before_it_ever_looks_at_a_routine) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.create(h.pushAWrite({benchEntry()}, "rt_00000001", "Push A"));
  h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  h.training.finish(h.user, sid("ses_00000001"), h.clock.now + 1);
  h.startFrom(h.clock.now + 10, "ses_00000002", "rt_00000001");   // and this one stays open
  h.kill(h.user, "routine", "rt_00000001");

  StartOutcome finishedReplay = h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  StartOutcome willNotJoin = h.training.start(
      h.user, SessionStart{sid("ses_00000003"), h.clock.now + 20, false, rtId("rt_00000001")});

  const PlanSnapshot pushA{"Push A", {PlanEntry{ExerciseId{"bench-press"}, straight(5, 5, 82.5), 180}}};
  const Session finished(sid("ses_00000001"), h.user, h.clock.now, h.clock.now + 1, std::nullopt, pushA,
                         ClosedBy::finish);
  CHECK(finishedReplay.error == StartError::none);
  CHECK_EQ(finishedReplay.session, std::optional<Session>(finished));
  CHECK(willNotJoin.error == StartError::alreadyOpen);
  CHECK_FALSE(willNotJoin.session.has_value());
  CHECK_EQ(h.sessions(), (std::vector<Session>{
      finished, Session(sid("ses_00000002"), h.user, h.clock.now + 10, std::nullopt, std::nullopt, pushA)}));
}

TEST(review_of_a_missing_or_anothers_session_is_the_same_absence) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.training.start(h.other, SessionStart{sid("ses_00000002"), h.clock.now - 3'600'000});
  h.training.finish(h.other, sid("ses_00000002"), h.clock.now);

  CHECK_EQ(h.training.review(h.user, sid("ses_00000001")), std::optional<Review>());
  CHECK_EQ(h.training.review(h.user, sid("ses_00000002")), std::optional<Review>());
}

// The review is read AFTER the finish, so the session is kept out of its own history by the (startedAt, id) window.
TEST(review_reads_the_marks_of_earlier_sessions_and_never_the_one_it_is_reviewing) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.trained("ses_00000001", h.clock.now - 2 * kWeek, 100, 5, 4);
  h.trained("ses_00000002", h.clock.now - kWeek, 105, 5, 4);

  std::optional<Review> result = h.training.review(h.user, sid("ses_00000002"));
  std::optional<Review> again = h.training.review(h.user, sid("ses_00000002"));

  // The beaten mark is dated by the SESSION that set it (domain/Review.h).
  const PersonalRecord estimate{RecordKind::e1rm, ExerciseId{"back-squat"}, 122.5, 105.0, 5, 116.7,
                                h.clock.now - 2 * kWeek};
  REQUIRE(result.has_value());
  REQUIRE(result->record.has_value());
  CHECK_EQ(*result->record, estimate);
  CHECK_EQ(result->stats.workingSets, 4);
  CHECK_EQ(result, again);
}

// A workout started two weeks ago that no read has settled yet is still running, however old it is.
TEST(review_never_takes_a_session_still_running_as_history) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.imported("ses_00000002", h.clock.now - kWeek, h.clock.now - kWeek + 3'600'000, 100, 5, 4);
  h.imported("ses_00000003", h.clock.now - 3'600'000, h.clock.now, 105, 5, 4);
  h.running("ses_00000001", h.clock.now - 2 * kWeek, 200, 5, 4);

  std::optional<Review> result = h.training.review(h.user, sid("ses_00000003"));

  REQUIRE(result.has_value());
  REQUIRE(result->record.has_value());
  CHECK_EQ(result->record->previous, 116.7);   // the finished 100 × 5, never the open 200 × 5
  CHECK_EQ(h.repo.log.session(h.user, sid("ses_00000001")),
           std::optional<Session>(Session(sid("ses_00000001"), h.user, h.clock.now - 2 * kWeek)));
}

TEST(review_stands_against_the_last_session_of_the_same_routine) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.create(h.pushAWrite({RoutineEntry{1, ExerciseId{"back-squat"}, straight(5, 5, 100.0), 180}}));
  h.trained("ses_00000001", h.clock.now - 2 * kWeek, 95, 5, 4, "rt_00000001");
  h.trained("ses_00000002", h.clock.now - kWeek, 100, 5, 4);   // the same movement, no day behind it
  h.trained("ses_00000003", h.clock.now - 3'600'000, 105, 5, 4, "rt_00000001");

  std::optional<Review> result = h.training.review(h.user, sid("ses_00000003"));

  const std::vector<AgainstMovement> movements{
      AgainstMovement{ExerciseId{"back-squat"}, TopSet{105, 5, 4}, TopSet{95, 5, 4},
                      PlanEntry{ExerciseId{"back-squat"}, straight(5, 5, 100.0), 180}}};
  REQUIRE(result.has_value());
  REQUIRE(result->against.has_value());
  CHECK_EQ(result->against->session, sid("ses_00000001"));
  CHECK_EQ(result->against->routineName, std::string("Push A"));
  CHECK_EQ(result->against->startedAtMs, h.clock.now - 2 * kWeek);
  CHECK_EQ(result->against->movements, movements);
}

TEST(discard_refuses_a_session_that_is_still_running) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now);
  h.training.append(h.user, sid(), h.bench("set_00000001", 82.5, h.clock.now + 1));

  DiscardOutcome refused = h.training.discard(h.user, sid());

  CHECK(refused == DiscardOutcome::open);
  CHECK_EQ(h.sessions(), std::vector<Session>{Session(sid(), h.user, h.clock.now)});
  CHECK_EQ(h.sets(), std::vector<Set>{Set(setId("set_00000001"), sid(), ExerciseId{"bench-press"}, 1, 82.5,
                                          8, SetKind::working, std::nullopt, "", h.clock.now + 1)});
}

TEST(discard_takes_the_session_and_its_sets_and_asking_twice_is_the_same_fact) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.trained("ses_00000001", h.clock.now - 3'600'000, 100, 5, 4);

  DiscardOutcome first = h.training.discard(h.user, sid("ses_00000001"));
  DiscardOutcome again = h.training.discard(h.user, sid("ses_00000001"));

  CHECK(first == DiscardOutcome::done);
  CHECK(again == DiscardOutcome::notFound);
  CHECK_EQ(h.sessions(), std::vector<Session>{});
  CHECK_EQ(h.sets(), std::vector<Set>{});   // the sets go with the row, never orphaned behind it
}

TEST(discard_never_reaches_another_accounts_session) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.training.start(h.other, SessionStart{sid("ses_00000002"), h.clock.now - 3'600'000});
  h.training.finish(h.other, sid("ses_00000002"), h.clock.now);

  DiscardOutcome theirs = h.training.discard(h.user, sid("ses_00000002"));

  CHECK(theirs == DiscardOutcome::notFound);   // absent and forbidden are one answer
  CHECK_EQ(h.sessions(), std::vector<Session>{Session(sid("ses_00000002"), h.other, h.clock.now - 3'600'000,
                                                      h.clock.now, std::nullopt, std::nullopt,
                                                      ClosedBy::finish)});
}

TEST(statistics_draws_a_point_per_finished_session_and_leaves_the_open_one_out) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.trained("ses_00000001", h.clock.now - 2 * kWeek, 100, 5, 4);
  h.trained("ses_00000002", h.clock.now - kWeek, 105, 5, 4);
  h.startAt(h.clock.now, "ses_00000003");   // today's workout, still being logged into
  h.training.append(h.user, sid("ses_00000003"),
                    SetWrite{setId("set_99999999"), ExerciseId{"back-squat"}, 110, 5,
                             SetKind::working, std::nullopt, "", h.clock.now + 60'000});

  Statistics answer = h.training.statistics(h.user);

  REQUIRE_EQ(answer.movements.size(), static_cast<std::size_t>(1));
  REQUIRE_EQ(answer.movements[0].points.size(), static_cast<std::size_t>(2));
  CHECK_EQ(answer.movements[0].points[0],
           (MovementPoint{h.clock.now - 2 * kWeek, 100, 5, 116.7}));
  CHECK_EQ(answer.movements[0].points[1], (MovementPoint{h.clock.now - kWeek, 105, 5, 122.5}));
  CHECK_EQ(answer.movements[0].lastTrainedAtMs, h.clock.now - kWeek);
}

TEST(statistics_settles_a_session_the_four_hour_rule_already_ended) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t began = h.clock.now - 6 * 3'600'000;
  h.startAt(began, "ses_00000001");
  h.training.append(h.user, sid("ses_00000001"), h.bench("set_00000001", 82.5, began + 60'000));

  Statistics answer = h.training.statistics(h.user);

  CHECK_EQ(h.sessions(), std::vector<Session>{Session(sid("ses_00000001"), h.user, began, began + 60'000,
                                                      std::nullopt, std::nullopt, ClosedBy::stale)});
  REQUIRE_EQ(answer.movements.size(), static_cast<std::size_t>(1));
  CHECK_EQ(answer.movements[0].exercise, ExerciseId{"bench-press"});
}

TEST(statistics_never_reaches_another_accounts_log) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.training.importSession(h.other, SessionImport{sid("ses_00000002"), h.clock.now - kWeek,
                                                  h.clock.now - kWeek + 3'600'000, std::nullopt,
                                                  {SetWrite{setId("set_00000002"), ExerciseId{"back-squat"}, 200,
                                                            5, SetKind::working, std::nullopt, "",
                                                            h.clock.now - kWeek}}});

  Statistics answer = h.training.statistics(h.user);

  CHECK_EQ(answer.movements.size(), static_cast<std::size_t>(0));
  CHECK_EQ(answer.weeks.size(), static_cast<std::size_t>(0));
}

TEST(progress_settles_stale_work_and_reads_only_finished_working_sessions_for_the_owner) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  CHECK_EQ(h.training.progress(h.other), (StatsProgress{h.clock.now, {}}));
  const std::uint64_t began = h.clock.now - 6 * 3'600'000;
  h.startExactly(began - 2'000, "ses_00000003");
  h.training.finish(h.user, sid("ses_00000003"), began);
  h.startExactly(began - 1'000, "ses_00000002");
  h.training.append(h.user, sid("ses_00000002"), SetWrite{setId("set_00000002"), ExerciseId{"bench-press"},
                                                          100, 8, SetKind::warmup, std::nullopt, "", began});
  h.training.finish(h.user, sid("ses_00000002"), began);
  h.training.start(h.other, SessionStart{sid("ses_00000004"), began});
  h.training.append(h.other, sid("ses_00000004"), SetWrite{setId("set_00000004"), ExerciseId{"bench-press"},
                                                           200, 8, SetKind::working, 8, "", began + 60'000});
  h.training.finish(h.other, sid("ses_00000004"), began + 60'000);
  h.startAt(began, "ses_00000001");
  REQUIRE(h.training.append(h.user, sid("ses_00000001"),
      SetWrite{setId("set_00000001"), ExerciseId{"bench-press"}, -10, 8,
               SetKind::working, std::nullopt, "", began + 60'000}).set);

  CHECK_EQ(h.training.progress(h.user), (StatsProgress{h.clock.now, {
      {sid("ses_00000001"), began, {{ExerciseId{"bench-press"}, 1,
          {setId("set_00000001"), -10, 8, std::nullopt}, std::nullopt}}}}}));
  CHECK_EQ(h.repo.log.session(h.user, sid("ses_00000001")),
           std::optional<Session>(Session(sid("ses_00000001"), h.user, began, began + 60'000, std::nullopt,
                                          std::nullopt, ClosedBy::stale)));
}

TEST(progress_reads_corrections_and_deletions_without_cached_or_legacy_estimates) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t startedAtMs = h.clock.now - kWeek;
  h.trained("ses_00000001", startedAtMs, 100, 1, 1);
  const SessionId session = sid("ses_00000001");
  const SetId set = setId("set_000000011");
  const ExerciseId exercise{"back-squat"};
  CHECK_EQ(h.training.progress(h.user), (StatsProgress{h.clock.now, {
      {session, startedAtMs, {{exercise, 1, {set, 100, 1, std::nullopt},
          EstimatedFact{{set, 100, 1, std::nullopt}, 100}}}}}}));

  h.correct(session, SessionCorrectionIn{"correct_00000001", startedAtMs, startedAtMs + 3'600'000, "",
      {CorrectionSetIn{Set{set, session, exercise, 1, 90, 10, SetKind::working, 7.0, "", startedAtMs + 60'000},
                       true, false}}});
  CHECK_EQ(h.training.progress(h.user), (StatsProgress{h.clock.now, {
      {session, startedAtMs, {{exercise, 1, {set, 90, 10, 7},
          EstimatedFact{{set, 90, 10, 7}, 120}}}}}}));

  h.correct(session, SessionCorrectionIn{"correct_00000002", startedAtMs, startedAtMs + 3'600'000, "",
      {CorrectionSetIn{Set{set, session, exercise, 1, 90, 10, SetKind::working, 6.5, "", startedAtMs + 60'000},
                       true, false}}});
  CHECK_EQ(h.training.progress(h.user), (StatsProgress{h.clock.now, {
      {session, startedAtMs, {{exercise, 1, {set, 90, 10, 6.5}, std::nullopt}}}}}));

  h.kill(h.user, "set", set.str());
  CHECK_EQ(h.training.progress(h.user), (StatsProgress{h.clock.now, {}}));
}

TEST(progress_omits_a_current_workout_until_finish) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now, "ses_00000001");
  REQUIRE(h.training.append(h.user, sid("ses_00000001"), h.bench("set_00000001", 90, h.clock.now)).set);
  CHECK_EQ(h.training.progress(h.user), (StatsProgress{h.clock.now, {}}));

  h.training.finish(h.user, sid("ses_00000001"), h.clock.now + 1'000);
  CHECK_EQ(h.training.progress(h.user), (StatsProgress{h.clock.now, {
      {sid("ses_00000001"), h.clock.now, {{ExerciseId{"bench-press"}, 1,
          {setId("set_00000001"), 90, 8, std::nullopt},
          EstimatedFact{{setId("set_00000001"), 90, 8, std::nullopt}, 114}}}}}}));
}

TEST(share_is_idempotent_on_the_session) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.trained("ses_00000001", h.clock.now - kWeek, 100, 5, 4);

  std::optional<SessionShare> first = h.training.share(h.user, sid("ses_00000001"));
  std::optional<SessionShare> again = h.training.share(h.user, sid("ses_00000001"));

  REQUIRE(first);
  REQUIRE(again);
  CHECK_EQ(first->token, again->token);   // one link, not two capabilities to revoke separately
  CHECK_EQ(first->expiresAtMs, h.clock.now + kShareLifetimeMs);
  CHECK_EQ(h.shares(), (std::vector<SessionShare>{SessionShare{sid("ses_00000001"), h.user, first->token,
                                                              h.clock.now + kShareLifetimeMs}}));
}

TEST(share_of_an_absent_or_another_accounts_session_is_one_answer) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.training.start(h.other, SessionStart{sid("ses_00000002"), h.clock.now});
  h.training.finish(h.other, sid("ses_00000002"), h.clock.now + 1);

  CHECK_FALSE(h.training.share(h.user, sid("ses_00000009")));
  CHECK_FALSE(h.training.share(h.user, sid("ses_00000002")));
  CHECK_EQ(h.shares(), std::vector<SessionShare>{});
}

TEST(share_that_has_already_expired_is_replaced_rather_than_returned) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.trained("ses_00000001", h.clock.now - kWeek, 100, 5, 4);
  std::optional<SessionShare> first = h.training.share(h.user, sid("ses_00000001"));
  REQUIRE(first);
  h.clock.now += kShareLifetimeMs + 1;

  std::optional<SessionShare> minted = h.training.share(h.user, sid("ses_00000001"));

  REQUIRE(minted);
  CHECK(minted->token != first->token);
  CHECK_EQ(h.shares(), (std::vector<SessionShare>{SessionShare{sid("ses_00000001"), h.user, minted->token,
                                                              h.clock.now + kShareLifetimeMs}}));
  CHECK_FALSE(h.training.shared(first->token));
}

TEST(shared_session_resolves_a_live_token_and_names_no_account) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.trained("ses_00000001", h.clock.now - kWeek, 100, 5, 4);
  std::optional<SessionShare> minted = h.training.share(h.user, sid("ses_00000001"));
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
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.trained("ses_00000001", h.clock.now - kWeek, 100, 5, 4);
  std::optional<SessionShare> minted = h.training.share(h.user, sid("ses_00000001"));
  REQUIRE(minted);
  CHECK(h.training.shared(minted->token));

  CHECK(h.training.revokeShare(h.user, sid("ses_00000001")));

  CHECK_FALSE(h.training.shared(minted->token));
  CHECK_FALSE(h.training.shared("a token nobody ever minted"));
  CHECK_FALSE(h.training.revokeShare(h.user, sid("ses_00000001")));   // nothing left to revoke
  CHECK_EQ(h.shares(), std::vector<SessionShare>{});
}

// The end is not inclusive: at the instant it names, the link is already gone.
TEST(shared_session_stops_answering_the_moment_the_share_expires) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.trained("ses_00000001", h.clock.now - kWeek, 100, 5, 4);
  std::optional<SessionShare> minted = h.training.share(h.user, sid("ses_00000001"));
  REQUIRE(minted);

  h.clock.now = minted->expiresAtMs;

  CHECK_FALSE(h.training.shared(minted->token));
}

// A stranger holding a link may never write to the owner's log, not even the four-hour close.
TEST(shared_session_never_settles_the_owners_open_session) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t began = h.clock.now - 6 * 3'600'000;
  h.running("ses_00000001", began, 100, 5, 2);
  std::optional<SessionShare> minted = h.training.share(h.user, sid("ses_00000001"));
  REQUIRE(minted);

  CHECK(h.training.shared(minted->token));

  CHECK_EQ(h.repo.log.session(h.user, sid("ses_00000001")),
           std::optional<Session>(Session(sid("ses_00000001"), h.user, began)));
}

TEST(revoke_never_reaches_another_accounts_share) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.training.start(h.other, SessionStart{sid("ses_00000002"), h.clock.now});
  h.training.finish(h.other, sid("ses_00000002"), h.clock.now + 1);
  std::optional<SessionShare> theirs = h.training.share(h.other, sid("ses_00000002"));
  REQUIRE(theirs);

  CHECK_FALSE(h.training.revokeShare(h.user, sid("ses_00000002")));

  CHECK_EQ(h.shares(), (std::vector<SessionShare>{SessionShare{sid("ses_00000002"), h.other, theirs->token,
                                                              h.clock.now + kShareLifetimeMs}}));
  CHECK(h.training.shared(theirs->token));   // and it is still live for the account that minted it
}

TEST(the_log_marks_the_rows_where_a_record_happened) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
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
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
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
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.imported("ses_00000001", h.clock.now - 2 * kWeek, h.clock.now - 2 * kWeek + 3'600'000, 100, 5, 4);
  h.running("ses_00000002", h.clock.now - 3 * 3'600'000, 110, 5, 4);   // never finished
  h.imported("ses_00000003", h.clock.now - 2 * 3'600'000, h.clock.now - 3'600'000, 105, 5, 4);

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 1);
  std::optional<Review> finish = h.training.review(h.user, sid("ses_00000003"));

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(3));
  REQUIRE(finish.has_value());
  CHECK_EQ(listed[0].summary.session.id, sid("ses_00000003"));
  CHECK_EQ(listed[0].record, finish->record.has_value());   // the row and the screen, one judgement
  CHECK(listed[0].record);
  CHECK_EQ(listed[1].summary.session.id, sid("ses_00000002"));
  CHECK_EQ(listed[1].summary.session.finishedAtMs, std::optional<std::uint64_t>());
  CHECK(listed[1].record);
  CHECK_FALSE(listed[2].record);
}

TEST(a_slight_session_gets_no_dot_however_heavy_it_was) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.trained("ses_00000001", h.clock.now, 100, 5, 4);
  h.trained("ses_00000002", h.clock.now + kWeek, 140, 5, kSlightWorkingSets - 1);

  std::vector<LogRow> listed = h.logBefore(h.clock.now + 2 * kWeek);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(2));
  CHECK_EQ(listed[0].summary.session.id, sid("ses_00000002"));
  CHECK_FALSE(listed[0].record);
}

TEST(a_movements_record_answers_the_whole_page_from_one_read) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.create(h.pushAWrite({RoutineEntry{1, ExerciseId{"back-squat"}, straight(5, 5, 100.0), 180}}));
  h.trained("ses_00000001", h.clock.now, 100, 5, 4);
  h.trained("ses_00000002", h.clock.now + kWeek, 105, 5, 4);
  Json::Value renamed(Json::objectValue);
  renamed["name"] = "Low-bar Squat";
  h.edit("exerciseName", "back-squat", renamed);

  std::optional<MovementRecord> page = h.training.movementRecord(h.user, ExerciseId{"back-squat"});

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
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;

  std::optional<MovementRecord> page = h.training.movementRecord(h.user, ExerciseId{"bench-press"});

  REQUIRE(page.has_value());
  CHECK_EQ(page->sessions, 0);
  CHECK(page->routines.empty());
  CHECK_EQ(page->bestE1rm, std::nullopt);
  CHECK(page->series.empty());
  CHECK_EQ(h.training.movementRecord(h.user, ExerciseId{"no-such"}), std::nullopt);
}

TEST(a_fix_rewrites_the_stored_set_and_keeps_the_version_it_replaced) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now);
  h.training.append(h.user, sid(), h.bench("set_00000001", 82.5, h.clock.now + 60'000));
  Json::Value fix(Json::objectValue);
  fix["weightKg"] = 80.0;
  fix["reps"] = 5;

  h.edit("set", "set_00000001", fix);

  CHECK_EQ(h.sets(), std::vector<Set>{Set(setId("set_00000001"), sid(), ExerciseId{"bench-press"}, 1, 80.0,
                                          5, SetKind::working, std::nullopt, "", h.clock.now + 60'000)});
  CHECK_EQ(h.kept(), (std::vector<Kept>{Kept{Set(setId("set_00000001"), sid(), ExerciseId{"bench-press"}, 1,
                                                82.5, 8, SetKind::working, std::nullopt, "",
                                                h.clock.now + 60'000),
                                            false}}));
}

TEST(a_fix_never_reaches_another_accounts_set) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now);
  h.training.append(h.user, sid(), h.bench("set_00000001", 82.5, h.clock.now + 60'000));
  h.training.start(h.other, SessionStart{sid("ses_00000009"), h.clock.now});
  h.training.append(h.other, sid("ses_00000009"),
                    SetWrite{setId("set_00000009"), ExerciseId{"bench-press"}, 100.0, 3, SetKind::working,
                             std::nullopt, "", h.clock.now});
  Json::Value fix(Json::objectValue);
  fix["weightKg"] = 60.0;

  const std::string theirs = GymDoor::refusal(h.admit(h.user, {GymDoor::delta("set", "set_00000009", fix)}));

  CHECK_EQ(theirs, std::string("unknown-record"));
  CHECK_EQ(h.sets(), (std::vector<Set>{
      Set(setId("set_00000009"), sid("ses_00000009"), ExerciseId{"bench-press"}, 1, 100.0, 3, SetKind::working,
          std::nullopt, "", h.clock.now),
      Set(setId("set_00000001"), sid(), ExerciseId{"bench-press"}, 1, 82.5, 8, SetKind::working, std::nullopt,
          "", h.clock.now + 60'000)}));
  CHECK_EQ(h.kept(), std::vector<Kept>{});
}

// The set leaves the live log and moves whole into the kept rows, marked; nothing offers it back.
TEST(a_deleted_set_leaves_the_log_and_is_kept_marked_deleted) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now);
  h.training.append(h.user, sid(), h.bench("set_00000001", 82.5, h.clock.now + 60'000));
  h.training.append(h.user, sid(), h.bench("set_00000002", 85.0, h.clock.now + 120'000));

  h.kill(h.user, "set", "set_00000001");

  CHECK_EQ(h.sets(), std::vector<Set>{Set(setId("set_00000002"), sid(), ExerciseId{"bench-press"}, 2, 85.0,
                                          8, SetKind::working, std::nullopt, "", h.clock.now + 120'000)});
  CHECK_EQ(h.kept(), (std::vector<Kept>{Kept{Set(setId("set_00000001"), sid(), ExerciseId{"bench-press"}, 1,
                                                82.5, 8, SetKind::working, std::nullopt, "",
                                                h.clock.now + 60'000),
                                            true}}));
}

TEST(deleting_a_set_twice_is_the_same_silence_and_reaches_nobody_elses) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now);
  h.training.append(h.user, sid(), h.bench("set_00000001", 82.5, h.clock.now + 60'000));
  h.training.start(h.other, SessionStart{sid("ses_00000009"), h.clock.now});
  h.training.append(h.other, sid("ses_00000009"),
                    SetWrite{setId("set_00000009"), ExerciseId{"bench-press"}, 100.0, 3, SetKind::working,
                             std::nullopt, "", h.clock.now});

  h.kill(h.user, "set", "set_00000001");
  h.kill(h.user, "set", "set_00000001");
  h.kill(h.user, "set", "set_00000009");

  CHECK_EQ(h.sets(), std::vector<Set>{Set(setId("set_00000009"), sid("ses_00000009"), ExerciseId{"bench-press"},
                                          1, 100.0, 3, SetKind::working, std::nullopt, "", h.clock.now)});
  CHECK_EQ(h.kept(), (std::vector<Kept>{Kept{Set(setId("set_00000001"), sid(), ExerciseId{"bench-press"}, 1,
                                                82.5, 8, SetKind::working, std::nullopt, "",
                                                h.clock.now + 60'000),
                                            true}}));
}

// A deleted set's id stays spent to its lifter, so a replayed append answers `deleted`, never `idTaken`.
TEST(a_deleted_set_is_never_logged_again_by_the_queue_that_replays_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now);
  h.training.append(h.user, sid(), h.bench("set_00000001", 80.0, h.clock.now + 60'000));
  h.training.append(h.user, sid(), h.bench("set_00000002", 82.5, h.clock.now + 120'000));
  h.kill(h.user, "set", "set_00000002");

  AppendOutcome replayed =
      h.training.append(h.user, sid(), h.bench("set_00000002", 82.5, h.clock.now + 120'000));

  const Set standing(setId("set_00000001"), sid(), ExerciseId{"bench-press"}, 1, 80.0, 8, SetKind::working,
                     std::nullopt, "", h.clock.now + 60'000);
  CHECK_EQ(replayed.set, std::optional<Set>());
  CHECK(replayed.error == AppendError::deleted);
  CHECK_EQ(h.sets(), std::vector<Set>{standing});
  CHECK_EQ(h.kept(), (std::vector<Kept>{Kept{Set(setId("set_00000002"), sid(), ExerciseId{"bench-press"}, 2,
                                                82.5, 8, SetKind::working, std::nullopt, "",
                                                h.clock.now + 120'000),
                                            true}}));
  h.training.finish(h.user, sid(), h.clock.now + 300'000);
  CHECK(h.training.append(h.user, sid(), h.bench("set_00000002", 82.5, h.clock.now + 120'000)).error ==
        AppendError::deleted);
  CHECK_EQ(h.sets(), std::vector<Set>{standing});
}

// Numbers are not closed up behind a delete: deleting set 2 of 3 leaves 1 and 3, and the next set is 4.
TEST(a_delete_leaves_the_numbers_alone_and_the_next_set_never_reuses_one) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.startAt(h.clock.now);
  h.training.append(h.user, sid(), h.bench("set_00000001", 80.0, h.clock.now + 60'000));
  h.training.append(h.user, sid(), h.bench("set_00000002", 82.5, h.clock.now + 120'000));
  h.training.append(h.user, sid(), h.bench("set_00000003", 85.0, h.clock.now + 180'000));

  h.kill(h.user, "set", "set_00000002");
  AppendOutcome next = h.training.append(h.user, sid(), h.bench("set_00000004", 87.5,
                                                                h.clock.now + 240'000));

  REQUIRE(next.set.has_value());
  CHECK_EQ(next.set->setNumber, 4);
  CHECK_EQ(h.sets(), (std::vector<Set>{
      Set(setId("set_00000001"), sid(), ExerciseId{"bench-press"}, 1, 80.0, 8, SetKind::working,
          std::nullopt, "", h.clock.now + 60'000),
      Set(setId("set_00000003"), sid(), ExerciseId{"bench-press"}, 3, 85.0, 8, SetKind::working,
          std::nullopt, "", h.clock.now + 180'000),
      Set(setId("set_00000004"), sid(), ExerciseId{"bench-press"}, 4, 87.5, 8, SetKind::working,
          std::nullopt, "", h.clock.now + 240'000)}));
}

TEST(fixing_and_deleting_a_set_never_touch_the_frozen_plan_or_the_routine) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.create(h.pushAWrite());
  h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  h.training.append(h.user, sid(), h.bench("set_00000001", 82.5, h.clock.now + 60'000));
  h.training.append(h.user, sid(), h.bench("set_00000002", 82.5, h.clock.now + 120'000));
  const std::optional<Routine> planned = h.program.routine(h.user, rtId());
  REQUIRE(planned.has_value());
  Json::Value fix(Json::objectValue);
  fix["weightKg"] = 60.0;
  fix["reps"] = 3;

  h.edit("set", "set_00000001", fix);
  h.kill(h.user, "set", "set_00000002");

  CHECK_EQ(h.repo.log.session(h.user, sid()),
           std::optional<Session>(Session(sid(), h.user, h.clock.now, std::nullopt, rtId(),
                                          PlanSnapshot{"Push A", {PlanEntry{ExerciseId{"bench-press"},
                                                                            straight(5, 5, 82.5), 180}}})));
  CHECK_EQ(h.program.routine(h.user, rtId()), planned);
  CHECK_EQ(planned->name, std::string("Push A"));
}

TEST(a_correction_moves_the_record_and_every_read_that_stands_on_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t week0 = h.clock.now;
  const std::uint64_t week1 = week0 + kWeek;
  h.trained("ses_00000001", week0, 100, 5, 4);
  h.clock.now = week1;  // a week on, the second squat day starts under a clock that agrees
  h.startAt(week1, "ses_00000002");
  for (int number = 1; number <= 3; ++number)
    h.training.append(h.user, sid("ses_00000002"),
                      SetWrite{setId("set_0000002" + std::to_string(number)),
                               ExerciseId{"back-squat"}, 100, 5, SetKind::working, std::nullopt, "",
                               week1 + static_cast<std::uint64_t>(number) * 60'000});
  h.training.append(h.user, sid("ses_00000002"),
                    SetWrite{setId("set_00000024"), ExerciseId{"back-squat"}, 120, 5,
                             SetKind::working, std::nullopt, "", week1 + 240'000});
  h.clock.now = week1 + 3'600'000;   // the lifter taps finish an hour in, and corrects the workout after
  h.training.finish(h.user, sid("ses_00000002"), week1 + 3'600'000);
  const std::optional<Review> before = h.training.review(h.user, sid("ses_00000002"));
  REQUIRE(before.has_value());
  REQUIRE(before->record.has_value());   // 120 kg, the PR
  SessionCorrectionIn correction{"correct_00000001", week1, week1 + 3'600'000, "", {}};
  for (Set set : h.repo.log.setsOf(sid("ses_00000002"))) {
    if (set.id == setId("set_00000024")) set.weightKg = 90.0;
    correction.sets.push_back(CorrectionSetIn{set, false, false});
  }

  h.correct(sid("ses_00000002"), correction);

  // the session itself
  std::optional<SessionDetail> detail = h.training.detail(h.user, sid("ses_00000002"));
  REQUIRE(detail.has_value());
  REQUIRE_EQ(detail->sets.size(), static_cast<std::size_t>(4));
  CHECK_EQ(detail->sets[3].weightKg, 90.0);
  // the finish readout
  std::optional<Review> review = h.training.review(h.user, sid("ses_00000002"));
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
  std::optional<MovementRecord> page = h.training.movementRecord(h.user, ExerciseId{"back-squat"});
  REQUIRE(page.has_value());
  CHECK_EQ(page->heaviest, std::optional<Best>(Best{100, 5, week0, e1rm(100, 5)}));
  CHECK_EQ(page->bestE1rm, std::optional<Best>(Best{100, 5, week0, e1rm(100, 5)}));
  // the statistics engine
  Statistics stats = h.training.statistics(h.user);
  REQUIRE_EQ(stats.movements.size(), static_cast<std::size_t>(1));
  CHECK_EQ(stats.movements[0].heaviest, std::optional<Best>(Best{100, 5, week0, e1rm(100, 5)}));
  // the prefill the logger puts on screen before a lifter touches anything
  LastTimeOutcome prefill = h.training.lastTime(h.user, ExerciseId{"back-squat"});
  REQUIRE(prefill.lastTime.has_value());
  REQUIRE_EQ(prefill.lastTime->sets.size(), static_cast<std::size_t>(4));
  CHECK_EQ(prefill.lastTime->sets[3].weightKg, 90.0);
}

TEST(a_deleted_set_is_gone_from_the_log_the_review_and_the_session) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.trained("ses_00000001", h.clock.now, 100, 5, 3);

  h.kill(h.user, "set", "set_000000012");

  std::vector<LogRow> rows = h.logBefore(h.clock.now + kWeek);
  REQUIRE_EQ(rows.size(), static_cast<std::size_t>(1));
  CHECK_EQ(rows[0].summary.setCount, 2);
  CHECK_EQ(rows[0].summary.workingSetCount, 2);
  CHECK_EQ(rows[0].summary.tonnageKg, 1000.0);
  std::optional<Review> review = h.training.review(h.user, sid("ses_00000001"));
  REQUIRE(review.has_value());
  CHECK_EQ(review->stats.workingSets, 2);
  std::optional<SessionDetail> detail = h.training.detail(h.user, sid("ses_00000001"));
  REQUIRE(detail.has_value());
  CHECK_EQ(detail->sets.size(), static_cast<std::size_t>(2));
}

TEST(import_settles_a_walked_away_session_first_so_its_span_is_in_the_way) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  const std::uint64_t startedAt = h.clock.now;
  h.startAt(startedAt, "ses_00000001");
  h.training.append(h.user, sid(), h.bench("set_00000001", 80.0, startedAt + 30 * 60'000));
  h.clock.now = startedAt + 30 * 60'000 + kAutoCloseMs;

  const BatchLogOutcome crossing = h.training.importSession(
      h.user, SessionImport{sid("ses_00000002"), startedAt + 10 * 60'000, startedAt + 20 * 60'000,
                            std::nullopt, {h.bench("set_00000002", 60.0, startedAt + 15 * 60'000)}});

  const Session walkedAway{sid("ses_00000001"), h.user, startedAt, startedAt + 30 * 60'000,
                           std::nullopt, std::nullopt, ClosedBy::stale};
  CHECK(crossing.error == BatchLogError::overlap);
  CHECK_EQ(crossing.overlapping, std::optional<Session>(walkedAway));
  CHECK_EQ(h.sessions(), std::vector<Session>{walkedAway});
  CHECK_EQ(h.sets(), std::vector<Set>{Set(setId("set_00000001"), sid(), ExerciseId{"bench-press"}, 1, 80.0, 8,
                                          SetKind::working, std::nullopt, "", startedAt + 30 * 60'000)});
}


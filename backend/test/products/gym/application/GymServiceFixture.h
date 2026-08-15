#pragma once

#include "products/gym/application/CatalogService.h"
#include "products/gym/application/ProgramService.h"
#include "products/gym/application/ThreadService.h"
#include "products/gym/application/TrainingService.h"

#include "test/platform/Fakes.h"
#include "test/products/gym/Fakes.h"
#include "test/testing.h"

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

// The fixture the gym service test files share — one file per service (TrainingServiceTest,
// CatalogServiceTest, ProgramServiceTest, ThreadServiceTest), as GymApiFixture.h is for the HTTP
// files and PgGymFixture.h for the Pg ones. It is ONE harness holding four services over ONE fake
// store, because a case about one service routinely lays rows through another: a start freezes a
// routine the program wrote, a movement's record is trained through the log's doors, a thread's
// export reads the outcome off a proposal. The builders live on the harness — the starts, the
// workouts and the documents the files lay down — and a free helper only one file reaches for (the
// proposal builders) stays in that file.
namespace wm::gym::servicetest {

using namespace wm::gym::fake;

const std::uint64_t kWeek = 604'800'000;

// One repo, one hand-driven clock, both seeds — every test starts here and perturbs one thing.
// PreferencesService is not built: nothing in these files reads the settings, and its two
// pass-throughs are pinned at the wire (PreferencesApiTest).
struct Harness {
  FakeGym repo;
  wm::fake::FakeClock clock;
  wm::fake::FakeTokens tokens;
  TrainingService training{repo.log, repo.program, clock, tokens};
  CatalogService catalog{repo.catalog};
  ProgramService program{repo.program, clock};
  ThreadService threads{repo.threads, clock};

  Harness() {
    repo.db.seed(benchPress());
    repo.db.seed(backSquat());
  }

  StartOutcome startAt(std::uint64_t ms, std::string id = "ses_00000001") {
    return training.start(uid(), SessionStart{sid(std::move(id)), ms});
  }

  // The other door into a workout: the day of the program, named by id and frozen by the server.
  StartOutcome startFrom(std::uint64_t ms, std::string id, std::string routine) {
    return training.start(uid(),
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
    return program.createRoutine(uid(), incoming, std::nullopt);
  }

  // The other Start: "create exactly this session, which is not now" — backfill and lift-import.
  StartOutcome startExactly(std::uint64_t ms, std::string id) {
    return training.start(uid(), SessionStart{sid(std::move(id)), ms, false});
  }

  SetWrite bench(std::string id, double weightKg, std::uint64_t completedAtMs) {
    return SetWrite{setId(std::move(id)), ExerciseId{"bench-press"}, weightKg, 8,
                    SetKind::working, std::nullopt, "", completedAtMs};
  }

  // A whole workout of squats, start to finish — the door the finish surface is read behind. The
  // set ids come off the session's so no test has to mint one, and the sets land a minute apart.
  // Seeds a finished workout at any instant a test names — including one ahead of the harness
  // clock, which the log refuses (canStartAt) — by standing the clock at that instant for the start
  // and handing it back after, so a test's own arithmetic against `clock.now` is untouched.
  void trained(const std::string& session, std::uint64_t startedAtMs, double weightKg, int reps,
               int sets, std::optional<std::string> routine = std::nullopt) {
    const std::uint64_t held = clock.now;
    if (startedAtMs > clock.now) clock.now = startedAtMs;
    training.start(uid(), SessionStart{sid(session), startedAtMs, true,
                                      routine ? std::optional<RoutineId>(rtId(*routine))
                                              : std::nullopt});
    clock.now = held;
    for (int number = 1; number <= sets; ++number)
      training.append(uid(), sid(session),
                     SetWrite{setId("set_" + session.substr(4) + std::to_string(number)),
                              ExerciseId{"back-squat"}, weightKg, reps, SetKind::working,
                              std::nullopt, "",
                              startedAtMs + static_cast<std::uint64_t>(number) * 60'000});
    training.finish(uid(), sid(session), startedAtMs + 3'600'000);
  }

  // The same workout put straight into the store, for the one state the service's own doors cannot
  // produce: a session left open BEHIND a later one, which the one-open index makes unreachable
  // through start (and which a start would settle before it ever answered).
  void stored(const std::string& session, std::uint64_t startedAtMs,
              std::optional<std::uint64_t> finishedAtMs, double weightKg, int reps, int sets) {
    repo.db.sessions.push_back(Session{sid(session), uid(), startedAtMs, finishedAtMs});
    for (int number = 1; number <= sets; ++number)
      repo.db.sets.push_back(Set{setId("set_" + session.substr(4) + std::to_string(number)),
                              sid(session), ExerciseId{"back-squat"}, number, weightKg, reps,
                              SetKind::working, std::nullopt, "",
                              startedAtMs + static_cast<std::uint64_t>(number) * 60'000});
  }

  std::vector<LogRow> logBefore(std::uint64_t beforeMs, int limit = 50) {
    return training.log(uid(), LogCursor{beforeMs, std::nullopt, limit});
  }
};

}

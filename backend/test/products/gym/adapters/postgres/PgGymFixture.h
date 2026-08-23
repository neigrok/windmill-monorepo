#pragma once

#include "products/gym/ports/AskThreadRepository.h"
#include "products/gym/ports/LogRepository.h"
#include "products/gym/ports/ProgramRepository.h"
#include "test/PgTestPool.h"

#include <pqxx/pqxx>

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

// The fixture every gym Postgres test file shares: opt-in integration tests that run only when WM_PG_TEST is set, otherwise reporting `skip`.
namespace wm::gym::pgtest {
inline const char* kNeedsPostgres = "WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7";

inline const std::string kUser = "22222222-2222-2222-2222-222222222222";
inline const std::string kOther = "22222222-2222-2222-2222-222222222233";

// The instant every write that dates something is driven by, as a value so an assertion can name it.
constexpr std::uint64_t kNow = 1'700'000'000'000ull;

inline void reset() {
  wm::PgLease c{*wm::pgTestPool()};
  pqxx::work w{*c};
  w.exec("INSERT INTO users (id, email) VALUES ('" + kUser + "', 'gym-pgtest@example.com') "
         "ON CONFLICT (id) DO NOTHING");
  w.exec("INSERT INTO users (id, email) VALUES ('" + kOther + "', 'gym-pgtest-b@example.com') "
         "ON CONFLICT (id) DO NOTHING");
  // FK order, and the routines before the exercises: an entry references a movement.
  w.exec("DELETE FROM gym_set_revisions WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_sets WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_sessions WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_proposal_changes WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_proposals WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_ask_turns WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_ask_threads WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_routines WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_exercise_names WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_exercise_aliases WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_exercises WHERE created_by IN ('" + kUser + "', '" + kOther + "')");
  w.exec("DELETE FROM gym_preferences WHERE user_id IN ('" + kUser + "', '" + kOther + "')");
  w.commit();
}

inline Session sessionAt(const std::string& id, std::uint64_t startedAtMs) {
  return Session{SessionId{id}, wm::UserId{kUser}, startedAtMs};
}

// The create as the app's own route makes one: the LIFTER's hand, naming no agent door.
constexpr std::uint64_t kBuiltAtMs = 1'700'000'000'000;

inline RoutineWriteOutcome inserted(ProgramRepository& repo, const Routine& incoming) {
  return repo.insertRoutine(incoming, std::nullopt, kBuiltAtMs);
}

inline RoutineEntry entryAt(int position, const std::string& exercise,
                            std::optional<int> targetSets = 5, std::optional<int> targetReps = 5,
                            std::optional<double> targetWeightKg = 82.5,
                            std::optional<int> restSeconds = 180) {
  return RoutineEntry{position, ExerciseId{exercise}, targetSets, targetReps, targetWeightKg,
                      restSeconds};
}

inline Routine routineAt(const std::string& id, const std::string& name,
                         std::vector<RoutineEntry> entries) {
  return Routine{RoutineId{id}, wm::UserId{kUser}, name, 0, std::move(entries)};
}

inline PlanSnapshot pushA() {
  return PlanSnapshot{"Push A", {PlanEntry{ExerciseId{"bench-press"}, 5, 5, 82.5, 180}}};
}

inline LogCursor page(std::uint64_t beforeMs, int limit) {
  return LogCursor{beforeMs, std::nullopt, limit};
}

// The rows of a page, for the cases that are about the rows.
inline std::vector<SessionSummary> pageOf(LogRepository& repo, const wm::UserId& user,
                                          const LogCursor& cursor) {
  return repo.log(user, cursor).sessions;
}

inline Set benchSet(const std::string& id, double weightKg, std::uint64_t completedAtMs,
                    const std::string& session = "ses_pg000001") {
  return Set{SetId{id}, SessionId{session}, ExerciseId{"bench-press"}, 0, weightKg, 8,
             SetKind::working, std::nullopt, "", completedAtMs};
}

// The reps are what the marks are made of, so the finish read's fixture states them.
inline Set squatSet(const std::string& id, const std::string& session, double weightKg, int reps,
                    std::uint64_t completedAtMs, SetKind kind = SetKind::working) {
  return Set{SetId{id}, SessionId{session}, ExerciseId{"back-squat"}, 0, weightKg, reps, kind,
             std::nullopt, "", completedAtMs};
}

inline RoutineProposal proposalAt(const std::string& id, const std::string& routine,
                                  int baseRevision, std::vector<RoutineEntry> becomes,
                                  ProposalDoor door = ProposalDoor::mcp,
                                  const std::string& owner = kUser,
                                  std::optional<ThreadId> thread = std::nullopt) {
  const std::vector<RoutineEntry> base{entryAt(1, "bench-press")};
  std::vector<RoutineChange> changes = changesBetween(base, becomes);
  const int counted = becomes.empty() ? static_cast<int>(changes.size())
                                      : countedChanges(base, changes, "Push A", "Push A");
  return RoutineProposal{ProposalHead{ProposalId{id}, RoutineId{routine}, wm::UserId{owner},
                                      becomes.empty() ? ProposalIntent::remove
                                                      : ProposalIntent::revise,
                                      ProposalState::pending,
                                      ProposalSource{door, "", "", thread},
                                      "Heavier triples.", counted, kNow, std::nullopt},
                         baseRevision, "Push A", "Push A", std::move(changes)};
}

inline RoutineEntry benchAt(double weightKg, int reps) {
  return RoutineEntry{1, ExerciseId{"bench-press"}, 5, reps, weightKg, 180};
}

// The two writes an ask makes, in order: the thread lands before the model runs, the turns once an answer has.
inline AskThread openedAt(AskThreadRepository& repo, const std::string& id,
                          const std::string& title, std::uint64_t atMs = kNow) {
  const ThreadOpenOutcome opened = repo.openThread(wm::UserId{kUser}, ThreadId{id}, title, atMs);
  return opened.thread.value();
}

inline void said(AskThreadRepository& repo, const std::string& id, const std::string& question,
                 const std::string& answer, std::uint64_t atMs = kNow) {
  repo.appendTurns(wm::UserId{kUser}, ThreadId{id},
                   {ThreadTurn{true, question, atMs}, ThreadTurn{false, answer, atMs}});
}
}

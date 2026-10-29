#pragma once

#include "products/gym/domain/Progress.h"
#include "products/gym/domain/Training.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// A session's top estimate: the highest e1RM any of its sets earned, never the heaviest set's. Absent where
// none earned one.
std::optional<double> topE1rmOf(const std::vector<ProgressSet>& sets);

// `standing` is every set of the movements this session works, from the FINISHED sessions that started
// before it. `previous` is the newest FINISHED session sharing this one's routine and starting earlier;
// `previousSets` are its sets in the order they were performed.
struct SessionHistory {
  std::vector<ProgressSet> standing;
  std::optional<Session> previous;
  std::vector<Set> previousSets;

  bool operator==(const SessionHistory&) const = default;
};

// Declared in PREFERENCE order, which is what makes `<` the ranking: a session earns at most one
// record. One-way, so there is no parse and no clamp beside toString.
enum class RecordKind { e1rm, heaviest, repsAtWeight };

std::string toString(RecordKind kind);

// `value` is the number the record is about, `previous` the number it beat, dated by previousAtMs, the start of the
// session that set it; weightKg and reps locate the set that did it. A record requires a mark to have been PASSED,
// so a first entry is not a record. An e1RM record's two numbers keep full precision.
struct PersonalRecord {
  RecordKind kind;
  ExerciseId exercise;
  double value;
  double weightKg;
  int reps;
  double previous;
  std::uint64_t previousAtMs;

  bool operator==(const PersonalRecord&) const = default;
};

// The three record rules: best e1RM for a movement · heaviest load for any reps · most reps at a load it has used
// before. `today` is one FINISHED session's sets, `standing` those of the finished sessions before it; the
// reply is that session's single line, ranked kind ▸ the set's estimate score ▸ load ▸ movement id. Every rule
// requires a mark to have been PASSED, and each movement is judged against its own sets alone.
std::optional<PersonalRecord> recordAgainst(const std::vector<ProgressSet>& today,
                                            const std::vector<ProgressSet>& standing);

// A row of the log as the record walk reads it: its sets, and whether it is over.
struct WorkedSession {
  SessionId session;
  bool finished;
  std::vector<ProgressSet> sets;

  bool operator==(const WorkedSession&) const = default;
};

// Which sessions of a page earned a record. `page` arrives OLDEST FIRST and `standing` are the sets that
// stood before the oldest of them; the walk folds each finished session into the standing sets as it passes.
// A session under kSlightSets earns nothing, but its sets still fold in. An UNFINISHED session earns nothing
// and its sets do NOT fold: its workout is not over.
std::vector<SessionId> recordedIn(const std::vector<WorkedSession>& page,
                                  const std::vector<ProgressSet>& standing);

// Top is the HEAVIEST load, ties broken by more reps and then by the earlier set — never by volume
// and never by e1RM. `sets` counts only sets at the top load.
struct TopSet {
  double weightKg;
  int reps;
  int sets;

  bool operator==(const TopSet&) const = default;
};

// Today, last time (absent when that session did not train it), and what the frozen plan asked for
// (absent when the plan did not name it).
struct AgainstMovement {
  ExerciseId exercise;
  TopSet now;
  std::optional<TopSet> before;
  std::optional<PlanEntry> planned;

  bool operator==(const AgainstMovement&) const = default;
};

// The movements of THIS session in the order they were first performed. routineName is read off the
// previous session's own frozen snapshot, never off the routine as it is called today.
struct Against {
  SessionId session;
  std::string routineName;
  std::uint64_t startedAtMs;
  std::vector<AgainstMovement> movements;

  bool operator==(const Against&) const = default;
};

// durationMs is the span the session covers — start to finish, or to its last set while it is still
// open — and topE1rm is absent when no set in it earned an estimate.
struct ReviewStats {
  std::uint64_t durationMs;
  int workingSets;
  std::optional<double> topE1rm;

  bool operator==(const ReviewStats&) const = default;
};

// Under this many sets a session says nothing beyond its three facts.
constexpr int kSlightSets = 4;

// The finish surface, computed on every read and stored nowhere.
struct Review {
  ReviewStats stats;
  bool slight;
  std::optional<PersonalRecord> record;
  std::optional<Against> against;

  bool operator==(const Review&) const = default;
};

// Every set counts. At most one record and only for a finished session that passed a mark, and a comparison only for
// a session that named a routine. `sets` arrive in the order they were performed.
Review review(const Session& session, const std::vector<Set>& sets, const SessionHistory& history);

}

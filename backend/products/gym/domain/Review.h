#pragma once

#include "products/gym/domain/Training.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// Epley — weight × (1 + reps / 30). Defined only for a LOADED set: at or below zero there is no
// estimate. Rounded to one decimal, and that rounded value is what every rule below compares.
std::optional<double> e1rm(double weightKg, int reps);

// Every distinct load of a movement, carrying the BEST reps done at it — the one projection of
// working sets in this product; only the window varies by caller. atMs is the earliest SESSION those
// best reps were hit in, never a set's completed_at, which is the device's wall clock. `marksOf`
// below is the one exception.
struct PriorMark {
  ExerciseId exercise;
  double weightKg;
  int reps;
  std::uint64_t atMs;

  bool operator==(const PriorMark&) const = default;
};

// The projection above over one session's sets. WORKING sets only: a warmup, a drop and a failure
// make no mark. These marks carry the SET's instant rather than the session's, and a date read out
// of them never reaches a surface.
std::vector<PriorMark> marksOf(const std::vector<Set>& sets);

// The best over EVERY working set, never the estimate of the heaviest one. Absent exactly where
// Epley is undefined.
std::optional<double> topE1rmOf(const std::vector<PriorMark>& marks);

// `previous` is the newest FINISHED session sharing this one's routine and starting earlier;
// `previousSets` are its sets in the order they were performed.
struct SessionHistory {
  std::vector<PriorMark> marks;
  std::optional<Session> previous;
  std::vector<Set> previousSets;

  bool operator==(const SessionHistory&) const = default;
};

// Declared in PREFERENCE order, which is what makes `<` the ranking: a session earns at most one
// record. One-way, so there is no parse and no clamp beside toString.
enum class RecordKind { e1rm, heaviest, repsAtWeight };

std::string toString(RecordKind kind);

// `value` is the number the record is about, `previous` the number it beat, dated by previousAtMs;
// weightKg and reps locate the set that did it. A record requires a mark to have been PASSED, so a
// first entry is not a record.
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

// The three record rules: best e1RM for a movement · most reps at a load it has used before ·
// heaviest load for any reps. `earned` is what one session made of its working sets, `standing` the
// marks that stood before it; the reply is that session's single line, ranked kind ▸ e1RM ▸ load ▸
// the earlier set. Every rule requires a mark to have been PASSED, and each movement is judged
// against its own marks alone.
std::optional<PersonalRecord> recordAgainst(const std::vector<PriorMark>& earned,
                                            const std::vector<PriorMark>& standing);

// The count cannot be recovered from the marks, which collapse a session's sets. `finished` is
// required because the finish read stands a session against its FINISHED predecessors alone, and a
// page is not sorted by finishedness.
struct SessionMarks {
  SessionId session;
  std::vector<PriorMark> marks;
  int workingSets;
  bool finished;

  bool operator==(const SessionMarks&) const = default;
};

// Which sessions of a page earned a record. `page` arrives OLDEST FIRST and `standing` are the
// marks that stood before the oldest of them; the walk folds each session into the standing marks as
// it passes.
// A session under kSlightWorkingSets earns nothing, but its marks still fold in. An UNFINISHED
// session is judged like any other and its marks do NOT fold.
std::vector<SessionId> recordedIn(const std::vector<SessionMarks>& page,
                                  const std::vector<PriorMark>& standing);

// Top is the HEAVIEST load, ties broken by more reps and then by the earlier set — never by volume
// and never by e1RM, which is undefined at and below zero. `sets` counts only sets at the top load.
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
// open — and topE1rm is absent when nothing in it was loaded.
struct ReviewStats {
  std::uint64_t durationMs;
  int workingSets;
  std::optional<double> topE1rm;

  bool operator==(const ReviewStats&) const = default;
};

// Under this many working sets a session says nothing beyond its three facts.
constexpr int kSlightWorkingSets = 4;

// The finish surface, computed on every read and stored nowhere.
struct Review {
  ReviewStats stats;
  bool slight;
  std::optional<PersonalRecord> record;
  std::optional<Against> against;

  bool operator==(const Review&) const = default;
};

// Working sets only, at most one record and only where a mark was passed, and a comparison only for
// a session that named a routine. `sets` arrive in the order they were performed.
Review review(const Session& session, const std::vector<Set>& sets, const SessionHistory& history);

}

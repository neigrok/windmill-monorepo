#pragma once

#include "products/gym/domain/Training.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// Epley — weight × (1 + reps / 30) — and the number the finish screen leads with, because it is the
// only one that compares 5×100 against 3×110 honestly. It is defined ONLY for a LOADED set: a
// chin-up at 0 kg and a band-assisted pull-up at −20 have no honest one-rep estimate, and inventing
// one would put a fictional number in the product's loudest pixel. The answer comes back rounded to
// the one decimal the screen prints, and that rounded value is what every rule below compares — a
// record the product cannot show is not a record, and float noise must never be able to mint one.
std::optional<double> e1rm(double weightKg, int reps);

// Every distinct load of a movement, carrying the BEST reps ever done at it in a finished session
// that started before this one. The shape is deliberate: at a fixed weight e1RM rises with reps, so
// the best-repped set at a load IS the best set at that load — which makes all three record rules
// answerable from these rows alone, and means the Epley formula never has to exist in SQL (the
// ladder lesson of §11.5 applied to the second formula in the product: one copy per language, none
// in the database). Small by construction: a lifter uses a few dozen distinct loads per movement in
// a lifetime. atMs dates the mark — the earliest instant those best reps were hit, which is the day
// the mark was set and the date the record line prints beside the number it beat.
struct PriorMark {
  ExerciseId exercise;
  double weightKg;
  int reps;
  std::uint64_t atMs;

  bool operator==(const PriorMark&) const = default;
};

// Everything the finish rules need that is not in the session itself, as one value the port returns
// in one read. It is a DOMAIN type on purpose: the review is pure, so nothing under domain/ may
// depend on ports/, and the store hands its answers across in the shape the rule reads them in.
// previous is the newest FINISHED session sharing this one's routine and starting earlier, and
// previousSets are its sets in the order they were performed — the port's contract, which the rule
// trusts rather than re-derives.
struct SessionHistory {
  std::vector<PriorMark> marks;
  std::optional<Session> previous;
  std::vector<Set> previousSets;

  bool operator==(const SessionHistory&) const = default;
};

// Declared in PREFERENCE order, which is what makes `<` the ranking: a session earns at most one
// record and the domain picks it, so web and iOS can never disagree about which line is the loud
// one. There is no parse and no clamp beside this toString — a record kind is computed at read
// time and travels one way, so nothing ever reads one back out of a request or a column.
enum class RecordKind { e1rm, heaviest, repsAtWeight };

std::string toString(RecordKind kind);

// The one line, when a session earns one. `value` is the number the record is about — the e1RM, the
// load, or the reps — and `previous` is the number it beat, dated by previousAtMs; weightKg and
// reps locate the set that did it, so the screen prints "105 × 5" under any of the three kinds.
// A record requires a mark to have been PASSED: with no prior history there is nothing to beat, so
// a first entry is not a record, and claiming otherwise devalues every later one.
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

// The top working set of one movement, and how many sets were done AT that load. Top is the
// HEAVIEST load, ties broken by more reps and then by the earlier set — never by volume, because
// four light sets must not beat three heavy ones, and never by e1RM, which is undefined at and
// below zero and would leave the chin-up row uncomparable. `sets` counts only the sets at the top
// load, so three heavy sets and two back-offs read as "3 × 5 @ 100" and never as five.
struct TopSet {
  double weightKg;
  int reps;
  int sets;

  bool operator==(const TopSet&) const = default;
};

// One movement's line of the comparison: what it was today, what it was last time (absent when that
// session did not train it), and what the frozen plan asked for (absent when the plan did not name
// it). A fact with a direction, never a grade — no score, no percentage, nothing green or red.
struct AgainstMovement {
  ExerciseId exercise;
  TopSet now;
  std::optional<TopSet> before;
  std::optional<PlanEntry> planned;

  bool operator==(const AgainstMovement&) const = default;
};

// The comparison band: which session it stands against, and the movements of THIS session in the
// order they were first performed. routineName is the name the previous session was trained under,
// read off its own frozen snapshot and never off the routine as it is called today — the rule the
// prefill card already obeys (§5), because a routine renamed since must not rewrite what the log
// says about the past.
struct Against {
  SessionId session;
  std::string routineName;
  std::uint64_t startedAtMs;
  std::vector<AgainstMovement> movements;

  bool operator==(const Against&) const = default;
};

// The three facts, and on an ordinary session they are the whole of the finish screen. durationMs
// is the span the session covers — start to finish, or to its last set while it is still open — and
// topE1rm is absent when nothing in it was loaded.
struct ReviewStats {
  std::uint64_t durationMs;
  int workingSets;
  std::optional<double> topE1rm;

  bool operator==(const ReviewStats&) const = default;
};

// Under this many working sets a session says nothing beyond its three facts: a three-set session
// is usually a phone left running, and there is nothing honest to say about eleven minutes.
// Duration is deliberately NOT in the predicate — a heavy triple day is short and real, and a
// forgotten phone is long and empty.
constexpr int kSlightWorkingSets = 4;

// The finish surface, computed on every read and stored nowhere. Around 190 sessions in 200 earn no
// record, and the space one would occupy is left empty on purpose: nothing here says well done, and
// nothing implies a session was wasted.
struct Review {
  ReviewStats stats;
  bool slight;
  std::optional<PersonalRecord> record;
  std::optional<Against> against;

  bool operator==(const Review&) const = default;
};

// The whole judgement of the feature, pure and clock-free: working sets only — a warmup, a drop and
// a failure count toward nothing — at most one record and only where a mark was passed, and a
// comparison only for a session that named a routine. `sets` arrive in the order they were
// performed, which is the port's order, and that order is what the comparison prints.
Review review(const Session& session, const std::vector<Set>& sets, const SessionHistory& history);

}

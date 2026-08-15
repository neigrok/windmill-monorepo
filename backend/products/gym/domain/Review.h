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

// Every distinct load of a movement, carrying the BEST reps done at it — the ONE projection of
// working sets in this product, and every rule that reads training history reads it. The WINDOW is
// the caller's and nothing else changes: the finish read fills these from the finished sessions
// before the one being reviewed, the log's page read fills one set of them per session on the page
// AND one set for everything standing before it, the statistics read fills them over a whole
// account, and the record page fills them per session for one movement.
//
// The shape is deliberate: at a fixed weight e1RM rises with reps, so the best-repped set at a load
// IS the best set at that load — which makes all three record rules and the e1RM estimate
// answerable from these rows alone, and means the Epley formula never has to exist in SQL (the
// ladder lesson of §11.5 applied to the second formula in the product: one copy per language, none
// in the database). Small by construction: a lifter uses a few dozen distinct loads per movement in
// a lifetime. atMs dates the mark — the EARLIEST SESSION those best reps were hit in, which is the
// day the mark was set and the date the record line prints beside the number it beat.
//
// A projection narrowed to one movement repeats that movement's id on every row, and that is the
// price of one type serving every rule rather than two that could drift: the field costs memory in
// a vector nothing on the wire ever sees.
//
// WHAT DATES A MARK: the SESSION it was set in, wherever the STORE fills these rows. A set's
// completed_at is the device's wall clock (§2.2) and nothing ties it to the session it landed in,
// so an evening session whose best set landed after midnight would date a mark to a day the lifter
// did not train — and it did: the same standing best came off `GET /v1/gym/stats` on one calendar
// day and off the record page on another, because one read dated it by the set and the other by the
// workout. One rule now: a mark read out of the LOG is dated to the workout that set it, which is
// the day every surface prints beside it. `marksOf` below is the exception and states its reason.
struct PriorMark {
  ExerciseId exercise;
  double weightKg;
  int reps;
  std::uint64_t atMs;

  bool operator==(const PriorMark&) const = default;
};

// The projection above, taken over one session's sets by a caller that already holds them — the
// finish read does; the log's page read does not and has the store make it instead. WORKING sets
// only: a warmup, a drop and a failure make no mark, which is the rule every record rule obeys, so
// it is applied here rather than left to each caller to remember.
//
// These marks carry the SET's instant rather than the session's, which is the one exception to the
// rule above and not really one: inside a single workout the set instants are the only ordering
// there is, and the ranking below breaks its last tie on the earlier set. A date read out of these
// never reaches a surface — only a PRIOR mark's does, and priors are the store's.
std::vector<PriorMark> marksOf(const std::vector<Set>& sets);

// The best one-rep estimate a set of marks earned, and the ONE definition of it in the product —
// the finish screen, the log row and the record page's every bar come through here, which is what
// stops one workout from carrying two numbers under the word `e1RM`. It is the best estimate over
// EVERY working set and deliberately not the estimate over the heaviest one: a lifter who squats
// 100 × 5 and then three back-offs at 95 × 10 earned 126.7, and the top set's own 116.7 is the
// smaller, later-superseded answer. Absent exactly where Epley is undefined — no working set at
// all, or none of them loaded.
std::optional<double> topE1rmOf(const std::vector<PriorMark>& marks);

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

// The three record rules of §2.4, and the ONE implementation of them: best e1RM for a movement ·
// most reps at a load it has used before · heaviest load for any reps. `earned` is what one session
// made of its working sets, `standing` the marks that stood before it, and the reply is the single
// line that session gets — ranked kind ▸ e1RM ▸ load ▸ the earlier set, so the finish screen and
// the log's gold dot can never disagree about whether a workout earned one.
//
// Every rule requires a mark to have been PASSED: with no prior history there is nothing to beat,
// so a first session claims nothing and claiming otherwise devalues every later one. Both sides
// carry every movement, and each movement is judged against its own marks alone.
std::optional<PersonalRecord> recordAgainst(const std::vector<PriorMark>& earned,
                                            const std::vector<PriorMark>& standing);

// One session as the log's record walk reads it: what its working sets made, how many of them there
// were, and whether the workout is over. The count cannot be recovered from the marks — they
// collapse a session's sets — and the slight rule below is stated in working sets.
//
// `finished` is what keeps the walk and the finish read reading ONE history. The finish read stands
// a session against its FINISHED predecessors (the store's window, ports/LogRepository.h), so
// a page that folded an open workout into the marks would judge the row above it against history
// that session's own finish screen cannot see. A page is not sorted by finishedness — started_at is
// the device's, one-open-at-a-time is the only rule, and a queued offline start flushed late puts an
// open row in the middle of a page — so the walk cannot assume the open one is on top.
struct SessionMarks {
  SessionId session;
  std::vector<PriorMark> marks;
  int workingSets;
  bool finished;

  bool operator==(const SessionMarks&) const = default;
};

// Which sessions of a page earned a record — the log's gold dot, and the same three rules the
// finish screen runs, walked forward over a page instead of asked about one workout. `page` arrives
// OLDEST FIRST and `standing` are the marks that stood before the oldest of them; the walk folds
// each session into the standing marks as it passes, so every session is judged against the log as
// it stood that day and never against what came after.
//
// A session under kSlightWorkingSets earns no dot, exactly as its own finish screen says nothing —
// two surfaces printing different verdicts on one workout is the drift this shared rule exists to
// prevent. Its marks still fold in: the sets happened, and the slight rule is about what a screen
// says, not about what the log holds.
//
// An UNFINISHED session is judged like any other — its own finish screen judges it mid-workout, so
// the log must say the same thing — and its marks do NOT fold: the workout is not over, and the
// finish read of every session after it counts finished ones alone.
//
// The dot means a record happened here, judged against the log AS IT IS NOW. It is not frozen at
// finish time: a correction that moves a record moves the dot with it, and a dot that lied after a
// fix would be worse than no dot at all.
std::vector<SessionId> recordedIn(const std::vector<SessionMarks>& page,
                                  const std::vector<PriorMark>& standing);

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

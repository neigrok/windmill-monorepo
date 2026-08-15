#pragma once

#include "platform/domain/Ids.h"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace wm::gym {

// A malformed piece of training data — a bad id, an out-of-range weight, an unknown set kind.
// Thrown at the boundary where an entity is constructed from untrusted input, caught in HTTP → 400,
// so an invalid set can never exist in memory, let alone become a row.
struct InvalidTraining : std::runtime_error {
  using std::runtime_error::runtime_error;
};

struct ExerciseTag;
struct SessionTag;
struct SetTag;
struct RoutineTag;

using ExerciseId = Id<ExerciseTag>;
using SessionId = Id<SessionTag>;
using SetId = Id<SetTag>;
using RoutineId = Id<RoutineTag>;

// Pattern is the only classification (the flat legs-vs-three-arm-buckets lopsidedness of Lift's
// taxonomy is refused). Equipment decides the default stepKg. SetKind lands now though its UI
// is phase 2 — a warmup must not count toward volume, and that is a schema decision, not a feature
// decision.
enum class Pattern { squat, hinge, press, pull, carry, core, isolation };
enum class Equipment { barbell, dumbbell, machine, cable, bodyweight, kettlebell };
enum class SetKind { warmup, working, drop, failure };

std::string toString(Pattern pattern);
std::string toString(Equipment equipment);
std::string toString(SetKind kind);

// Strict on write: an unknown word in a request is a 400, never a silent downgrade of user data.
Pattern parsePattern(std::string_view text);       // throws InvalidTraining
Equipment parseEquipment(std::string_view text);   // throws InvalidTraining
SetKind parseSetKind(std::string_view text);       // throws InvalidTraining

// Clamped on read: a future value added by a newer deploy can't crash an older reader — an unknown
// stored kind reads as working, an unknown pattern as isolation, unknown equipment as barbell.
Pattern patternFromStored(std::string_view text);
Equipment equipmentFromStored(std::string_view text);
SetKind setKindFromStored(std::string_view text);

// The one id-shape rule for every client-minted id (recommended prefixes ses_ / set_ / rt_ —
// opaque to the server, the same client-supplied-id move the tree import uses). Seeded exercise
// slugs ('dip') are NOT client-minted and follow their own rule (the catalog seeds them).
bool wellFormedId(std::string_view id);

// The furthest instant the store can hold: 9999-12-31T23:59:59Z. Every instant the domain accepts
// is inside (0, kMaxInstantMs], so a unit-confused client — nanoseconds, or an int64 -1 serialized
// as a uint64 — is refused at construction instead of committing a pre-1970 row that no later read
// of that account can survive.
constexpr std::uint64_t kMaxInstantMs = 253402300799000ull;

// The ceiling on every display name a lifter types — a routine's and a movement's alike, because
// they are the same kind of string and the editor and the picker draw them side by side. Counted in
// BYTES, which is the unit the text column and the wire both count in.
//
// 240 AND NOT 80, AND THE REASON IS THE UNIT. The clients cap at 60 CHARACTERS and draw a counter
// saying so, because canon says "any language, any spelling, any punctuation, capped at 60
// characters". Those two caps only agreed while a lifter typed ASCII: a 45-character Cyrillic
// routine name is 83 bytes and a 30-character Japanese one is 90, so the counter read 45/60 and the
// save came back refused. UTF-8 spends at most four bytes on a code point, so 60 characters can
// never exceed 240 — which makes the CLIENT's cap the one a lifter meets, in every script, and
// leaves this one what it should be: a bound on what the column can hold, not a second opinion on
// how long a name may be.
constexpr std::size_t kMaxNameLength = 240;

// The one normalization every display name goes through, applied by both entities that hold one so
// they cannot answer differently: the ends trimmed. " Bench Press " and "Bench Press" are one name
// to a reader and two rows to a picker, and a name of nothing but blanks is the empty name the
// constructors already refuse, arriving in disguise — it stored, and then rendered as a movement
// with no name and no way to find it again. Trimming before the ceiling is measured is deliberate:
// a name is judged by what it says, not by the spaces around it.
//
// ASCII whitespace only, which is what a keyboard's space bar and a paste from a text field carry.
// A name made of Unicode blanks alone survives this, and that is where it stops being worth chasing.
std::string trimmedName(std::string text);

// What a `text` column can actually hold, and the one rule every piece of free text in this product
// goes through — a set's note, a movement's name, a routine's name. Two ways a string reaches
// Postgres and does not come back the same, or at all:
//   · a NUL, where `text` stops. The head of a lifter's words would store as if it were the whole
//     of them, and nothing would ever say so.
//   · bytes that are not well-formed UTF-8, which the server refuses MID-TRANSACTION. That vendor
//     error leaves as the house 500 — the one status every queue on every surface is told to retry —
//     so a body that can never land would be re-sent forever. A lone surrogate half is in this class
//     too: it is not a character, and Postgres will not take one.
// Both are refused at construction, where the answer is the terminal 400 the wire promises for a
// value the store cannot hold, and where it is stated ONCE for every text this module accepts.
bool storableText(std::string_view text);

// What the step_kg column can hold: numeric(4,2), two decimals and a ceiling of 99.99. A value
// outside this band is not an increment the store can keep, so it is refused at construction like
// every other value in this module that meets a column's own bounds.
constexpr double kMinStepKg = 0.01;
constexpr double kMaxStepKg = 99.99;

// The band a rest target lives in, wherever one is named: the global dial in a lifter's preferences
// (domain/Preferences.h) and the per-line target a routine entry carries. ONE pair of numbers,
// because a program that could ask for a wait the dial refuses would be two rules about one rest —
// under fifteen seconds is a typo in a number the timer counts down, and over fifteen minutes is a
// different session. Both columns carry the same check.
constexpr int kMinRestSeconds = 15;
constexpr int kMaxRestSeconds = 900;

// The catalog row: a STABLE slug id that never renders, a mutable display name, and a per-movement
// increment. custom marks a created_by row; seeds are custom = false.
//
// `aliases` are what THIS account used to call it — the names it has been renamed away from, newest
// first — and they are here beside the name because they are the same kind of thing: a per-account
// label on a stable id. The picker searches them, so the word a lifter had in their hands last week
// still finds the movement after a rename (§N32). They are the STORE's to fill and no write takes
// them: a rename is what makes one, and the same rename is what prunes the list to the cap below.
// It is bounded there rather than refused here, because this row ships on the product's most-fired
// read and a lifter's fiftieth try at a name is not muscle memory — while a stored list that
// somehow ran long must still be readable rather than taking the whole catalog down with it.
constexpr std::size_t kMaxAliases = 5;

struct Exercise {
  ExerciseId id;
  std::string name;
  Pattern pattern;
  Equipment equipment;
  double stepKg;
  bool custom;
  std::vector<std::string> aliases;

  Exercise(ExerciseId id, std::string name, Pattern pattern, Equipment equipment, double stepKg,
           bool custom, std::vector<std::string> aliases = {});

  bool operator==(const Exercise&) const = default;
};

// The increment a movement takes when nothing names one: the smallest plate pair on a barbell, the
// rack gap on dumbbells, the pin on a machine. A created movement that sends no stepKg takes this,
// so a lifter's own barbell lift carries the same figure as a seeded one — the seed rows were
// written from this same table (schema.sql's Gym seed comment).
//
// IT IS NOT THE LADDER. The 2026-08-11 retier took the tap step from the load band instead
// (packages/api-contract/gym-ladder.json), so this figure is stored, served, and read by nothing.
// It is reserved for the day a movement's own step earns its way onto the buttons.
double defaultStepKg(Equipment equipment);

// The routine as it stood the instant the session started — a COPY, taken by the server, that
// nothing later edits. Lift stored a template id plus a copied name, so it could say what you did
// and never what you were supposed to do, and editing a template mid-workout rewrote the program's
// past. The snapshot holds the plan's numbers and not the routine's identity, because a copy has
// nothing to point back at: routine_id stays on the session row, informational, and nulls on delete.
// An absent `reps` is the line the canon draws as `3 × max` — a chin-up names no rep target, and a
// zero would read as a real one — and it copies the routine entry's absence through unchanged. An
// absent `sets` is the OPEN line (domain/Routine.h), and the snapshot has to carry that absence for
// the same reason it carries the other three: a session started under a half-built routine must be
// able to tell "3 × 5" from "you decide", and a frozen zero would tell it neither.
struct PlanEntry {
  ExerciseId exercise;
  std::optional<int> sets;
  std::optional<int> reps;
  std::optional<double> weightKg;
  std::optional<int> restSeconds;

  bool operator==(const PlanEntry&) const = default;
};

struct PlanSnapshot {
  std::string routineName;
  std::vector<PlanEntry> entries;

  bool operator==(const PlanSnapshot&) const = default;
};

// One workout. The client-minted id is the idempotency key; plan is the frozen routine snapshot the
// server takes at start (absent = ad-hoc); instants are the device's wall clock, epoch-ms, because
// offline logging means the device's clock is the only honest one.
// How a finished session came to be finished. `finish` is the lifter's word — the explicit end, and
// nothing lands after it. `stale` is the log's own guess — the four-hour rule closed a workout at
// its last landed set because nothing more had arrived — and a guess is revisable: a set that lands
// late but continues that workout proves the guess early (see lateSetLands). Absent on a row that
// was closed before the log kept this fact, and absent means `finish`, the terminal reading.
enum class ClosedBy { finish, stale };
std::string toString(ClosedBy closedBy);
std::optional<ClosedBy> closedByFromStored(std::string_view text);  // "" or unknown → absent

struct Session {
  SessionId id;
  UserId user;
  std::uint64_t startedAtMs;
  std::optional<std::uint64_t> finishedAtMs;
  std::optional<RoutineId> routine;
  std::optional<PlanSnapshot> plan;
  std::optional<ClosedBy> closedBy;

  Session(SessionId id, UserId user, std::uint64_t startedAtMs,
          std::optional<std::uint64_t> finishedAtMs = std::nullopt,
          std::optional<RoutineId> routine = std::nullopt,
          std::optional<PlanSnapshot> plan = std::nullopt,
          std::optional<ClosedBy> closedBy = std::nullopt);

  bool operator==(const Session&) const = default;
};

// The unit of the whole product. Negative weight is legal (band-assisted work logs on one number
// line); setNumber 0 means "not yet assigned" — the store assigns max+1 per (session, exercise).
struct Set {
  SetId id;
  SessionId session;
  ExerciseId exercise;
  int setNumber;
  double weightKg;
  int reps;
  SetKind kind;
  std::optional<double> rpe;
  std::string note;
  std::uint64_t completedAtMs;

  Set(SetId id, SessionId session, ExerciseId exercise, int setNumber, double weightKg, int reps,
      SetKind kind, std::optional<double> rpe, std::string note, std::uint64_t completedAtMs);

  bool operator==(const Set&) const = default;
};

// What a lifter may change about a set they already logged, and the whole of it. Every field is an
// omission that means "leave what is stored", so a correction names the one number that was wrong
// and says nothing about the rest — a client never has to read a row back and echo it to keep it.
//
// What is NOT here is the load-bearing half. The MOVEMENT is not a correction: a set logged against
// the wrong lift is a different repair, and moving it would rewrite two movements' histories at
// once. The instant and the set number are not a lifter's either — one is what the device stamped,
// the other is the store's, and a log whose order can be edited stops being a record of what
// happened. Neither is the session: a set belongs to the workout it was lived in.
//
// rpe takes two fields because it is the one value a correction can also REMOVE. `rpeNamed` says the
// write mentioned it at all and `rpe` says what it mentioned, so omitted keeps what is stored while
// named-and-empty clears it. A note clears itself by being sent empty.
struct SetFix {
  std::optional<double> weightKg;
  std::optional<int> reps;
  std::optional<SetKind> kind;
  std::optional<std::string> note;
  bool rpeNamed = false;
  std::optional<double> rpe;

  bool operator==(const SetFix&) const = default;
};

// The correction itself, and it is the whole rule: the stored row with the named values replaced and
// every other field carried through untouched. It CONSTRUCTS the set, so a value the store could not
// hold throws InvalidTraining here — before anything is written, exactly as the write that logged
// the set in the first place does — and the reps floor is the constructor's own band rather than a
// second copy of it living in a screen.
Set corrected(const Set& stored, const SetFix& fix);

// An open session with no activity for four hours is over, and it ended at its last set —
// not at whenever the server happened to notice. A session with no sets ended when it began.
// Pure and clock-free; TrainingService applies it lazily before a start, before a log read and before
// the statistics read — the three replies whose answer a close rewrites.
constexpr std::uint64_t kAutoCloseMs = 4ull * 60 * 60 * 1000;
std::optional<std::uint64_t> autoCloseAt(const Session& session,
                                         std::optional<std::uint64_t> lastSetAtMs,
                                         std::uint64_t nowMs);

// The other pure session rule. An explicit finish is the one instant a client names for a session
// that already exists, so the rule needs the stored row: a workout cannot end before it began, at
// zero, or past what the store can hold. TrainingService::finish refuses exactly what this refuses —
// the first write to finished_at is permanent, so there is no second chance to get it right.
bool canFinishAt(const Session& session, std::uint64_t finishedAtMs);

// The rule for the one instant a client names for a session that does NOT exist yet. A device's
// wall clock is deliberately the truth about the PAST — a set logged in a basement carries the
// instant it happened — but a workout cannot begin in the server's future, and one that claims to
// is a trap the whole product cannot escape: auto-close measures four hours from the device
// stamp, so a start ahead of the server is never stale; the phone's finish is earlier than the
// start and refused; discard refuses an open session; and every later start joins the phantom. Five
// minutes is the skew an honest clock is allowed; past it, the start is refused naming the gap.
constexpr std::uint64_t kMaxClockAheadMs = 5ull * 60 * 1000;
bool canStartAt(std::uint64_t startedAtMs, std::uint64_t nowMs);

// The fourth rule, and the one that keeps a phone's owed sets from being lost to the log's own
// guess. A workout the four-hour rule closed was closed at its LAST LANDED set — but a phone that
// logged on in a basement holds sets the log never saw, and any read that settled staleness in the
// meantime (the web mirror overnight, a record page, the phone's own start on reconnect) has
// already closed the workout under them. Refusing those sets as "landed after the finish" would
// be the log insisting on a guess it made without the facts. So a set continues a STALE-closed
// session when it sits within the four-hour window of that session's last activity — which is what
// finished_at IS on a stale close — and landing it moves the finish forward to it. An explicit
// finish is never reopened: that instant was the lifter's word, not the log's estimate.
bool lateSetLands(const Session& session, std::uint64_t completedAtMs);

// The third pure session rule, and the only one about a reader who is not the owner. A coach share
// is a capability with an END — thirty days, which is longer than any conversation about one
// workout and shorter than a lifter's memory of having sent the link. A share that never expired
// would be a second, permanent copy of a training record living outside the one account it belongs
// to, which is the whole thing §0 was written to prevent. The ceiling is the store's own, so a
// share minted near the end of time names an instant a timestamptz can still hold rather than
// overflowing to_timestamp() mid-transaction.
constexpr std::uint64_t kShareLifetimeMs = 30ull * 24 * 60 * 60 * 1000;
std::uint64_t shareExpiryAt(std::uint64_t nowMs);

}

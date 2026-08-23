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

// Thrown where an entity is constructed from untrusted input, caught in HTTP → 400.
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

// Pattern is the only classification. Equipment decides the default stepKg.
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

// The one id-shape rule for every client-minted id (recommended prefixes ses_ / set_ / rt_, opaque
// to the server). Seeded exercise slugs ('dip') are not client-minted and follow their own rule.
bool wellFormedId(std::string_view id);

// The furthest instant the store can hold: 9999-12-31T23:59:59Z. Every instant the domain accepts is
// inside (0, kMaxInstantMs], so a unit-confused client is refused at construction.
constexpr std::uint64_t kMaxInstantMs = 253402300799000ull;

// The ceiling on every display name a lifter types, counted in BYTES — the unit the text column and
// the wire count in. The clients cap at 60 CHARACTERS, and UTF-8 spends at most four bytes on a code
// point, so this is a bound on what the column can hold and never the cap a lifter meets.
constexpr std::size_t kMaxNameLength = 240;

// The one normalization every display name goes through: the ends trimmed, before the ceiling is
// measured. ASCII whitespace only — a name of nothing but Unicode blanks survives it.
std::string trimmedName(std::string text);

// What a `text` column can hold, and the one rule every piece of free text in this product goes
// through. Two ways a string does not survive Postgres: a NUL, where `text` stops; and bytes that are
// not well-formed UTF-8 (a lone surrogate half included), which the server refuses mid-transaction as
// a retryable 500. Both are refused at construction, as a terminal 400.
bool storableText(std::string_view text);

// What the step_kg column can hold: numeric(4,2), two decimals and a ceiling of 99.99.
constexpr double kMinStepKg = 0.01;
constexpr double kMaxStepKg = 99.99;

// The band a rest target lives in, wherever one is named: the global dial in a lifter's preferences
// and the per-line target a routine entry carries. Both columns carry the same check.
constexpr int kMinRestSeconds = 15;
constexpr int kMaxRestSeconds = 900;

// The catalog row: a STABLE slug id that never renders, a mutable display name, and a per-movement
// increment. custom marks a created_by row; seeds are custom = false.
//
// `aliases` are the names THIS account has renamed the movement away from, newest first, and the
// picker searches them. They are the STORE's to fill and no write takes them: a rename makes one and
// the same rename prunes the list to this cap. A stored list that ran long is still read, not
// refused.
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

// The increment a movement takes when nothing names one; a created movement that sends no stepKg
// takes this, and the seed rows were written from the same table.
//
// It is NOT the tap ladder, which comes from the load band
// (packages/api-contract/gym-ladder.json); this figure is stored, served, and read by nothing.
double defaultStepKg(Equipment equipment);

// The routine as it stood the instant the session started — a COPY, taken by the server, that
// nothing later edits. It holds the plan's numbers and not the routine's identity: routine_id stays
// on the session row, informational, and nulls on delete. The entries' absences copy through
// unchanged — an absent `reps` is `max` and an absent `sets` is the OPEN line
// (domain/Routine.h) — and a frozen zero would say neither.
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
// server takes at start (absent = ad-hoc); instants are the device's wall clock, epoch-ms.
//
// How a finished session came to be finished. `finish` is the lifter's word and nothing lands after
// it. `stale` is the four-hour rule's guess, revisable by a set that continues the workout (see
// lateSetLands). Absent reads as `finish`, the terminal reading.
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

// What a lifter may change about a set they already logged, and the whole of it: an omitted field
// means "leave what is stored". The movement, the instant, the set number and the session are
// deliberately not correctable.
//
// rpe takes two fields because it is the one value a correction can also REMOVE: `rpeNamed` says the
// write mentioned it and `rpe` says what it mentioned, so named-and-empty clears it. A note clears
// itself by being sent empty.
struct SetFix {
  std::optional<double> weightKg;
  std::optional<int> reps;
  std::optional<SetKind> kind;
  std::optional<std::string> note;
  bool rpeNamed = false;
  std::optional<double> rpe;

  bool operator==(const SetFix&) const = default;
};

// The stored row with the named values replaced and every other field carried through untouched. It
// CONSTRUCTS the set, so a value the store could not hold throws InvalidTraining before anything is
// written.
Set corrected(const Set& stored, const SetFix& fix);

// An open session with no activity for four hours is over, and it ended at its last set — not when
// the server noticed. A session with no sets ended when it began. TrainingService applies it lazily
// before a start and before every read whose answer a close rewrites.
constexpr std::uint64_t kAutoCloseMs = 4ull * 60 * 60 * 1000;
std::optional<std::uint64_t> autoCloseAt(const Session& session,
                                         std::optional<std::uint64_t> lastSetAtMs,
                                         std::uint64_t nowMs);

// A workout cannot end before it began, at zero, or past what the store can hold.
// TrainingService::finish refuses exactly what this refuses; the first write to finished_at is
// permanent.
bool canFinishAt(const Session& session, std::uint64_t finishedAtMs);

// A workout cannot begin in the server's future: a start ahead of the server never goes stale, its
// finish is earlier than its start and refused, and every later start joins it. Five minutes is the
// skew an honest clock is allowed; past it the start is refused naming the gap.
constexpr std::uint64_t kMaxClockAheadMs = 5ull * 60 * 1000;
bool canStartAt(std::uint64_t startedAtMs, std::uint64_t nowMs);

// A set continues a STALE-closed session when it sits within the four-hour window of that session's
// last activity — which is what finished_at is on a stale close — and landing it moves the finish
// forward to it. An explicit finish is never reopened.
bool lateSetLands(const Session& session, std::uint64_t completedAtMs);

// The instant a lifter's finish lands at when it arrives on a STALE close: within four hours of the
// last landed activity it moves the end forward to the finish (or keeps the later activity); past
// that the end stays at that activity and only the word changes.
std::uint64_t finishAfterStaleClose(const Session& staleClosed, std::uint64_t finishedAtMs);

// A coach share is a capability with an END. The result is clamped to the store's ceiling, so a share
// minted near the end of time names an instant a timestamptz can hold.
constexpr std::uint64_t kShareLifetimeMs = 30ull * 24 * 60 * 60 * 1000;
std::uint64_t shareExpiryAt(std::uint64_t nowMs);

}

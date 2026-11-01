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
enum class Equipment { barbell, dumbbell, machine, cable, bodyweight, kettlebell, other };

std::string toString(Pattern pattern);
std::string toString(Equipment equipment);

// Strict on write: an unknown word in a request is a 400, never a silent downgrade of user data.
Pattern parsePattern(std::string_view text);       // throws InvalidTraining
Equipment parseEquipment(std::string_view text);   // throws InvalidTraining

// Clamped on read: a future value added by a newer deploy can't crash an older reader — an unknown
// stored pattern reads as isolation, unknown equipment as barbell.
Pattern patternFromStored(std::string_view text);
Equipment equipmentFromStored(std::string_view text);

// The one id-shape rule for every client-minted id (recommended prefixes ses_ / set_ / rt_, opaque
// to the server). Seeded exercise slugs ('dip') are not client-minted and follow their own rule.
bool wellFormedId(std::string_view id);

// The furthest instant the store can hold: 9999-12-31T23:59:59Z. Every instant the domain accepts is
// inside (0, kMaxInstantMs], so a unit-confused client is refused at construction.
constexpr std::uint64_t kMaxInstantMs = 253402300799000ull;

// The ceiling on every display name a lifter types, counted in BYTES.
constexpr std::size_t kMaxNameLength = 240;

// The ceiling on a set's note, counted in BYTES and never trimmed. The `note` column is unbounded
// `text`, so this is the ONLY enforcement — and `log_set`'s schema states the same number.
constexpr std::size_t kMaxSetNoteBytes = 4000;

// The form a display name is stored in (gym_coach.md §3.3): NFC, then the ends trimmed of ASCII whitespace. Every
// ceiling is measured on it.
std::string canonicalName(std::string_view name);

// A write refuses a blank display name (sync::isBlank, admission's test); a read builds what the store
// holds through the constructors tagged Stored, which run every other check: a stored blank name stands.
struct Stored {};

// Two ways a string does not survive a Postgres `text` column: a NUL, and bytes that are not
// well-formed UTF-8 (a lone surrogate half included). Both are refused at construction, as a 400.
bool storableText(std::string_view text);

// What the step_kg column can hold: numeric(4,2), two decimals and a ceiling of 99.99.
constexpr double kMinStepKg = 0.01;
constexpr double kMaxStepKg = 99.99;

// The band a rest target lives in; both columns carry the same check.
constexpr int kMinRestSeconds = 15;
constexpr int kMaxRestSeconds = 900;

// The id is a STABLE slug that never renders. custom marks a created_by row; seeds are custom=false.
// `aliases` are the names THIS account has renamed the movement away from, newest first. They are the
// STORE's to fill and no write takes them; a rename prunes the list to this cap. A stored list that
// ran long is still read, not refused.
constexpr std::size_t kMaxAliases = 5;

struct Exercise {
  ExerciseId id;
  std::string name;
  Pattern pattern;
  Equipment equipment;
  double stepKg;
  bool custom;
  std::vector<std::string> aliases;
  int loadCount;

  Exercise(ExerciseId id, std::string name, Pattern pattern, Equipment equipment, double stepKg,
           bool custom, std::vector<std::string> aliases = {}, int loadCount = 0);
  Exercise(Stored, ExerciseId id, std::string name, Pattern pattern, Equipment equipment, double stepKg,
           bool custom, std::vector<std::string> aliases = {}, int loadCount = 0);

  // The lowest target a phone's editor takes for it: 0 kg for a barbell or a pair of dumbbells, which cannot weigh
  // less than empty; none for every other loading, whose negative load is assistance.
  std::optional<double> loadFloorKg() const;
  // Whether a load, logged or targeted, sits at or above that floor.
  bool takes(double weightKg) const;

  bool operator==(const Exercise&) const = default;
};

// The increment a movement takes when nothing names one. NOT the tap ladder, which comes from the
// load band in packages/api-contract/gym-ladder.json.
double defaultStepKg(Equipment equipment);
std::optional<double> liftedVolume(double weightKg, int reps, Equipment equipment, int loadCount = 0);

struct VolumePart {
  std::string id;
  std::optional<double> kg;

  VolumePart(std::string id, std::optional<double> weightKg, std::optional<int> reps, std::optional<int> loadCount);
  VolumePart(std::string id, double weightKg, int reps, Equipment equipment, int loadCount = 0);
};

std::optional<double> totalVolume(std::vector<VolumePart> parts);

// A missing rep target is `max`; a missing load is last time's set of the same number. Explicit zero
// is a load. Loads normalize to the cent grid at construction.
struct SetTarget {
  std::optional<int> reps;
  std::optional<double> weightKg;

  SetTarget(std::optional<int> reps, std::optional<double> weightKg);   // throws InvalidTraining

  bool operator==(const SetTarget&) const = default;
};

// A line's scheme holds at most this many sets; a scheme with none is the OPEN line, decided at the
// rack. Together with kMaxRoutineEntries this bounds what one routine write lays down.
constexpr std::size_t kMaxSetTargets = 20;

// A COPY of the routine as it stood when the session started; nothing later edits it. routine_id
// stays on the session row, informational, and nulls on delete. The entries' absences copy through
// unchanged: an empty `sets` is the OPEN line, and each set's own absences keep their meaning.
struct PlanEntry {
  ExerciseId exercise;
  std::vector<SetTarget> sets;
  std::optional<int> restSeconds;

  bool operator==(const PlanEntry&) const = default;
};

struct PlanSnapshot {
  std::string routineName;
  std::vector<PlanEntry> entries;

  bool operator==(const PlanSnapshot&) const = default;
};

// The client-minted id is the idempotency key; plan is the frozen routine snapshot the server takes
// at start (absent = ad-hoc); instants are the device's wall clock, epoch-ms.
// `finish` is the lifter's word and nothing lands after it. `stale` is the four-hour rule's guess,
// revisable by a set that continues the workout (lateSetLands). Absent reads as `finish`.
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
  std::optional<std::string> displayName;

  Session(SessionId id, UserId user, std::uint64_t startedAtMs,
          std::optional<std::uint64_t> finishedAtMs = std::nullopt,
          std::optional<RoutineId> routine = std::nullopt,
          std::optional<PlanSnapshot> plan = std::nullopt,
          std::optional<ClosedBy> closedBy = std::nullopt,
          std::optional<std::string> displayName = std::nullopt);

  bool operator==(const Session&) const = default;
};

// Negative weight is legal (band-assisted work); setNumber 0 means "not yet assigned" — the store
// assigns max+1 per (session, exercise).
struct Set {
  SetId id;
  SessionId session;
  ExerciseId exercise;
  int setNumber;
  double weightKg;
  int reps;
  std::optional<double> rpe;
  std::string note;
  std::uint64_t completedAtMs;

  Set(SetId id, SessionId session, ExerciseId exercise, int setNumber, double weightKg, int reps,
      std::optional<double> rpe, std::string note, std::uint64_t completedAtMs);

  bool operator==(const Set&) const = default;
};

// The movement a set's load falls below the floor of, as the catalog resolves it; nothing when the load stands, or the
// catalog lacks the movement.
std::optional<Exercise> movementBelowFloor(const Set& set, const std::vector<Exercise>& catalog);

constexpr std::size_t kMaxSetBatch = 200;

struct SetBatch {
  SessionId sessionId;
  std::vector<Set> sets;

  SetBatch(SessionId sessionId, std::vector<Set> sets, std::uint64_t nowMs, bool allowEmpty = false);
  void checkInterval(const Session& session, bool completedSession) const;
};

// An open session with no activity for four hours is over, and it ended at its last set, not when
// the server noticed. A session with no sets ended when it began. The engine's gym.closeStale writes
// the close; a start and an import run it inside their own command, and a read admits it only when
// isStale says the open session has gone stale.
constexpr std::uint64_t kAutoCloseMs = 4ull * 60 * 60 * 1000;

// GymRules' rule exactly: the last activity is the latest completedAt of the session's sets, else its start, and
// the session is stale once now stands kAutoCloseMs or more past it. A now before it is never stale.
std::uint64_t lastActivityAt(const Session& session, const std::vector<Set>& sets);
bool isStale(const Session& open, const std::vector<Set>& sets, std::uint64_t nowMs);

// A workout cannot end at zero, past what the store can hold, before it began, or before its last activity. The
// first write to finished_at is permanent.
bool canFinishAt(const Session& session, const std::vector<Set>& sets, std::uint64_t finishedAtMs);

// A workout cannot begin in the server's future. Five minutes is the skew an honest clock is
// allowed; past it the start is refused naming the gap.
constexpr std::uint64_t kMaxClockAheadMs = 5ull * 60 * 1000;
bool canStartAt(std::uint64_t startedAtMs, std::uint64_t nowMs);
// Nor can a set be completed past that skew.
bool canCompleteAt(std::uint64_t completedAtMs, std::uint64_t nowMs);

// A set continues a STALE-closed session when it sits within the four-hour window of that session's
// last activity — which is what finished_at is on a stale close — and landing it moves the finish
// forward to it. An explicit finish is never reopened.
bool lateSetLands(const Session& session, std::uint64_t completedAtMs);

// Clamped to the store's ceiling, so a share minted near the end of time names a holdable instant.
constexpr std::uint64_t kShareLifetimeMs = 30ull * 24 * 60 * 60 * 1000;
std::uint64_t shareExpiryAt(std::uint64_t nowMs);

}

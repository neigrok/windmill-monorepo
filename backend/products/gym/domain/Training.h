#pragma once

#include "platform/domain/Ids.h"

#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>

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
// taxonomy is refused). Equipment decides the default ladder step. SetKind lands now though its UI
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

// The catalog row: a STABLE slug id that never renders, a mutable display name, and the default
// ladder increment. custom marks a created_by row (phase 2); seeds are custom = false.
struct Exercise {
  ExerciseId id;
  std::string name;
  Pattern pattern;
  Equipment equipment;
  double stepKg;
  bool custom;

  Exercise(ExerciseId id, std::string name, Pattern pattern, Equipment equipment, double stepKg,
           bool custom);

  bool operator==(const Exercise&) const = default;
};

// One workout. The client-minted id is the idempotency key; planJson is the frozen routine
// snapshot at start ("" = ad-hoc); instants are the device's wall clock, epoch-ms, because offline
// logging means the device's clock is the only honest one.
struct Session {
  SessionId id;
  UserId user;
  std::uint64_t startedAtMs;
  std::optional<std::uint64_t> finishedAtMs;
  std::optional<RoutineId> routine;
  std::string planJson;

  Session(SessionId id, UserId user, std::uint64_t startedAtMs,
          std::optional<std::uint64_t> finishedAtMs = std::nullopt,
          std::optional<RoutineId> routine = std::nullopt, std::string planJson = "");

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

// An open session with no activity for four hours is over, and it ended at its last set —
// not at whenever the server happened to notice. A session with no sets ended when it began.
// Pure and clock-free; LogService applies it lazily before a start and before a log read.
constexpr std::uint64_t kAutoCloseMs = 4ull * 60 * 60 * 1000;
std::optional<std::uint64_t> autoCloseAt(const Session& session,
                                         std::optional<std::uint64_t> lastSetAtMs,
                                         std::uint64_t nowMs);

// The other pure session rule. An explicit finish is the one instant a client names for a session
// that already exists, so the rule needs the stored row: a workout cannot end before it began, at
// zero, or past what the store can hold. LogService::finish refuses exactly what this refuses —
// the first write to finished_at is permanent, so there is no second chance to get it right.
bool canFinishAt(const Session& session, std::uint64_t finishedAtMs);

}

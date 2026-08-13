#pragma once

#include "products/gym/domain/Training.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// One line of the program: this movement, this many sets of this many reps, at this load. It
// carries NO id, because the table's key is (routine_id, position) — which is what makes the same
// movement twice in one routine (bench heavy, then bench back-off) representable at all; Lift
// collapsed the pair into one set counter. FOUR of its fields mean something by their ABSENCE and
// never by a zero: an absent targetSets is an OPEN line — see below — an absent targetReps is
// `3 × max` — the chin-up line, a program a required rep target could not express at all — an
// absent targetWeightKg is "whatever you did last time", and an absent restSeconds falls back to
// the lifter's global rest target (gym_preferences), which is a value a client can now READ rather
// than invent — though the fallback is applied by the surface running the timer and never here:
// this server stores the absence and fills in nothing.
//
// AN OPEN LINE IS A LINE WITH NO TARGET AT ALL, and it is what makes a routine savable while
// incomplete (§M): the movement is in the day, and what to do with it is decided at the rack. It is
// the absence of targetSets and never a zero — a zero is a target of nothing, which is a different
// and untrue sentence — and the two other targets go with it, because half a target is a line no
// screen in this product can draw. Rest is not a target and stays legal on an open line: it is how
// long you wait, not what you are asked to do.
struct RoutineEntry {
  int position;
  ExerciseId exercise;
  std::optional<int> targetSets;
  std::optional<int> targetReps;
  std::optional<double> targetWeightKg;
  std::optional<int> restSeconds;

  RoutineEntry(int position, ExerciseId exercise, std::optional<int> targetSets,
               std::optional<int> targetReps, std::optional<double> targetWeightKg,
               std::optional<int> restSeconds);

  bool operator==(const RoutineEntry&) const = default;
};

// A day of the program is a page a lifter reads between sets, and this is where that stops being a
// figure of speech: every entry is one INSERT inside the one transaction a routine write is, so a
// document with no size bound is a write with no size bound. Fifty lines is already far past
// anything the editor draws.
constexpr int kMaxRoutineEntries = 50;

// A day of the program, owned by one account. The client-minted id ('rt_<hex>') is the idempotency
// key exactly as a session's is, so it obeys the one id-shape rule. Entry ORDER is the routine
// order and the positions are dense and 1-based — a gap is a line the client cannot draw and the
// store's key would still hold, so it is refused where every other malformed value is, at
// construction. A routine with no entries is not a plan, and the editor never composes one.
// lastTrainedAtMs is the store's derived answer — the newest session started under this routine —
// and it is absent until the routine has been trained once.
//
// `revision` is the concurrency token, and it is load-bearing twice over. It is what an agent's
// proposal is minted AGAINST — apply lands only while the routine still stands at the revision the
// diff was computed from — and it is what stops the mid-session "Save 87.5 to Push A", a full
// read-modify-write PUT, from silently destroying that base: the write moves the token, the
// pending proposal is superseded, and nobody merges a diff over a document it no longer describes.
// It starts at 1 and moves on every write that changes the DOCUMENT or the NAME — the two things a
// proposal freezes — the lifter's own and an applied proposal alike. A write that changes neither
// destroyed no base and moves nothing: not a PUT landing the bytes that already stand, and not a
// drag up the routines screen, since `position` is no part of any diff. It is the STORE's to move; a
// client reads it and never sends it.
struct Routine {
  RoutineId id;
  UserId user;
  std::string name;
  int position;
  std::vector<RoutineEntry> entries;
  std::optional<std::uint64_t> lastTrainedAtMs;
  int revision;

  Routine(RoutineId id, UserId user, std::string name, int position,
          std::vector<RoutineEntry> entries,
          std::optional<std::uint64_t> lastTrainedAtMs = std::nullopt, int revision = 1);

  bool operator==(const Routine&) const = default;
};

// The copy the server freezes onto the session row at start. It is taken here, from the store's own
// routine, and never from a client-composed body: a client's copy freezes whatever that client last
// read, which is the exact staleness the snapshot exists to prevent.
PlanSnapshot snapshotOf(const Routine& routine);

}

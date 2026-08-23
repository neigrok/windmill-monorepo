#pragma once

#include "products/gym/domain/Review.h"
#include "products/gym/domain/Statistics.h"
#include "products/gym/domain/Training.h"

#include <cstdint>
#include <optional>
#include <vector>

namespace wm::gym {

// A movement's record page, answered by one read. Everything here counts FINISHED sessions only.

// One finished session's working sets of one movement. The whole page is dated by the SESSION's own
// start, never by a set's completed_at, which is the device's wall clock.
struct MovementSession {
  SessionId session;
  std::uint64_t startedAtMs;
  std::vector<PriorMark> loads;   // heaviest first, best reps at each

  bool operator==(const MovementSession&) const = default;
};

// One day of the movement. The sets arrive in the order they were performed, warmups excluded;
// everything else rides with its kind.
struct MovementDay {
  SessionId session;
  std::uint64_t startedAtMs;
  std::vector<Set> sets;

  bool operator==(const MovementDay&) const = default;
};

// Everything the rule below needs that it cannot compute, in one value the port fills. An absent
// `exercise` means this account's catalog holds no such movement, whether it never existed or
// belongs to someone else. `sessions` is the whole history, oldest first, the ladder and the
// standing bests being lifetime facts; `recent` is bounded by the store.
//
// The two lists count different things: `sessions` holds the ones the movement was WORKED in — what
// the chart draws and the subhead counts — while `recent` holds the days it was trained in at all
// bar a warmup, so a session holding only drops is in the list and not in the count.
struct MovementHistory {
  std::optional<Exercise> exercise;
  std::vector<std::string> routines;       // the days that name it, in program order
  std::vector<MovementSession> sessions;   // oldest first
  std::vector<MovementDay> recent;         // newest first

  bool operator==(const MovementHistory&) const = default;
};

// The store's bound on `recent`: the movement's last ten training days.
constexpr int kRecentDays = 10;

// The chart's window, and the only window on this page — the bests, the ladder and the counts are
// all lifetime.
constexpr std::uint64_t kRecordWindowMs = 12ull * 7 * 24 * 60 * 60 * 1000;

// One bar of the chart and one line of the record list. `e1rm` is never absent: a point with no
// honest estimate is left out of the series rather than sitting in it as a hole, Epley being
// undefined at and below zero.
struct RecordPoint {
  std::uint64_t atMs;
  double weightKg;
  int reps;
  double e1rm;

  bool operator==(const RecordPoint&) const = default;
};

// The whole page. Every list is empty rather than short where there is nothing true to say, and the
// wire omits an empty one entirely.
//
// `bestE1rm` and `heaviest` are the standing bests domain/Statistics.h defines, dated by the session
// a mark was set in (domain/Review.h), read off the sessions in hand rather than a second
// projection. `bestE1rm` is absent exactly where the series is.
//
// `records` is the e1RM ladder, newest first: every session whose best estimate beat every session
// before it. The first is not a record — a mark has to be passed — so a lifter's first session sets
// the standing best and claims nothing. It is the e1RM ladder alone and not the log's gold dot,
// which is all three record rules (domain/Review.h).
struct MovementRecord {
  Exercise exercise;
  std::vector<std::string> routines;   // the days of the program that name it, in program order
  int sessions;
  std::optional<Best> bestE1rm;
  std::optional<Best> heaviest;
  std::vector<RecordPoint> series;    // oldest first, inside the window
  std::vector<RecordPoint> records;   // newest first, lifetime
  std::vector<MovementDay> recent;    // newest first

  bool operator==(const MovementRecord&) const = default;
};

// The instant crosses as an argument, so one clock decides the window. Computed on every read and
// stored nowhere.
MovementRecord movementRecord(const Exercise& exercise, const MovementHistory& history,
                              std::uint64_t nowMs);

}

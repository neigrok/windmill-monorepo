#pragma once

#include "products/gym/domain/Review.h"
#include "products/gym/domain/Statistics.h"
#include "products/gym/domain/Training.h"

#include <cstdint>
#include <optional>
#include <vector>

namespace wm::gym {

// A movement's record: one exercise, one page, reached by tapping a movement's name anywhere. It is
// what stands where a dashboard would have — and what it refuses is as load-bearing as what it
// answers. No volume by muscle group, no fatigue score, no percentile against strangers, no weekly
// bars: one movement, one number, one arc. The whole surface is answered by ONE read, because a
// page that made a call per tile is a page that draws in four stages.
//
// Everything here counts FINISHED sessions only, for the reason the prefill and the statistics read
// exclude the open one too: today's live workout is today's screen, and a record page that moved
// under a lifter between two sets would be reporting on a session in flight.

// One finished session's working sets of ONE movement, as the store hands them over: the session,
// the instant it began, and its load ladder. The whole page is dated by the SESSION's own start and
// never by a set's completed_at — that is the device's wall clock, and one skewed stamp would walk
// a bar across the chart (the rule domain/Statistics.h states for the same reason).
struct MovementSession {
  SessionId session;
  std::uint64_t startedAtMs;
  std::vector<PriorMark> loads;   // heaviest first, best reps at each

  bool operator==(const MovementSession&) const = default;
};

// One day of the movement, as the page prints it: `today · 105 × 5 · 105 × 5 · 105 × 4`. The sets
// arrive in the order they were performed and WARMUPS ARE NOT AMONG THEM — the rule the prefill
// block already obeys, because a ramp-up single is not what you did. Everything else rides with its
// kind, so a drop set is legible as one rather than quietly counted as work.
struct MovementDay {
  SessionId session;
  std::uint64_t startedAtMs;
  std::vector<Set> sets;

  bool operator==(const MovementDay&) const = default;
};

// Everything the rule below needs that it cannot compute, in one value the port fills — the same
// contract SessionHistory and TrainingLog hold: the rule defines the shape and the store's job is
// to fill it. An absent `exercise` is the one refusal this read has, and it is the fact every other
// read here gives: this account's catalog holds no such movement, whether it never existed or
// belongs to someone else. `sessions` is the WHOLE history, oldest first, because the record ladder
// and the standing bests are lifetime facts and only the chart is windowed; `recent` is bounded by
// the store, because a list nobody scrolls to the end of does not need a lifetime of rows in it.
//
// The two lists count different things ON PURPOSE, and the page says so by what it draws from each.
// `sessions` holds the ones this movement was WORKED in — the sessions the chart draws a bar for
// and the subhead counts, because every NUMBER in this product is over working sets. `recent` holds
// the days it was trained in at all bar a warmup, because a list of what you did that dropped a
// drop set would be claiming to be complete and not be. A session holding only drops of a movement
// is therefore in the list and not in the count, which is the same difference the log row's two set
// counts make.
struct MovementHistory {
  std::optional<Exercise> exercise;
  int routines = 0;                        // how many of this account's routines name it
  std::vector<MovementSession> sessions;   // oldest first
  std::vector<MovementDay> recent;         // newest first

  bool operator==(const MovementHistory&) const = default;
};

// The store's bound on `recent`: the movement's last ten training days. The design draws three and
// scrolls; ten is enough to scroll and small enough that the reply stays one screen of JSON.
constexpr int kRecentDays = 10;

// The chart's window. Twelve weeks is the design's, and it is the only window on this page — the
// bests, the ladder and the counts are all lifetime, because "your best ever" that quietly meant
// "your best this quarter" would be the loudest false number in the product.
constexpr std::uint64_t kRecordWindowMs = 12ull * 7 * 24 * 60 * 60 * 1000;

// One bar of the chart, and one line of the record list — the same four numbers, because they are
// the same fact asked twice: a bar is what a session's best estimate was, and a record is a bar
// that stood above every bar before it. `e1rm` is never absent here: a point with no honest
// estimate is not IN the series, rather than sitting in it as a hole (§H draws no dash in a chart
// frame, and Epley is undefined at and below zero — a chin-up at 0 kg and a band-assisted pull-up
// at −20 have no one-rep estimate to plot).
struct RecordPoint {
  std::uint64_t atMs;
  double weightKg;
  int reps;
  double e1rm;

  bool operator==(const RecordPoint&) const = default;
};

// The whole page. Every list is EMPTY rather than short where there is nothing true to say, and the
// wire omits an empty one entirely: a movement in the catalog you have never lifted is a real and
// common case, and it draws a page that says so plainly instead of a chart frame with nothing in it.
//
// `bestE1rm` and `heaviest` are the two tiles. They are the standing bests domain/Statistics.h
// already defines — the same two rules, the same type, and since 2026-08-12 the same DATE, because
// a mark is dated by the session it was set in wherever it is read from (domain/Review.h). Before
// that this page dated a best by its session and `GET /v1/gym/stats` dated the same best by the
// set's own clock, so an evening PR whose top set landed after midnight came off the two live reads
// on two calendar days. They are still read here off the sessions in hand rather than off a second
// projection that could disagree with the chart above them. `bestE1rm` is absent exactly where the
// series is —
// a movement whose every set was unloaded has no estimate, so it draws no tile and no chart, and
// the heaviest tile and the sets carry the page on their own.
//
// `records` is the e1RM ladder, newest first: every session whose best estimate beat every session
// before it. The first one is NOT a record — a mark has to be passed, the same rule the finish
// screen states — so a lifter's first ever session sets the standing best and claims nothing.
//
// It is the E1RM ladder and deliberately not the log's gold dot, which is all three record rules
// (domain/Review.h): 80 × 8 then 80 × 10 is more reps at a load and lights the row, while the two
// estimates tie, so that session earns a dot and is not a rung here. One movement's arc is one
// number's arc — a list mixing three kinds would have nothing to plot beside it — and a page that
// answered "which of my workouts earned something" is the log, which already does.
struct MovementRecord {
  Exercise exercise;
  int routines;
  int sessions;
  std::optional<Best> bestE1rm;
  std::optional<Best> heaviest;
  std::vector<RecordPoint> series;    // oldest first, inside the window
  std::vector<RecordPoint> records;   // newest first, lifetime
  std::vector<MovementDay> recent;    // newest first

  bool operator==(const MovementRecord&) const = default;
};

// Pure and clock-free like every rule in this product — the instant crosses as an argument, so one
// clock decides the window and a test can drive it. Computed on every read and stored nowhere.
MovementRecord movementRecord(const Exercise& exercise, const MovementHistory& history,
                              std::uint64_t nowMs);

}

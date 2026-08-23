#pragma once

#include "products/gym/domain/Training.h"

#include <cstdint>
#include <set>
#include <string>

namespace wm::gym {

// What a read tool served, counted by the server as it handed the rows over.
// Three buckets, each counted by IDENTITY so two overlapping reads count once. A read contributes
// only what it actually named, so the tally is a FLOOR and never claims a row it did not hand over.
// `get_stats` points carry no session id, only a start instant two workouts can tie on, so it
// contributes its weeks and no sessions or sets.

struct ReadTally {
  int sets = 0;
  int sessions = 0;
  int weeks = 0;

  bool anything() const { return sets > 0 || sessions > 0 || weeks > 0; }
  bool operator==(const ReadTally&) const = default;
};

// Monday 00:00 UTC of the week an instant falls in — the same boundary Postgres computes for
// `get_stats`; if the two disagree a receipt counts one week twice.
std::uint64_t weekStartMs(std::uint64_t atMs);

class ReadReceipt {
public:
  void sawSet(const SetId& id, std::uint64_t completedAtMs);
  void sawSession(const SessionId& id, std::uint64_t startedAtMs);
  // `get_stats` hands over one row per week including the empty ones, and an empty week still counts.
  void sawWeek(std::uint64_t weekStartedAtMs);
  // Merges by id, so rows several replies both carried count once.
  void merge(const ReadReceipt& other);

  ReadTally tally() const;

private:
  std::set<std::string> sets_;
  std::set<std::string> sessions_;
  std::set<std::uint64_t> weeks_;
};

}

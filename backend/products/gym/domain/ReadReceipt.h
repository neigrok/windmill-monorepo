#pragma once

#include "products/gym/domain/Training.h"

#include <cstdint>
#include <set>
#include <string>

namespace wm::gym {

// WHAT WE SERVED, COUNTED WHERE IT WAS SERVED.
//
// Every answer Ask gives states what it read — `read 214 sets · 12 weeks · 34 sessions` — and the
// whole value of that line is that it is OURS and not the model's. A model asked how much it read
// will happily say a number; the only number worth printing is the one the server counted as it
// handed the rows over. So the count is made here, on the way out of a read tool, and it rides in the
// tool's own reply — which means a lifter's own Claude over MCP sees the same accounting we do, and a
// proposal minted through either door arrives reviewable on the same terms.
//
// Three buckets, each counted by IDENTITY so two reads that overlap count once: ask twice about the
// same workout and it is one workout. A read that serves a SUMMARY rather than rows contributes what
// it actually named — `list_sessions` names thirty-four workouts and hands over no sets, so it adds
// thirty-four sessions and not one set. That is the conservative direction on purpose: the receipt
// never claims a row it did not hand to the model.

struct ReadTally {
  int sets = 0;
  int sessions = 0;
  int weeks = 0;

  bool anything() const { return sets > 0 || sessions > 0 || weeks > 0; }
  bool operator==(const ReadTally&) const = default;
};

// Monday 00:00 UTC of the week an instant falls in. gym counts weeks Monday-to-Monday in UTC
// everywhere (domain/Statistics.h), and `get_stats` gets its week boundaries from Postgres —
// so this is that same rule stated a second time, in the one place a set or a session has to be
// bucketed without a database in the loop. If the two ever disagree, a receipt counts one week twice.
std::uint64_t weekStartMs(std::uint64_t atMs);

class ReadReceipt {
public:
  void sawSet(const SetId& id, std::uint64_t completedAtMs);
  void sawSession(const SessionId& id, std::uint64_t startedAtMs);
  // A week the store itself counted — `get_stats` hands over one row per week, including the empty
  // ones, and a week with no training in it is still a week we read and answered about.
  void sawWeek(std::uint64_t weekStartedAtMs);
  // One run of Ask asks several questions to answer one. Merging by id is why the run's line can say
  // 214 sets when four replies each carried some of the same ones.
  void merge(const ReadReceipt& other);

  ReadTally tally() const;

private:
  std::set<std::string> sets_;
  std::set<std::string> sessions_;
  std::set<std::uint64_t> weeks_;
};

}

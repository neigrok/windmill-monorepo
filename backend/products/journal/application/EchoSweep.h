#pragma once

#include "platform/application/Entitlements.h"
#include "platform/ports/Clock.h"
#include "products/journal/domain/EchoSelection.h"
#include "products/journal/ports/Curator.h"
#include "products/journal/ports/EchoRepository.h"
#include "products/journal/ports/Embedder.h"
#include "products/journal/ports/Segmenter.h"

#include "platform/application/Heartbeat.h"

#include <cstdint>
#include <functional>

namespace wm {

struct EchoSweepReport {
  int usersScanned = 0;
  int pagesDerived = 0;
  int pagesSkippedRefrain = 0;
  int passagesEmbedded = 0;
  int echoesWritten = 0;
  int pagesFailed = 0;
  // Units a segmenter proposed that are NOT in the page's body and were discarded.
  int unitsDiscarded = 0;
  // Pages the vendor declined to judge — work that will never be owed again, unlike `pagesFailed`.
  int pagesRefused = 0;
  int inboundEnqueued = 0;
  int pagesOverBudget = 0;
  int usersOverAiBudget = 0;
};

// What one night is allowed to cost a single user.
struct SweepBudget {
  int pagesPerUser = 40;
  int inboundPerPage = 20;

  // The page-level cap. `SelectionRules::shown` bounds one TRIGGER's pairings, so without this a
  // page with eight triggering passages carries eighty.
  int echoesPerPage = 10;
};

//   segment -> embed -> reconcile -> retrieve -> select -> curate -> persist
//
// Runs on its own trantor thread either way, never a request loop: a curator call is seconds long
// and drogon has one handler thread per core. Step 1 is a VENDOR call (ports/Segmenter.h), asked
// only when the page's BODY moved; a corpus that moved under unchanged text reads its units back
// out of storage.
//
// Derivation stamps advance ONLY when the pass SETTLED, and a REFUSAL settles the page though it
// failed (ports/EchoRepository.h, isSettled); only an edit to the body reopens it.
//
// Entitlement-blind about WHAT it derives — the read layer cuts the passage — but not about what it
// SPENDS: the account's BACKGROUND bucket is asked once per user, and over it the user is SKIPPED,
// not failed, so no stamp advances and the work is deferred.
class EchoSweep {
public:
  EchoSweep(EchoRepository& echoes, Segmenter& segmenter, Embedder& embedder, Curator& curator,
            Clock& clock, Entitlements& entitlements, SelectionRules rules, SweepBudget budget);

  void start();

  // `sinceMs` is the only instant a pass has an opinion about: which users to scan. Everything after
  // that is decided by stamps the corpus carries, so the sweep cannot drift against a clock.
  // `rejudgeAll` takes EVERY page of every scanned writer rather than the ones the stamps say are
  // owed. It re-cuts nothing — `allPages` reports every page as body-unmoved — so it costs the
  // embedder and the curator, never the segmenter.
  EchoSweepReport run(std::uint64_t sinceMs, bool rejudgeAll = false);

  // The same pass, queued onto this sweep's own loop, so a repair pass of minutes does not sit on a
  // drogon IO thread holding a pooled connection.
  void runAsync(std::uint64_t sinceMs, std::function<void(EchoSweepReport)> done,
                bool rejudgeAll = false);

  // One page, because its writer just saved it. It does NOT walk the reverse edge — that walk is
  // unbounded and belongs to the budgeted pass.
  EchoSweepReport derivePage(const UserId& user, const LocalDate& day);

private:
  // Returns the outcome to record; the caller owns the report counters.
  CurationOutcome derive(const UserId& user, const DuePage& page, std::uint64_t corpusStamp,
                         EchoSweepReport& report);

  PipelineVersions versions() const;

  EchoRepository& echoes_;
  Segmenter& segmenter_;
  Embedder& embedder_;
  Curator& curator_;
  Clock& clock_;
  Entitlements& entitlements_;
  SelectionRules rules_;
  SweepBudget budget_;
  Heartbeat heartbeat_;   // declared last: destructs first, before the deps a running pass holds
};

}

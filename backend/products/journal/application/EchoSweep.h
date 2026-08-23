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
  // Units a segmenter proposed that are not in the page's body and were discarded.
  int unitsDiscarded = 0;
  // Pages the vendor declined to judge; unlike `pagesFailed`, they are never owed again.
  int pagesRefused = 0;
  int inboundEnqueued = 0;
  int pagesOverBudget = 0;
  int usersOverAiBudget = 0;
};

// What one night is allowed to cost a single user.
struct SweepBudget {
  int pagesPerUser = 40;
  int inboundPerPage = 20;

  // The page-level cap; `SelectionRules::shown` bounds one trigger's pairings.
  int echoesPerPage = 10;
};

//   segment -> embed -> reconcile -> retrieve -> select -> curate -> persist
//
// Runs on its own trantor thread, never a request loop. Segmenting is a vendor call, asked only when
// the page's body moved; a corpus that moved under unchanged text reads its units back out of
// storage. Derivation stamps advance only when the pass settled, and a refusal settles the page
// though it failed, so only an edit to the body reopens it. Entitlement decides only spend: the
// account's background bucket is asked once per user, and over it the user is skipped, not failed.
class EchoSweep {
public:
  EchoSweep(EchoRepository& echoes, Segmenter& segmenter, Embedder& embedder, Curator& curator,
            Clock& clock, Entitlements& entitlements, SelectionRules rules, SweepBudget budget);

  void start();

  // `sinceMs` decides which users to scan and nothing else; the rest is decided by corpus stamps.
  // `rejudgeAll` takes every page of every scanned writer rather than the ones the stamps say are
  // owed, and re-cuts nothing, so it costs the embedder and curator but never the segmenter.
  EchoSweepReport run(std::uint64_t sinceMs, bool rejudgeAll = false);

  // The same pass, queued onto this sweep's own loop.
  void runAsync(std::uint64_t sinceMs, std::function<void(EchoSweepReport)> done,
                bool rejudgeAll = false);

  // One page, because its writer just saved it. Does not walk the reverse edge.
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

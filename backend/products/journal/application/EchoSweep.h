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
  // Units a segmenter proposed that are NOT in the page's body and were discarded rather than
  // stored. Above zero on a normal night means the model is rewriting rather than cutting.
  int unitsDiscarded = 0;
  // Pages the vendor declined to judge. Its own counter rather than a share of `pagesFailed`: a
  // failure is work still owed, this is work that will never be done and is no longer owed. It
  // stays a count — which pages, and what was in them, is not something this feature looks at.
  int pagesRefused = 0;
  int inboundEnqueued = 0;
  int pagesOverBudget = 0;
  int usersOverAiBudget = 0;
};

// What one night is allowed to cost a single user. A large cleanup pass cascades into every page
// holding an echo into the pages it touched; draining that over several nights costs the same as
// billing it in one.
struct SweepBudget {
  int pagesPerUser = 40;
  int inboundPerPage = 20;

  // The page-level cap; nothing else sees a whole page. `SelectionRules::shown` bounds one
  // TRIGGER's pairings, so without this a page with eight triggering passages carries eighty.
  int echoesPerPage = 10;
};

// The seven steps, and the two ways into them. Its own trantor thread either way, never a request
// loop: a curator call is seconds long and drogon has one handler thread per core.
//
//   segment -> embed -> reconcile -> retrieve -> select -> curate -> persist
//
// Step 1 is a VENDOR call (ports/Segmenter.h), asked only when the page's BODY moved — a corpus
// that moved under unchanged text changes what the page reaches, never what it says, so those
// passes read the units back out of storage and cost nothing.
//
// `derivePage` is the DELIVERY path — one page, the one a writer just saved (EchoDerivations owns
// the when). `run` is the REPAIR path: inbound reverse edges, corpus-stamp backfill, pages a
// vendor blip failed, and the per-user budget drain. Both share every step below; they differ only
// in what they are handed and what they are allowed to chase.
//
// Three properties hold the whole thing together, all three about failure. A page's derivation
// stamps advance ONLY when the pass SETTLED, so a vendor blip costs that page a night rather than
// its echoes forever. "The curator found nothing" is a different outcome from "the curator call
// failed". And a REFUSAL settles the page though it failed (ports/EchoRepository.h, isSettled);
// only an edit to the body reopens it.
//
// The sweep is entitlement-blind about WHAT it derives: it derives for everyone, and the read layer
// decides how much of a passage a given reader is served.
//
// It is not blind about what it SPENDS. Entitlements answers one question — has this account's
// BACKGROUND bucket run dry — asked once per user and answered from that bucket alone, never the
// account's own. Over it the user is SKIPPED, not failed: their pages' stamps never advance, so the
// work is deferred rather than lost. The live path asks the identical question.
class EchoSweep {
public:
  EchoSweep(EchoRepository& echoes, Segmenter& segmenter, Embedder& embedder, Curator& curator,
            Clock& clock, Entitlements& entitlements, SelectionRules rules, SweepBudget budget);

  void start();

  // `sinceMs` is the only instant a pass has an opinion about: which users have touched a page
  // recently enough to be worth scanning. Everything after that is decided by stamps the corpus
  // carries, never by the wall, so the sweep cannot drift against one.
  EchoSweepReport run(std::uint64_t sinceMs);

  // The same pass, queued onto this sweep's own loop and answered there — what the admin door uses,
  // so a repair pass of minutes does not sit on a drogon IO thread holding a pooled connection.
  void runAsync(std::uint64_t sinceMs, std::function<void(EchoSweepReport)> done);

  // One page, because its writer just saved it. The counters mean the same things, counting to one:
  // `usersOverAiBudget` is the skip and `pagesFailed` is the vendor blip, and both leave the page's
  // stamps where they were, so the repair pass still owes it. `pagesRefused` does not come back.
  //
  // It does NOT walk the reverse edge — that walk is unbounded and belongs to the budgeted pass.
  // The live path answers one question: what does tonight's page reach back to.
  EchoSweepReport derivePage(const UserId& user, const LocalDate& day);

private:
  // One page, end to end. Returns the outcome to record; the caller owns the report counters.
  CurationOutcome derive(const UserId& user, const DuePage& page, std::uint64_t corpusStamp,
                         EchoSweepReport& report);

  // What this build would produce, asked of both vendors at the front of every pass. A page recorded
  // under anything else is stale in a way its body and its corpus cannot reveal.
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

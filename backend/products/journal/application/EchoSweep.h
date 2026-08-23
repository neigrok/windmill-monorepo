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
  // Units a segmenter proposed that are NOT in the page's body, and were therefore discarded rather
  // than stored. It is the honesty counter for the one seam that could put words in the writer's
  // mouth: a number above zero on a normal night means the model is rewriting rather than cutting.
  int unitsDiscarded = 0;
  // Pages the vendor declined to judge. Its own counter rather than a share of `pagesFailed`,
  // because it is the opposite kind of number: a failure is work still owed and this is work that
  // will never be done and is no longer owed. It is also the only signal anyone gets that a body is
  // drawing refusals, and it must stay a count — which pages, and what was in them, is not
  // something this feature looks at.
  int pagesRefused = 0;
  int inboundEnqueued = 0;
  int pagesOverBudget = 0;
  int usersOverAiBudget = 0;
};

// What one night is allowed to cost a single user. A three-hundred-page cleanup pass — someone
// tidying their 2024 entries on a Sunday — cascades into every page holding an echo into those
// pages, and without a ceiling that bills in one night. Draining over several nights is slower and
// costs the same; billing it all at once is a self-inflicted spike with no upper bound.
struct SweepBudget {
  int pagesPerUser = 40;
  int inboundPerPage = 20;

  // The page-level cap, and it has to live here because nothing else sees a whole page.
  // `SelectionRules::shown` bounds one TRIGGER's pairings; a page with eight triggering passages
  // would otherwise carry eighty echoes and the surface's "up to ten" would be fiction.
  int echoesPerPage = 10;
};

// The seven steps, and the two ways into them. Its own trantor thread either way, never a request
// loop: a curator call is seconds long and drogon has one handler thread per core.
//
//   segment → embed → reconcile → retrieve → select → curate → persist
//
// Step 1 is a VENDOR call since 2026-08-23 (ports/Segmenter.h): a page is cut into idea units by a
// model rather than into lines and sentences by a rule, because the rule put three unrelated
// thoughts in one vector and retrieval never saw any of them. It is asked only when the page's
// BODY moved — a corpus that moved under unchanged text changes what the page reaches, never what
// it says, so those passes read the units back out of storage and cost nothing.
//
// `derivePage` is the DELIVERY path — one page, the one a writer just saved, run the moment they
// stop typing (EchoDerivations owns the when). `run` is the REPAIR path: inbound reverse edges,
// corpus-stamp backfill, pages a vendor blip failed, and the per-user budget drain. Both share
// every step below; they differ only in what they are handed and what they are allowed to chase.
// Nobody receives an echo from `run` any more — they receive it seconds after they wrote it, and
// `run` is what makes sure a page nothing triggered is not left behind.
//
// Three properties hold the whole thing together, and all three are about failure rather than
// success. A page's derivation stamps advance ONLY when the pass SETTLED, so a vendor blip at 02:14
// costs that page a night rather than its echoes forever. "The curator found nothing" is a
// different outcome from "the curator call failed" — conflating them stores a silence the user can
// never recover from. And a REFUSAL settles the page though it failed: it is an answer about the
// text rather than a blip in front of it, so retrying it bills forever for an echo that can never
// arrive (ports/EchoRepository.h, isSettled). Only an edit to the body reopens it.
//
// The sweep is deliberately entitlement-blind about WHAT it derives: it derives for everyone, and
// the read layer decides how much of a passage a given reader is served. The gate moved there when
// the design canon's honest-cut state required a non-subscriber to see that echoes exist at all.
//
// It is not blind about what it SPENDS. Entitlements is here for one question — has this account's
// background bucket run dry — asked once per user and answered from that bucket alone, never the
// account's own. A pass nobody asked for eating the allowance their next question is then refused
// for is indefensible, and it is the reason the two buckets are separate at all. Over it the user
// is SKIPPED, not failed: their pages' stamps never advance, so the work is deferred to a later
// pass rather than lost, which is the same promise a vendor blip at 02:14 already gets. The live
// path asks the identical question for the identical reason — a writer typing all evening is still
// a background spend, and the ceiling does not care which trigger reached it.
class EchoSweep {
public:
  EchoSweep(EchoRepository& echoes, Segmenter& segmenter, Embedder& embedder, Curator& curator,
            Clock& clock, Entitlements& entitlements, SelectionRules rules, SweepBudget budget);

  void start();

  // `sinceMs` is the only instant a pass has an opinion about: which users have touched a page
  // recently enough to be worth scanning. Everything after that is decided by stamps the corpus
  // carries, never by the wall — which is why the sweep takes no "now" and cannot drift against one.
  EchoSweepReport run(std::uint64_t sinceMs);

  // The same pass, queued onto this sweep's own loop and answered there — what the admin door uses.
  // A repair pass is minutes of embedder and curator calls, and it was running on the drogon IO
  // thread that took the request, holding one of the twenty pooled connections through all of it.
  void runAsync(std::uint64_t sinceMs, std::function<void(EchoSweepReport)> done);

  // One page, because its writer just saved it. The counters mean the same things they mean above,
  // counting to one — `usersOverAiBudget` is the skip and `pagesFailed` is the vendor blip, and both
  // leave the page's stamps exactly where they were, so the repair pass still owes it.
  // `pagesRefused` is the one that does not come back.
  //
  // It does NOT walk the reverse edge. A page whose passages moved has to be chased back through
  // every page reaching into it, and that walk is unbounded in the writer's own body — it belongs
  // to the budgeted pass, which is where it stays. The live path answers one question only: what
  // does tonight's page reach back to.
  EchoSweepReport derivePage(const UserId& user, const LocalDate& day);

private:
  // One page, end to end. Returns the outcome to record; the caller owns the report counters so
  // this stays a pipeline that reads top to bottom rather than a method that also does bookkeeping.
  CurationOutcome derive(const UserId& user, const DuePage& page, std::uint64_t corpusStamp,
                         EchoSweepReport& report);

  // What this build would produce, asked of both vendors at the front of every pass. A page
  // recorded under anything else is stale in a way its body and its corpus cannot reveal.
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

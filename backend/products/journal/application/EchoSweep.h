#pragma once

#include "platform/ports/Clock.h"
#include "products/journal/domain/EchoSelection.h"
#include "products/journal/ports/Curator.h"
#include "products/journal/ports/EchoRepository.h"
#include "products/journal/ports/Embedder.h"

#include <trantor/net/EventLoopThread.h>

#include <cstdint>

namespace wm {

struct EchoSweepReport {
  int usersScanned = 0;
  int pagesDerived = 0;
  int pagesSkippedRefrain = 0;
  int passagesEmbedded = 0;
  int echoesWritten = 0;
  int pagesFailed = 0;
  int inboundEnqueued = 0;
  int pagesOverBudget = 0;
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

// The nightly pass. Its own trantor thread, never a request loop.
//
// Seven steps per page whose body moved, or whose corpus moved under it:
//
//   segment → embed → reconcile → retrieve → select → curate → persist
//
// Two properties hold the whole thing together, and both are about failure rather than success.
// A page's derivation stamps advance ONLY when the pass succeeded, so a vendor blip at 02:14 costs
// that page a night rather than its echoes forever. And "the curator found nothing" is a different
// outcome from "the curator call failed" — conflating them stores a silence the user can never
// recover from.
//
// The sweep is deliberately entitlement-blind: it derives for everyone, and the read layer decides
// how much of a passage a given reader is served. The gate moved there when the design canon's
// honest-cut state required a non-subscriber to see that echoes exist at all.
class EchoSweep {
public:
  EchoSweep(EchoRepository& echoes, Embedder& embedder, Curator& curator, Clock& clock,
            SelectionRules rules, SweepBudget budget);

  void start();
  EchoSweepReport run(std::uint64_t nowMs, std::uint64_t sinceMs);

private:
  void tick();
  // One page, end to end. Returns the outcome to record; the caller owns the report counters so
  // this stays a pipeline that reads top to bottom rather than a method that also does bookkeeping.
  CurationOutcome derive(const UserId& user, const DuePage& page, std::uint64_t corpusStamp,
                         EchoSweepReport& report);

  EchoRepository& echoes_;
  Embedder& embedder_;
  Curator& curator_;
  Clock& clock_;
  SelectionRules rules_;
  SweepBudget budget_;
  trantor::EventLoopThread ticker_;   // declared last: destructs first, before the deps it uses
};

}

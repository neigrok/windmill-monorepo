#pragma once

#include "platform/application/Entitlements.h"
#include "platform/ports/Clock.h"
#include "products/journal/domain/EchoFinder.h"
#include "products/journal/ports/EchoRepository.h"
#include "products/journal/ports/Embedder.h"

#include <trantor/net/EventLoopThread.h>

#include <cstdint>

namespace wm {

struct EchoSweepReport {
  int usersScanned = 0;
  int vectorsComputed = 0;
  int echoesFound = 0;
  int skippedNotSubscribed = 0;
};

// The one paid thing, computed for you without being asked. A nightly pass (its own trantor thread,
// never a request loop) over users with recent pages: for each SUBSCRIBER — the gate is "do we
// compute", not "do we show", so a non-subscriber gets no rows rather than a locked state — it
// embeds any missing page vectors, then for each recently-changed day asks the pure EchoFinder
// whether it resonates with an older page, and stores the match. If no Embedder is configured the
// whole pass is a quiet no-op. run() is public so an operator (and the tests) can drive one pass at
// an arbitrary instant over an arbitrary look-back window.
class EchoSweep {
public:
  EchoSweep(EchoRepository& echoes, Embedder& embedder, Entitlements& entitlements, Clock& clock,
            EchoRules rules);

  void start();
  EchoSweepReport run(std::uint64_t nowMs, std::uint64_t sinceMs);

private:
  void tick();

  EchoRepository& echoes_;
  Embedder& embedder_;
  Entitlements& entitlements_;
  Clock& clock_;
  EchoRules rules_;
  trantor::EventLoopThread ticker_;   // declared last: destructs first, before the deps it uses
};

}

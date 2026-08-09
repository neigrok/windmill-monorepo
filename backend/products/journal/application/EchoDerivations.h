#pragma once

#include "platform/application/Heartbeat.h"
#include "platform/ports/Clock.h"
#include "products/journal/application/EchoSweep.h"
#include "products/journal/application/PageService.h"

#include <cstddef>
#include <cstdint>
#include <map>
#include <mutex>
#include <string>

namespace wm {

// When a saved page is derived, and how often it is allowed to be. Every number here is a spend
// decision wearing a latency costume, which is why they sit together where a reader can see the
// whole policy at once.
struct LiveDerivationRules {
  // Quiet time. Someone writing a paragraph saves every few seconds; deriving on each of those
  // would buy the same page eight times and hand back the first version's echoes seven times too
  // early. Eight seconds is long enough to be past a sentence and short enough that a writer who
  // puts the phone down still sees the mark before they have closed the app.
  std::uint64_t quietMs = 8'000;

  // …unless enough new text arrived to be worth answering about on its own. A long evening's
  // writing is not one thought, and making it wait for a pause that never comes is the failure
  // mode a pure debounce has. Roughly a paragraph.
  std::size_t materialBytes = 400;

  // What one page may cost in one rolling day. Past it the page is not derived and not failed — it
  // is simply left owed, and the repair pass takes it. This is the brake on the pathological case:
  // a page edited all day, every edit a paragraph long, otherwise buys a curator call each time.
  int perPageDaily = 4;
  std::uint64_t dailyWindowMs = 24ull * 60 * 60 * 1000;
};

// What one drain did. `deferred` is the honest one to watch: it is not an error, it is the cap
// handing work to the repair pass, and a number that climbs says the cap is too tight for how
// people actually write.
struct EchoLiveReport {
  int derived = 0;
  int failed = 0;
  int deferred = 0;
  int skippedOverBudget = 0;
  int alreadyDerived = 0;
};

// The delivery path's scheduler: it turns saves into derivations, and it is the only thing in the
// product that knows a page was written recently rather than merely written.
//
// Echoes used to arrive on a six-hourly ticker, so a page written tonight waited between zero and
// six hours for the reaching-back that is the whole feature. They are computed on write now. This
// class is the "when": PageService tells it a page was saved, and seconds later the page is
// derived on this object's own thread.
//
// TWO THINGS IT MUST NEVER DO, and they are the same thing said twice. It must never derive on the
// request thread — drogon has four handler threads and a curator call is 1.5–8 seconds, so a save
// that waited for its echoes would take a quarter of the server down with it; `pageSaved` therefore
// does map bookkeeping under a short mutex and returns. And it must never make the writer wait for
// anything: there is no pending state, no progress route and no spinner, because the journal does
// not speak on its own initiative and the client re-reads on its own.
class EchoDerivations : public PageWatcher {
public:
  EchoDerivations(EchoSweep& sweep, Clock& clock, LiveDerivationRules rules);

  void start();

  // A page was saved. Coalescing lives here: the first save opens a pending entry and every save
  // after it pushes the entry's ready instant out again, so ten minutes of typing is one derivation
  // rather than ten — unless the text has grown by `materialBytes` since the entry opened, which
  // makes it ready now.
  void pageSaved(const UserId& user, const LocalDate& day, std::size_t bodyBytes) override;

  // Derive everything that has gone quiet. Public and taking its own `now` because that is what
  // makes the policy testable without a thread: the heartbeat below is one caller of it and a test
  // with a fake clock is another.
  EchoLiveReport drain(std::uint64_t nowMs);

private:
  // A page waiting for its writer to stop. `openedBytes` is the size at the save that opened this
  // entry — which is the size the last derivation saw, since a derivation is what closes one — so
  // the distance from it is genuinely new material and not just a big page.
  struct Pending {
    UserId user;
    LocalDate day;
    std::size_t openedBytes = 0;
    std::uint64_t readyAtMs = 0;
  };

  // One page's spend inside a rolling day. The window opens at the first derivation rather than at
  // midnight: nobody's writing day starts at midnight, and a window nobody has to name a timezone
  // for cannot disagree with the device about which day it is.
  struct Spent {
    int derivations = 0;
    std::uint64_t windowStartMs = 0;
  };

  EchoSweep& sweep_;
  Clock& clock_;
  LiveDerivationRules rules_;
  std::mutex lock_;
  std::map<std::string, Pending> pending_;
  std::map<std::string, Spent> spent_;
  Heartbeat heartbeat_;   // declared last: destructs first, before the deps a running drain holds
};

}

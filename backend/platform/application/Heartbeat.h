#pragma once

#include <trantor/net/EventLoopThread.h>
#include <trantor/utils/Logger.h>

#include <exception>
#include <functional>
#include <string>
#include <utility>

namespace wm {

// The thread a product's periodic pass runs on, and the shape of the pass. Three sweeps needed
// exactly this and each wrote it out: roadmap's reminders, journal's nudges, journal's echoes. The
// node that asked for this promotion was filed to stop a third copy and the third copy arrived
// first, which is the usual way — the skeleton is short enough to retype and long enough to get
// subtly wrong.
//
// What is fixed here, because it is the part that must not vary:
//
// The loop RUNS FROM CONSTRUCTION, not from start(). An operator's pass can be queued onto a
// heartbeat that was never armed — the admin sweep endpoints do exactly that — and a loop nobody
// spun would swallow that work in silence.
//
// The trigger is DUMB. It holds no schedule: a pass is a pure function of (now, database), so a
// deploy restart loses nothing and the process comes up and asks the database who is due. Do not
// put a schedule in the timer.
//
// The pass is CRASH-GUARDED. Whatever one pass runs into — a dropped connection, a row nobody can
// parse, a vendor timing out — the heartbeat must survive to beat again. Exceptions never escape
// the loop.
//
// What deliberately does NOT live here: the claim mutex, the arming allowlist and the send log.
// Two of the three sweeps mail and one derives, so folding a mail pipeline into this would hand
// EchoSweep a gate it must inherit and ignore. That pipeline is MailSweep (MailSweep.h, since
// 2026-08-15): DECIDE → CLAIM → SEND written once, which ReminderSweep and NudgeSweep derive from
// while each keeps a Heartbeat of its own — two things shared at two depths.
//
// ONE RULE FOR CALLERS: declare the Heartbeat LAST in your class, so it is destroyed FIRST. Its
// destructor quits the loop and joins the thread, and that has to happen while the collaborators a
// running pass holds references to are still alive.
class Heartbeat {
public:
  explicit Heartbeat(std::string name) : name_(std::move(name)), thread_(name_ + "-ticker") {
    thread_.run();
  }

  // Arm it: one pass after `firstTickSeconds`, then every `periodSeconds`. The first delay is the
  // caller's to choose and the three callers choose differently on purpose — a drawn jitter keeps a
  // crash-looping process from hammering the database, a fixed offset keeps entropy out of the
  // path. Both arguments are defensible and the disagreement is theirs to settle, not this file's.
  void start(double firstTickSeconds, double periodSeconds, std::function<void()> pass) {
    pass_ = std::move(pass);
    thread_.getLoop()->runAfter(firstTickSeconds, [this, periodSeconds] {
      beat();
      thread_.getLoop()->runEvery(periodSeconds, [this] { beat(); });
    });
  }

  // Run something on the heartbeat's own loop rather than the caller's thread. The admin doors use
  // it: a drogon IO thread serves every other request in flight, and parking one on a sweep would
  // pin a quarter of the server's capacity for as long as the batch takes. Queuing also serialises
  // an operator's pass behind the heartbeat's instead of racing it.
  void queue(std::function<void()> work) { thread_.getLoop()->queueInLoop(std::move(work)); }

private:
  void beat() {
    try {
      pass_();
    } catch (const std::exception& error) {
      LOG_ERROR << name_ << " sweep failed: " << error.what();
    } catch (...) {
      LOG_ERROR << name_ << " sweep failed";
    }
  }

  std::string name_;
  std::function<void()> pass_;
  // Last, so it destructs first — the rule this class asks of its own callers.
  trantor::EventLoopThread thread_;
};

}

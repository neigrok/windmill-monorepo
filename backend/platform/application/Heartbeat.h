#pragma once

#include <trantor/net/EventLoopThread.h>
#include <trantor/utils/Logger.h>

#include <exception>
#include <functional>
#include <string>
#include <utility>

namespace wm {

// The thread a product's periodic pass runs on. The loop runs from CONSTRUCTION, not from start(),
// so work can be queued onto a heartbeat that was never armed. Exceptions never escape the loop.
// Declare the Heartbeat LAST in the owning class, so it is destroyed FIRST: its destructor joins
// the thread, which must happen while a running pass's collaborators are still alive.
class Heartbeat {
public:
  explicit Heartbeat(std::string name) : name_(std::move(name)), thread_(name_ + "-ticker") {
    thread_.run();
  }

  // Arm it: one pass after `firstTickSeconds`, then every `periodSeconds`.
  void start(double firstTickSeconds, double periodSeconds, std::function<void()> pass) {
    pass_ = std::move(pass);
    thread_.getLoop()->runAfter(firstTickSeconds, [this, periodSeconds] {
      beat();
      thread_.getLoop()->runEvery(periodSeconds, [this] { beat(); });
    });
  }

  // Run work on the heartbeat's own loop rather than parking a request thread on it; this also
  // serialises an operator's pass behind the heartbeat's instead of racing it.
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

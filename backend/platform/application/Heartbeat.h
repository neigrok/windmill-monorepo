#pragma once

#include "platform/application/WorkerPool.h"
#include "platform/application/WriteObservation.h"

#include <trantor/net/EventLoopThread.h>
#include <trantor/utils/Logger.h>

#include <exception>
#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <utility>

namespace wm {

// The thread a product's periodic pass runs on. The loop runs from CONSTRUCTION, not from start(),
// so work can be queued onto a heartbeat that was never armed. Exceptions never escape the loop.
// Declare the Heartbeat LAST in the owning class, so it is destroyed FIRST: its destructor joins
// the thread, which must happen while a running pass's collaborators are still alive.
class Heartbeat {
public:
  explicit Heartbeat(std::string name, std::string product = "platform")
      : name_(std::move(name)), product_(std::move(product)), thread_(name_ + "-ticker") {
    thread_.run();
  }

  ~Heartbeat() { stop(); }

  void stop() {
    std::call_once(stopped_, [this] {
      {
        std::lock_guard lock{mutex_};
        stopping_ = true;
        thread_.getLoop()->queueInLoop([this] {
          // queueInLoop must finish waking the loop before quit can close its wakeup pipe.
          std::lock_guard lock{mutex_};
          thread_.getLoop()->quit();
        });
      }
      thread_.wait();
    });
  }

  // Arm it: one pass after `firstTickSeconds`, then every `periodSeconds`.
  void start(double firstTickSeconds, double periodSeconds, std::function<void()> pass) {
    std::lock_guard lock{mutex_};
    if (stopping_) return;
    pass_ = std::move(pass);
    thread_.getLoop()->runAfter(firstTickSeconds, [this, periodSeconds] {
      if (stopping_) return;
      beat();
      thread_.getLoop()->runEvery(periodSeconds, [this] { beat(); });
    });
  }

  // Run work on the heartbeat's own loop rather than parking a request thread on it; this also
  // serialises an operator's pass behind the heartbeat's instead of racing it.
  void queue(std::function<void()> work) {
    std::lock_guard lock{mutex_};
    if (stopping_) return;
    auto observation = std::make_shared<WriteObservation>("background." + name_, product_, "background");
    thread_.getLoop()->queueInLoop([work = std::move(work), observation] {
      BlockingThread::Mark blocking;
      WriteContext context{*observation};
      const auto writes = observation->writeCount();
      try {
        work();
        if (observation->writeCount() == writes) observation->skip();
        else observation->finish();
      } catch (const std::exception& error) {
        observation->fail(error);
      } catch (...) {
        observation->failUnknown();
      }
    });
  }

private:
  void beat() {
    if (stopping_) return;
    BlockingThread::Mark blocking;
    WriteObservation observation{"background." + name_, product_, "background"};
    WriteContext context{observation};
    const auto writes = observation.writeCount();
    try {
      pass_();
      if (observation.writeCount() == writes) observation.skip();
      else observation.finish();
    } catch (const std::exception& error) {
      observation.fail(error);
    } catch (...) {
      observation.failUnknown();
    }
  }

  std::string name_;
  std::string product_;
  std::function<void()> pass_;
  std::mutex mutex_;
  std::once_flag stopped_;
  std::atomic<bool> stopping_{false};
  // Last, so it destructs first — the rule this class asks of its own callers.
  trantor::EventLoopThread thread_;
};

}

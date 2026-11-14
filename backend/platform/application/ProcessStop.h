#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <functional>
#include <memory>
#include <mutex>
#include <thread>

namespace wm {

// The order a process stops in and the time it stops by. A thread of its own waits to be told the process was
// signalled. Told, it runs `closeDoors` at once — no door takes a write after it — and waits for the stop to finish. If
// `budget` passes first, counted from the signal, it runs `giveUp`, which stops waiting for whatever is still
// running: it says what is lost, flushes what the process has to say and ends the process.
//
// `signalled` is all a signal handler may call: it sets one flag and writes one byte to a pipe. Nothing here owns what
// the steps touch, so whoever makes one keeps it alive until `finished`, and takes the handlers that call it away
// before then.
class ProcessStop {
public:
  struct Steps {
    std::function<void()> closeDoors;
    std::function<void()> giveUp;
  };
  // What `giveUp` may take to flush the log and the failure reports before it ends the process: the deploy gives a
  // container its budget and this, and a little more, to stop (deploy/README.md).
  static constexpr std::chrono::milliseconds kExitFlushLimit{3000};

  ProcessStop(std::chrono::milliseconds budget, Steps steps);
  // A stop that goes away has finished.
  ~ProcessStop();
  ProcessStop(const ProcessStop&) = delete;
  ProcessStop& operator=(const ProcessStop&) = delete;

  void signalled() noexcept;
  // The stop is over, inside the budget or not: `giveUp` no longer runs, and one already running is waited for.
  void finished();
  // Set from the signal on, for a door to ask; it outlives this object in whoever keeps the pointer.
  const std::shared_ptr<const std::atomic<bool>>& stopping() const { return shared_; }

private:
  void watch();

  std::chrono::milliseconds budget_;
  Steps steps_;
  std::shared_ptr<std::atomic<bool>> stopping_ = std::make_shared<std::atomic<bool>>(false);
  std::shared_ptr<const std::atomic<bool>> shared_ = stopping_;
  int wake_[2] = {-1, -1};  // a pipe: the handler writes, the watcher reads
  std::mutex mutex_;
  std::condition_variable changed_;
  bool finished_ = false;
  std::thread watcher_;
};

}

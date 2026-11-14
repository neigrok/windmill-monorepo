#include "platform/application/ProcessStop.h"

#include <cerrno>
#include <stdexcept>
#include <utility>

#include <unistd.h>

namespace wm {

ProcessStop::ProcessStop(std::chrono::milliseconds budget, Steps steps) : budget_(budget), steps_(std::move(steps)) {
  if (pipe(wake_) != 0) throw std::runtime_error("the process could not open the pipe its stop is told through");
  watcher_ = std::thread([this] { watch(); });
}

ProcessStop::~ProcessStop() {
  finished();
  close(wake_[0]);
  close(wake_[1]);
}

void ProcessStop::signalled() noexcept {
  stopping_->store(true);
  const char told = 's';
  // A full pipe already holds the word; the watcher needs only one byte.
  while (write(wake_[1], &told, 1) < 0 && errno == EINTR) {
  }
}

void ProcessStop::finished() {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (finished_) return;
    finished_ = true;
  }
  changed_.notify_all();
  // A watcher still waiting to be told is woken by the same pipe; `finished_` tells it why.
  const char done = 'f';
  while (write(wake_[1], &done, 1) < 0 && errno == EINTR) {
  }
  if (watcher_.joinable()) watcher_.join();
}

void ProcessStop::watch() {
  char told = 0;
  while (read(wake_[0], &told, 1) < 0 && errno == EINTR) {
  }
  const auto deadline = std::chrono::steady_clock::now() + budget_;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (finished_) return;
  }
  steps_.closeDoors();
  std::unique_lock<std::mutex> lock(mutex_);
  if (changed_.wait_until(lock, deadline, [this] { return finished_; })) return;
  lock.unlock();
  steps_.giveUp();
}

}

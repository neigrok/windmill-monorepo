#include "platform/application/WorkerPool.h"

#include <exception>
#include <iostream>
#include <typeinfo>
#include <utility>

#if defined(__GLIBCXX__)
#include <cxxabi.h>
#endif

namespace wm {

namespace {

thread_local int blockingMarks = 0;

// A throwing job never takes its worker or its strand down with it. The log names the exception's type, never its message.
void runSurviving(const std::string& pool, std::function<void()> job) {
  try {
    job();
  } catch (const WorkerPoolStopping&) {
    // A job that gave up on shutdown did not fail.
  } catch (const std::exception& error) {
    std::cerr << (pool + " job failed: " + typeid(error).name() + "\n");
  }
#if defined(__GLIBCXX__)
  catch (abi::__forced_unwind&) {
    throw;
  }
#endif
  catch (...) {
    std::cerr << (pool + " job failed: a non-standard exception\n");
  }
}

}

WorkerPool::WorkerPool(std::string name, std::size_t threads, std::size_t queueCeiling)
    : name_(std::move(name)), queueCeiling_(queueCeiling) {
  if (threads == 0) throw std::invalid_argument(name_ + " needs at least one worker thread");
  workers_.reserve(threads);
  try {
    for (std::size_t i = 0; i < threads; ++i) workers_.emplace_back([this] { work(); });
  } catch (...) {
    stopAndJoin();
    throw;
  }
}

WorkerPool::~WorkerPool() {
  stopAndJoin();
}

bool WorkerPool::post(std::function<void()> job) {
  {
    std::lock_guard lock{mutex_};
    if (stopping_ || jobs_.size() >= queueCeiling_) return false;
    jobs_.push_back(std::move(job));
  }
  wake_.notify_one();
  return true;
}

bool WorkerPool::stopping() const {
  std::lock_guard lock{mutex_};
  return stopping_;
}

std::size_t WorkerPool::queued() const {
  std::lock_guard lock{mutex_};
  return jobs_.size();
}

void WorkerPool::work() {
  BlockingThread::Mark blocking;
  for (;;) {
    std::function<void()> job;
    {
      std::unique_lock lock{mutex_};
      wake_.wait(lock, [this] { return stopping_ || !jobs_.empty(); });
      if (jobs_.empty()) return;
      job = std::move(jobs_.front());
      jobs_.pop_front();
    }
    runSurviving(name_, std::move(job));
  }
}

void WorkerPool::stopAndJoin() {
  {
    std::lock_guard lock{mutex_};
    stopping_ = true;
  }
  wake_.notify_all();
  for (std::thread& worker : workers_) worker.join();
}

struct WorkerPool::Strand::Backlog {
  std::mutex mutex;
  std::deque<std::function<void()>> jobs;
  bool running = false;   // a turn is queued on the pool or draining these jobs

  std::function<void()> next() {
    std::lock_guard lock{mutex};
    std::function<void()> job = std::move(jobs.front());
    jobs.pop_front();
    return job;
  }
};

WorkerPool::Strand::Strand(WorkerPool& pool) : pool_(pool), backlog_(std::make_shared<Backlog>()) {}

bool WorkerPool::Strand::post(std::function<void()> job) {
  if (pool_.stopping()) return false;
  std::lock_guard lock{backlog_->mutex};
  if (!backlog_->running) {
    if (!pool_.post([&pool = pool_, backlog = backlog_] { turn(pool, backlog); })) return false;
    backlog_->running = true;
  }
  backlog_->jobs.push_back(std::move(job));
  return true;
}

// Runs one job, then hands the rest to a fresh turn; when the pool refuses that turn, it keeps draining here.
void WorkerPool::Strand::turn(WorkerPool& pool, const std::shared_ptr<Backlog>& backlog) {
  for (;;) {
    runSurviving(pool.name_, backlog->next());   // a temporary: its captures are gone before the next turn starts
    std::lock_guard lock{backlog->mutex};
    if (backlog->jobs.empty()) {
      backlog->running = false;
      return;
    }
    if (pool.post([&pool, backlog] { turn(pool, backlog); })) return;
  }
}

BlockingThread::Mark::Mark() {
  ++blockingMarks;
}

BlockingThread::Mark::~Mark() {
  --blockingMarks;
}

bool BlockingThread::here() {
  return blockingMarks > 0;
}

void requireBlockingThread() {
  if (BlockingThread::here()) return;
  throw std::logic_error("engine.md §6: push, pull and server-origin admission run on a worker pool, never on an IO loop");
}

}

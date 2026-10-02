#pragma once

#include <condition_variable>
#include <cstddef>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace wm {

// Thrown by a job that sees stopping() and gives up: shutdown is transient to the sync engine (§6.6), never a fault.
struct WorkerPoolStopping : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// The threads push, pull and server-origin admission block on (engine.md §6), apart from every IO loop.
class WorkerPool {
public:
  WorkerPool(std::string name, std::size_t threads, std::size_t queueCeiling);
  // Stops accepting, runs every job already queued (each sees stopping()), then joins.
  ~WorkerPool();
  WorkerPool(const WorkerPool&) = delete;
  WorkerPool& operator=(const WorkerPool&) = delete;

  // False when queueCeiling jobs are already waiting or the pool is stopping: the caller answers 503.
  bool post(std::function<void()> job);
  bool stopping() const;
  std::size_t queued() const;
  // Explicitly drain while the jobs' referenced state is still alive, even if adapters retain the pool.
  void stopAndJoin();

  // Serial on the pool: one job at a time, in post order, and its jobs still run after the Strand is gone.
  class Strand {
  public:
    explicit Strand(WorkerPool& pool);
    // False when the pool is stopping or refuses the job that would carry the strand's next turn.
    bool post(std::function<void()> job);

  private:
    struct Backlog;
    static void turn(WorkerPool& pool, const std::shared_ptr<Backlog>& backlog);

    WorkerPool& pool_;
    std::shared_ptr<Backlog> backlog_;
  };

private:
  void work();

  std::string name_;
  std::size_t queueCeiling_;
  mutable std::mutex mutex_;
  std::condition_variable wake_;
  std::deque<std::function<void()>> jobs_;
  bool stopping_ = false;
  std::vector<std::thread> workers_;
};

// A thread that may block on Postgres: every WorkerPool thread and every Heartbeat pass. Drogon IO threads never are.
struct BlockingThread {
  static bool here();

  // Marks the calling thread for the Mark's lifetime; Marks nest.
  struct Mark {
    Mark();
    ~Mark();
    Mark(const Mark&) = delete;
    Mark& operator=(const Mark&) = delete;
  };
};

// Throws std::logic_error naming engine.md §6 when the calling thread is not a BlockingThread.
void requireBlockingThread();

}

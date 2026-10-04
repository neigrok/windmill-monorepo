#include "platform/application/WorkerPool.h"

#include "platform/application/Heartbeat.h"

#include "test/testing.h"

#include <atomic>
#include <future>
#include <iostream>
#include <memory>
#include <mutex>
#include <numeric>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <typeinfo>
#include <vector>

using namespace wm;

namespace {

// Routes std::cerr into `text` for its lifetime and hands the console back on every exit path.
struct CapturedCerr {
  std::ostringstream text;
  std::streambuf* console = std::cerr.rdbuf(text.rdbuf());
  ~CapturedCerr() { std::cerr.rdbuf(console); }
};

}

TEST(worker_pool_explicit_shutdown_drains_jobs_while_adapters_still_hold_the_pool) {
  auto pool = std::make_shared<WorkerPool>("test", 2, 8);
  auto adapterPool = pool;
  std::atomic<int> completed{0};
  for (int i = 0; i < 8; ++i) REQUIRE(pool->post([&completed] { ++completed; }));
  pool->stopAndJoin();
  CHECK_EQ(completed.load(), 8);
  CHECK(pool->stopping());
  CHECK_EQ(pool->queued(), 0u);
  CHECK_FALSE(adapterPool->post([] {}));
  pool.reset();
  adapterPool->stopAndJoin();
  adapterPool.reset();
}

TEST(worker_pool_jobs_run_on_blocking_threads_and_the_caller_is_not_one) {
  struct Seen {
    bool blocking;
    bool passesTheRequirement;
    bool offTheCaller;
    bool operator==(const Seen&) const = default;
  };
  std::promise<Seen> seen;
  std::future<Seen> job = seen.get_future();
  const std::thread::id caller = std::this_thread::get_id();
  WorkerPool pool{"test", 2, 8};

  CHECK(pool.post([&seen, caller] {
    bool passes = true;
    try {
      requireBlockingThread();
    } catch (const std::logic_error&) {
      passes = false;
    }
    seen.set_value(Seen{BlockingThread::here(), passes, std::this_thread::get_id() != caller});
  }));

  CHECK(job.get() == (Seen{true, true, true}));
  CHECK_FALSE(BlockingThread::here());
  std::string refusal;
  try {
    requireBlockingThread();
  } catch (const std::logic_error& error) {
    refusal = error.what();
  }
  CHECK_EQ(refusal, std::string("engine.md §6: push, pull and server-origin admission run on a worker pool, "
                                "never on an IO loop"));
}

TEST(blocking_thread_marks_nest) {
  CHECK_FALSE(BlockingThread::here());
  {
    BlockingThread::Mark outer;
    {
      BlockingThread::Mark inner;
      CHECK(BlockingThread::here());
    }
    CHECK(BlockingThread::here());
    requireBlockingThread();
  }
  CHECK_FALSE(BlockingThread::here());
}

TEST(worker_pool_refuses_to_start_with_no_threads) {
  std::string refusal;
  try {
    WorkerPool pool{"test", 0, 8};
  } catch (const std::invalid_argument& error) {
    refusal = error.what();
  }
  CHECK_EQ(refusal, std::string("test needs at least one worker thread"));
}

TEST(worker_pool_with_every_worker_busy_queues_exactly_its_ceiling) {
  std::promise<void> firstBusy;
  std::promise<void> secondBusy;
  std::future<void> firstStarted = firstBusy.get_future();
  std::future<void> secondStarted = secondBusy.get_future();
  std::atomic<int> ran{0};
  {
    WorkerPool pool{"test", 2, 3};
    // Declared after the pool: a case cut short breaks it, so the blocked workers still wake and join.
    std::promise<void> release;
    std::shared_future<void> released = release.get_future().share();

    CHECK(pool.post([&firstBusy, &ran, released] { firstBusy.set_value(); released.wait(); ++ran; }));
    CHECK(pool.post([&secondBusy, &ran, released] { secondBusy.set_value(); released.wait(); ++ran; }));
    firstStarted.wait();
    secondStarted.wait();

    CHECK(pool.post([&ran] { ++ran; }));
    CHECK(pool.post([&ran] { ++ran; }));
    CHECK(pool.post([&ran] { ++ran; }));
    CHECK_EQ(pool.queued(), std::size_t{3});
    CHECK_FALSE(pool.post([&ran] { ++ran; }));
    CHECK_EQ(pool.queued(), std::size_t{3});
    release.set_value();
  }
  CHECK_EQ(ran.load(), 5);
}

TEST(worker_pool_shutdown_runs_every_queued_job_and_each_sees_stopping) {
  struct Seen {
    int job;
    bool stopping;
    bool poolTookAPost;
    bool strandTookAPost;
    bool operator==(const Seen&) const = default;
  };
  std::vector<Seen> seen;
  std::promise<void> busy;
  std::future<void> started = busy.get_future();
  std::optional<WorkerPool> pool{std::in_place, "test", 1, 8};
  WorkerPool::Strand strand{*pool};
  const auto record = [&pool = *pool, &strand, &seen](int job) {
    return [&pool, &strand, &seen, job] {
      seen.push_back(Seen{job, pool.stopping(), pool.post([] {}), strand.post([] {})});
    };
  };

  CHECK(pool->post([&pool = *pool, &busy] {
    busy.set_value();
    while (!pool.stopping()) std::this_thread::yield();
  }));
  started.wait();
  CHECK(pool->post(record(0)));
  CHECK(strand.post(record(1)));
  CHECK(strand.post(record(2)));
  CHECK(pool->post(record(3)));
  CHECK_EQ(pool->queued(), std::size_t{3});

  pool.reset();
  CHECK(seen == (std::vector<Seen>{
                    {0, true, false, false}, {1, true, false, false}, {2, true, false, false}, {3, true, false, false}}));
}

TEST(worker_pool_survives_a_throwing_job_and_logs_only_its_type) {
  std::promise<void> later;
  std::future<void> laterRan = later.get_future();
  std::string logged;
  {
    CapturedCerr cerr;
    {
      WorkerPool pool{"test", 1, 8};
      CHECK(pool.post([] { throw std::runtime_error("a message that may carry user data"); }));
      CHECK(pool.post([] { throw 7; }));
      CHECK(pool.post([] { throw WorkerPoolStopping("gave up on shutdown"); }));
      CHECK(pool.post([&later] { later.set_value(); }));
      laterRan.wait();
    }
    logged = cerr.text.str();
  }
  CHECK_EQ(logged, std::string("test job failed: ") + typeid(std::runtime_error).name() + "\n" +
                       "test job failed: a non-standard exception\n");
}

TEST(strand_runs_a_thousand_jobs_from_four_threads_one_at_a_time_in_post_order) {
  std::mutex recording;
  std::vector<std::vector<int>> ranPerPoster(4);
  std::atomic<int> inFlight{0};
  std::atomic<bool> overlapped{false};
  std::atomic<int> accepted{0};
  std::atomic<int> finished{0};
  std::promise<void> everyJob;
  std::future<void> allRan = everyJob.get_future();
  std::promise<void> go;
  std::shared_future<void> started = go.get_future().share();
  WorkerPool pool{"test", 4, 1000};
  WorkerPool::Strand strand{pool};

  std::vector<std::thread> posters;
  for (int poster = 0; poster < 4; ++poster) {
    posters.emplace_back([&, poster] {
      started.wait();
      for (int n = 0; n < 250; ++n) {
        const bool taken = strand.post([&, poster, n] {
          if (++inFlight > 1) overlapped = true;
          std::this_thread::yield();
          {
            std::lock_guard lock{recording};
            ranPerPoster[poster].push_back(n);
          }
          --inFlight;
          if (++finished == 1000) everyJob.set_value();
        });
        if (taken) ++accepted;
      }
    });
  }
  go.set_value();
  for (std::thread& poster : posters) poster.join();
  allRan.wait();

  std::vector<int> inPostOrder(250);
  std::iota(inPostOrder.begin(), inPostOrder.end(), 0);
  CHECK_EQ(accepted.load(), 1000);
  CHECK_FALSE(overlapped.load());
  CHECK(ranPerPoster == (std::vector<std::vector<int>>(4, inPostOrder)));
}

TEST(strand_destroyed_with_jobs_queued_still_runs_them_in_order) {
  std::promise<void> busy;
  std::future<void> started = busy.get_future();
  std::vector<int> ran;
  std::promise<void> lastJob;
  std::future<void> allRan = lastJob.get_future();
  WorkerPool pool{"test", 1, 8};
  // Declared after the pool: a case cut short breaks it, so the blocked worker still wakes and joins.
  std::promise<void> release;

  CHECK(pool.post([&busy, released = release.get_future().share()] { busy.set_value(); released.wait(); }));
  started.wait();
  {
    WorkerPool::Strand strand{pool};
    for (int n = 0; n < 3; ++n) {
      CHECK(strand.post([&ran, &lastJob, n] {
        ran.push_back(n);
        if (n == 2) lastJob.set_value();
      }));
    }
  }
  release.set_value();
  allRan.wait();
  CHECK_EQ(ran, (std::vector<int>{0, 1, 2}));
}

TEST(strand_refused_by_a_full_pool_drops_the_job_and_takes_the_next_once_there_is_room) {
  std::promise<void> busy;
  std::future<void> started = busy.get_future();
  std::vector<std::string> ran;
  std::promise<void> fillerDone;
  std::future<void> fillerRan = fillerDone.get_future();
  std::promise<void> takenDone;
  std::future<void> takenRan = takenDone.get_future();
  WorkerPool pool{"test", 1, 1};
  // Declared after the pool: a case cut short breaks it, so the blocked worker still wakes and joins.
  std::promise<void> release;

  CHECK(pool.post([&busy, released = release.get_future().share()] { busy.set_value(); released.wait(); }));
  started.wait();
  CHECK(pool.post([&ran, &fillerDone] {
    ran.push_back("filler");
    fillerDone.set_value();
  }));
  WorkerPool::Strand strand{pool};
  CHECK_FALSE(strand.post([&ran] { ran.push_back("refused"); }));

  release.set_value();
  fillerRan.wait();
  CHECK(strand.post([&ran, &takenDone] {
    ran.push_back("taken");
    takenDone.set_value();
  }));
  takenRan.wait();
  CHECK_EQ(ran, (std::vector<std::string>{"filler", "taken"}));
}

TEST(strand_keeps_draining_on_its_worker_when_the_pool_refuses_its_next_turn) {
  std::mutex recording;
  std::vector<std::string> ran;
  std::promise<void> otherBusy;
  std::future<void> otherStarted = otherBusy.get_future();
  std::promise<void> strandBusy;
  std::future<void> strandStarted = strandBusy.get_future();
  std::promise<void> strandDone;
  std::future<void> strandRan = strandDone.get_future();
  std::promise<void> fillerDone;
  std::future<void> fillerRan = fillerDone.get_future();
  const auto record = [&recording, &ran](const std::string& job) {
    std::lock_guard lock{recording};
    ran.push_back(job);
  };
  WorkerPool pool{"test", 2, 1};
  WorkerPool::Strand strand{pool};
  // Declared after the pool: a case cut short breaks them, so the blocked workers still wake and join.
  std::promise<void> releaseOther;
  std::promise<void> releaseStrand;

  CHECK(pool.post([&otherBusy, released = releaseOther.get_future().share()] {
    otherBusy.set_value();
    released.wait();
  }));
  otherStarted.wait();
  CHECK(strand.post([&strandBusy, record, released = releaseStrand.get_future().share()] {
    strandBusy.set_value();
    released.wait();
    record("strand 0");
  }));
  strandStarted.wait();
  CHECK(strand.post([record] { record("strand 1"); }));
  CHECK(strand.post([record, &strandDone] {
    record("strand 2");
    strandDone.set_value();
  }));
  CHECK(pool.post([record, &fillerDone] {
    record("filler");
    fillerDone.set_value();
  }));
  CHECK_EQ(pool.queued(), std::size_t{1});

  releaseStrand.set_value();
  strandRan.wait();
  fillerRan.wait();
  releaseOther.set_value();

  std::lock_guard lock{recording};
  CHECK_EQ(ran, (std::vector<std::string>{"strand 0", "strand 1", "strand 2", "filler"}));
}

TEST(strand_job_releases_what_it_holds_before_the_next_job_starts) {
  std::mutex recording;
  std::vector<std::string> ran;
  std::promise<void> secondDone;
  std::future<void> secondRan = secondDone.get_future();
  const auto record = [&recording, &ran](const std::string& event) {
    std::lock_guard lock{recording};
    ran.push_back(event);
  };
  std::shared_ptr<void> lease(nullptr, [record](void*) {
    for (int i = 0; i < 100; ++i) std::this_thread::yield();
    record("lease returned");
  });
  WorkerPool pool{"test", 2, 8};
  WorkerPool::Strand strand{pool};

  CHECK(strand.post([record, lease = std::move(lease)] { record("first"); }));
  CHECK(strand.post([record, &secondDone] {
    record("second");
    secondDone.set_value();
  }));
  secondRan.wait();

  std::lock_guard lock{recording};
  CHECK_EQ(ran, (std::vector<std::string>{"first", "lease returned", "second"}));
}

TEST(heartbeat_pass_runs_on_a_blocking_thread) {
  std::promise<bool> seen;
  std::future<bool> blocking = seen.get_future();
  Heartbeat heartbeat{"test"};

  heartbeat.start(0, 3600, [&seen] { seen.set_value(BlockingThread::here()); });

  CHECK(blocking.get());
}

TEST(background_queue_reports_once_keeps_private_exception_out_and_continues) {
  struct Reporter : FailureReporter {
    std::vector<std::string> operations;
    std::vector<std::string> requestIds;
    std::vector<std::string> types;
    void report(const std::string&, const std::string&, const std::string&) override {}
    void reportWrite(const std::string& operation, const std::string& product,
                     const std::string& door, const std::string& outcome,
                     const std::string& requestId, const std::string& type) override {
      CHECK_EQ(product, std::string("platform"));
      CHECK_EQ(door, std::string("background"));
      CHECK_EQ(outcome, std::string("failed"));
      operations.push_back(operation);
      requestIds.push_back(requestId);
      types.push_back(type);
    }
  };
  auto reporter = std::make_shared<Reporter>();
  installWriteReporter(reporter);
  std::vector<WriteCompletion> completions;
  installWriteSink([&](const WriteCompletion& completion) { completions.push_back(completion); });
  std::promise<void> continued;
  auto future = continued.get_future();
  {
    Heartbeat heartbeat{"privacy-test"};
    heartbeat.queue([] { throw std::runtime_error("PRIVATE_BACKGROUND_CONTENT token email@example.com"); });
    heartbeat.queue([&] { markCurrentWrite(); continued.set_value(); });
    future.get();
  }
  installWriteSink({});
  installWriteReporter({});

  REQUIRE_EQ(completions.size(), 2u);
  CHECK_EQ(completions[0].operation, std::string("background.privacy-test"));
  CHECK_EQ(completions[0].outcome, std::string("failed"));
  CHECK_EQ(completions[1].outcome, std::string("ok"));
  REQUIRE_EQ(reporter->operations.size(), 1u);
  CHECK_EQ(reporter->operations[0], completions[0].operation);
  CHECK_EQ(reporter->requestIds[0], completions[0].requestId);
  CHECK_EQ(reporter->types[0], std::string(typeid(std::runtime_error).name()));
  CHECK(reporter->types[0].find("PRIVATE_BACKGROUND_CONTENT") == std::string::npos);
  CHECK(completions[0].durationMs >= 0);
}

TEST(heartbeat_idle_tick_and_queued_read_complete_without_write_logs) {
  std::vector<WriteCompletion> completions;
  installWriteSink([&](const WriteCompletion& completion) { completions.push_back(completion); });
  std::promise<void> tick;
  auto ticked = tick.get_future();
  {
    Heartbeat heartbeat{"ws-readers"};
    heartbeat.start(0, 3600, [&] { tick.set_value(); });
    ticked.get();
    heartbeat.queue([] {});
    heartbeat.stop();
    heartbeat.stop();
    heartbeat.queue([] { markCurrentWrite(); });
  }
  installWriteSink({});
  CHECK(completions.empty());
}

TEST(heartbeat_drains_queued_mutations_before_explicit_shutdown) {
  std::vector<WriteCompletion> completions;
  installWriteSink([&](const WriteCompletion& completion) { completions.push_back(completion); });
  {
    Heartbeat heartbeat{"journal-echo-live", "journal"};
    heartbeat.queue([] { markCurrentWrite(); });
    heartbeat.queue([] {});
    heartbeat.stop();
    heartbeat.stop();
  }
  installWriteSink({});
  REQUIRE_EQ(completions.size(), 1u);
  CHECK_EQ(completions[0].operation, std::string("background.journal-echo-live"));
  CHECK_EQ(completions[0].product, std::string("journal"));
  CHECK_EQ(completions[0].outcome, std::string("ok"));
}

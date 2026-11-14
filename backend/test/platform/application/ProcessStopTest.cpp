#include "platform/application/ProcessStop.h"
#include "test/testing.h"

#include <atomic>
#include <chrono>
#include <thread>

using namespace wm;

namespace {
// Whether `flag` is set within `within`.
bool setWithin(const std::atomic<bool>& flag, std::chrono::milliseconds within) {
  const auto until = std::chrono::steady_clock::now() + within;
  while (!flag.load() && std::chrono::steady_clock::now() < until) std::this_thread::sleep_for(std::chrono::milliseconds(2));
  return flag.load();
}
}

// Told of the signal, the stop closes the doors at once and gives up only when the budget, counted from the signal,
// passes with the stop unfinished.
TEST(process_stop_closes_the_doors_at_the_signal_and_gives_up_when_the_budget_passes_unfinished) {
  std::atomic<bool> doorsClosed{false};
  std::atomic<bool> gaveUp{false};
  std::chrono::steady_clock::time_point gaveUpAt;
  ProcessStop stop{std::chrono::milliseconds(300), {[&] { doorsClosed = true; }, [&] {
    gaveUpAt = std::chrono::steady_clock::now();
    gaveUp = true;
  }}};
  CHECK_FALSE(stop.stopping()->load());
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  CHECK_FALSE(doorsClosed.load());

  const auto signalledAt = std::chrono::steady_clock::now();
  stop.signalled();
  CHECK(stop.stopping()->load());
  CHECK(setWithin(doorsClosed, std::chrono::milliseconds(200)));
  CHECK_FALSE(gaveUp.load());

  CHECK(setWithin(gaveUp, std::chrono::seconds(5)));
  CHECK(gaveUpAt - signalledAt >= std::chrono::milliseconds(300));
  CHECK(gaveUpAt - signalledAt < std::chrono::milliseconds(1300));
}

// A stop that finishes inside the budget never gives up, and one that was never signalled closes nothing.
TEST(process_stop_that_finishes_inside_its_budget_never_gives_up) {
  std::atomic<int> doorsClosed{0};
  std::atomic<bool> gaveUp{false};
  {
    ProcessStop stop{std::chrono::milliseconds(200), {[&] { ++doorsClosed; }, [&] { gaveUp = true; }}};
    stop.signalled();
    stop.signalled();  // a second signal is the same stop
    const auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(150);
    while (doorsClosed.load() == 0 && std::chrono::steady_clock::now() < until) std::this_thread::sleep_for(std::chrono::milliseconds(2));
    stop.finished();
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
  }
  CHECK_EQ(doorsClosed.load(), 1);
  CHECK_FALSE(gaveUp.load());

  std::atomic<bool> unsignalledDoors{false};
  { ProcessStop quiet{std::chrono::milliseconds(50), {[&] { unsignalledDoors = true; }, [&] { gaveUp = true; }}}; }
  CHECK_FALSE(unsignalledDoors.load());
  CHECK_FALSE(gaveUp.load());
}

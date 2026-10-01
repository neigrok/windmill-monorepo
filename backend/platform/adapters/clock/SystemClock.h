#pragma once

#include "platform/ports/Clock.h"

#include <chrono>
#ifdef WM_TEST_CLOCK
#include <cstdlib>
#include <fstream>
#include <stdexcept>
#endif

namespace wm {

// Production always uses wall time. Only the separately built test server reads the harness clock.
struct SystemClock : Clock {
  std::uint64_t nowMs() override {
#ifdef WM_TEST_CLOCK
    if (const char* path = std::getenv("WM_TEST_CLOCK_FILE")) {
      std::ifstream input(path);
      std::uint64_t now = 0;
      if (!(input >> now) || now == 0) throw std::runtime_error("invalid test clock file");
      return now;
    }
#endif
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
  }
};

}

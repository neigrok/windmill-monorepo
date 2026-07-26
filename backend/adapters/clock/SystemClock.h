#pragma once

#include "ports/Clock.h"

#include <chrono>

namespace wm {

// The production Clock: the machine's wall clock in epoch milliseconds. Tests inject a
// fake instead, so this stays trivial and header-only.
struct SystemClock : Clock {
  std::uint64_t nowMs() override {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
  }
};

}

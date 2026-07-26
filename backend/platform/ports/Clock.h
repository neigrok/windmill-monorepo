#pragma once

#include <cstdint>

namespace wm {

// Wall-clock source, injected so tests can drive HLC generation deterministically.
struct Clock {
  virtual ~Clock() = default;
  virtual std::uint64_t nowMs() = 0;
};

}

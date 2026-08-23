#pragma once

#include <cstdint>

namespace wm {

struct Clock {
  virtual ~Clock() = default;
  virtual std::uint64_t nowMs() = 0;
};

}

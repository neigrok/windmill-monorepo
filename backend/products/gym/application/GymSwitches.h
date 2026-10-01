#pragma once

#include <cstdlib>
#include <stdexcept>
#include <string>
#include <string_view>

namespace wm::gym {

inline bool gymSwitch(const char* name) {
  const char* value = std::getenv(name);
  if (!value) return false;
  const std::string_view flag(value);
  return flag == "1" || flag == "true" || flag == "on";
}

inline bool gymEngineWrites() { return gymSwitch("GYM_ENGINE_WRITES"); }
inline bool gymWriteFrozen() { return gymSwitch("GYM_WRITE_FREEZE"); }

struct GymUnavailable : std::runtime_error {
  std::string code;
  explicit GymUnavailable(std::string code = "gym-frozen", std::string message = "gym writes are temporarily frozen")
      : std::runtime_error(std::move(message)), code(std::move(code)) {}
};

inline void requireGymWrite() {
  if (gymWriteFrozen()) throw GymUnavailable();
}

}

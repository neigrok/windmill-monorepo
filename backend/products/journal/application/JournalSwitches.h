#pragma once

#include <cstdlib>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>

namespace wm::journal {

inline bool journalSwitch(const char* name) {
  const char* value = std::getenv(name);
  if (!value) return false;
  const std::string_view flag(value);
  return flag == "1" || flag == "true" || flag == "on";
}

inline bool journalEngineWrites() { return journalSwitch("JOURNAL_ENGINE_WRITES"); }
inline bool journalWriteFrozen() { return journalSwitch("JOURNAL_WRITE_FREEZE"); }

struct JournalUnavailable : std::runtime_error {
  std::string code;
  explicit JournalUnavailable(std::string code = "journal-frozen",
      std::string message = "journal writes are temporarily frozen")
      : std::runtime_error(std::move(message)), code(std::move(code)) {}
};

inline void requireJournalWrite() {
  if (journalWriteFrozen()) throw JournalUnavailable();
}

}

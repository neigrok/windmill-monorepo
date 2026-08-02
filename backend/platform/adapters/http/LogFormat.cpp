#include "platform/adapters/http/LogFormat.h"

namespace wm {

Severity severityForStatus(int status) {
  if (status >= 500) return Severity::error;
  if (status >= 400) return Severity::warn;
  return Severity::info;
}

std::string tookMs(long long micros) {
  if (micros < 0) return "?";
  return std::to_string(micros / 1000) + "." + std::to_string((micros % 1000) / 100);
}

}

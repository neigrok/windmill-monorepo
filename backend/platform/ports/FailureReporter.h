#pragma once

#include <string>

namespace wm {

// Handled failures a user can see. `where` names the operation ("compose.stream"), `detail`
// carries diagnostics — never user content.
struct FailureReporter {
  virtual ~FailureReporter() = default;
  virtual void report(const std::string& kind, const std::string& where, const std::string& detail) = 0;
};

}

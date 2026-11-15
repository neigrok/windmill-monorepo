#pragma once

#include <map>
#include <string>

namespace wm {

// Handled failures a user can see. `where` names the operation ("compose.stream"), `detail`
// carries diagnostics — never user content.
struct FailureReporter {
  virtual ~FailureReporter() = default;
  virtual void report(const std::string& kind, const std::string& where, const std::string& detail) = 0;
  virtual void reportWrite(const std::string& operation, const std::string& product,
                           const std::string& door, const std::string& outcome,
                           const std::string& requestId, const std::string& exceptionType) {
    report(product, operation, "door=" + door + " outcome=" + outcome + " request_id=" +
           requestId + " exception_type=" + exceptionType);
  }
  // An expected event someone should see as it happens, never a failure: a level-warning event, which never stands in
  // for the one failure a write's request reports. `tags` are bounded labels.
  virtual void reportWarning(const std::string& /*operation*/, const std::string& /*product*/,
                             const std::string& /*door*/, const std::string& /*outcome*/,
                             const std::string& /*requestId*/, const std::map<std::string, std::string>& /*tags*/) {}
  // A failure that threw nothing and that its bounded `tags` say more of, as a write a background pass leaves undone:
  // a level-error event, grouped by operation and outcome.
  virtual void reportFailure(const std::string& operation, const std::string& product, const std::string& door,
                             const std::string& outcome, const std::string& requestId,
                             const std::map<std::string, std::string>& /*tags*/) {
    reportWrite(operation, product, door, outcome, requestId, "");
  }
};

}

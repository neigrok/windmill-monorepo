#pragma once

#include <string>

namespace wm {

// Every failure a user can SEE, whether or not it threw.
//
// Uncaught exceptions reach the error tracker through drogon's handler. This is the other, larger
// half: the upstream that errored, the reply that came back unreadable, the deadline that passed.
// This codebase handles those gracefully by design — a failed compose leaves the pasted text alone
// rather than crashing the request — and the cost of that discipline is that a feature can be
// broken for every user while nothing anywhere goes red. Handled must not mean invisible.
//
// `where` names the operation ("compose.stream"), `detail` carries diagnostic metadata: a stop
// reason, a byte count, an upstream error code. USER CONTENT NEVER GOES THROUGH HERE. What someone
// pasted is theirs, and an error tracker is not a place to keep it.
struct FailureReporter {
  virtual ~FailureReporter() = default;
  virtual void report(const std::string& kind, const std::string& where, const std::string& detail) = 0;
};

}

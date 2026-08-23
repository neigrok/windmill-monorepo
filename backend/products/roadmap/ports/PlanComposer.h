#pragma once

#include <functional>
#include <optional>
#include <string>

namespace wm {

// Pasted prose in, a markdown plan in the paste grammar out; the client re-parses that plan with the
// same parser as a hand-typed paste. configured() is false when no upstream is wired. compose is
// asynchronous: done gets the plan, or nullopt on upstream error or timeout, and may fire on a
// different thread than the caller's. composeStream: onDelta once per verbatim model text delta, then
// onDone exactly once — true only after a clean end_turn finish, false on upstream error, deadline or
// truncation even when deltas already flowed. Both may fire on the composer's own loop thread. The
// returned cancel functor is callable any number of times from any thread; after cancel onDone fires
// at most once and never with true.
struct PlanComposer {
  virtual ~PlanComposer() = default;
  virtual bool configured() const = 0;
  virtual void compose(const std::string& text,
                       std::function<void(std::optional<std::string>)> done) = 0;
  virtual std::function<void()> composeStream(const std::string& text,
                                              std::function<void(const std::string&)> onDelta,
                                              std::function<void(bool)> onDone) = 0;
};

}

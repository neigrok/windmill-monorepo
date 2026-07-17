#pragma once

#include <functional>
#include <optional>
#include <string>

namespace wm {

// The LLM escalation behind paste-import (F3): arbitrary pasted prose in, a markdown plan
// in the deterministic paste grammar out. The composer only ever produces text — the client
// re-parses the plan with the same parser as a hand-typed paste, so the model is never the
// door into the tree. configured() is false when no upstream is wired (no API key); the
// HTTP edge turns that into 503 so the client can hide the handle. compose is asynchronous
// so the minutes-scale upstream call never parks a server thread: done gets the plan, or
// nullopt on upstream error or timeout (the edge turns that into 502 and the client leaves
// the pasted text untouched), and may fire on a different thread than the caller's.
struct PlanComposer {
  virtual ~PlanComposer() = default;
  virtual bool configured() const = 0;
  virtual void compose(const std::string& text,
                       std::function<void(std::optional<std::string>)> done) = 0;
};

}

#pragma once

#include "ports/PlanComposer.h"

#include <trantor/net/EventLoopThread.h>

#include <functional>
#include <optional>
#include <string>

namespace wm {

// The seam defended: the prompt forbids code fences, but a model that wraps its reply in
// them anyway must not leak them into the plan the client re-parses — strip a leading
// ``` / ```markdown line and a trailing ``` line, trim the edges, and touch nothing else.
std::string strippedPlan(const std::string& reply);

// Composes plans through Anthropic's Messages API: the raw paste rides as the user turn
// under a system prompt that pins the F3 paste grammar, temperature 0 so the same paste
// composes the same plan. Owns a private event-loop thread that carries the outbound
// HTTPS call, so the server's request loops are never parked waiting on the model —
// done fires from that thread once the reply (or the 20s timeout) lands.
class AnthropicComposer : public PlanComposer {
public:
  explicit AnthropicComposer(std::string apiKey);

  bool configured() const override;
  void compose(const std::string& text,
               std::function<void(std::optional<std::string>)> done) override;

private:
  std::string apiKey_;
  trantor::EventLoopThread loop_;
};

}

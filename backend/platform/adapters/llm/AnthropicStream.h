#pragma once

#include "platform/adapters/llm/AnthropicClient.h"

#include <json/json.h>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace wm {

class AnthropicMessageStream {
public:
  explicit AnthropicMessageStream(std::function<void(const std::string&)> text = {});
  bool feed(std::string_view bytes);
  // The message so far. One that never finished counts as its output the larger of the vendor's own count, when one
  // arrived, and what streamed: a token per three UTF-8 bytes the model wrote — text, thinking, a tool's name and
  // input — rounded up, and three a content block, as the request estimate counts input.
  std::optional<Json::Value> finish(const std::string& interruption = "transport_error");
  bool complete() const { return complete_; }
  Json::Value diagnostic(int httpStatus, int curlCode, bool cancelled = false, bool callbackFailed = false) const;

private:
  bool event(const std::string& data);
  std::function<void(const std::string&)> text_;
  Json::Value message_;
  std::vector<std::string> arguments_;
  std::vector<bool> blockClosed_;
  std::string buffer_;
  std::string data_;
  std::string prefix_;
  std::size_t written_ = 0;
  const char* failure_ = "none";
  const char* providerError_ = "none";
  std::size_t bytes_ = 0;
  bool complete_ = false;
  bool finalUsage_ = false;
  bool invalid_ = false;
};

// The round's reply, or none; `unconsumed` when the vendor answered an error status before the
// message started, so nothing was billed; `cancelled` when `continueRun` stopped it.
ModelRound streamAnthropicMessage(
    const std::string& apiKey, const std::string& baseUrl, const Json::Value& request,
    const std::function<void(const std::string&)>& text,
    const std::function<bool()>& continueRun,
    const std::function<void(const Json::Value&)>& diagnostic = {});

}

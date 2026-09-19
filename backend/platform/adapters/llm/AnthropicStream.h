#pragma once

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
  std::optional<Json::Value> finish(const std::string& interruption = "transport_error");
  bool complete() const { return complete_; }

private:
  bool event(const std::string& data);
  std::function<void(const std::string&)> text_;
  Json::Value message_;
  std::vector<std::string> arguments_;
  std::vector<bool> blockClosed_;
  std::string buffer_;
  std::string data_;
  std::size_t bytes_ = 0;
  bool complete_ = false;
  bool invalid_ = false;
};

std::optional<Json::Value> streamAnthropicMessage(
    const std::string& apiKey, const std::string& baseUrl, const Json::Value& request,
    const std::function<void(const std::string&)>& text,
    const std::function<bool()>& continueRun);

}

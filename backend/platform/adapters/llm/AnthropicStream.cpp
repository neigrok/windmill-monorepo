#include "platform/adapters/llm/AnthropicStream.h"

#include "platform/adapters/http/VendorCall.h"
#include "platform/adapters/llm/AnthropicClient.h"
#include "platform/adapters/json/JsonText.h"

#include <curl/curl.h>
#include <exception>
#include <algorithm>
#include <memory>
#include <stdexcept>
#include <trantor/utils/Logger.h>

namespace wm {

namespace {
const char* knownProviderError(const Json::Value& error) {
  if (!error.isObject() || !error["type"].isString()) return "unknown";
  for (const char* type : {"invalid_request_error", "authentication_error", "billing_error", "permission_error",
                           "not_found_error", "conflict_error", "request_too_large", "rate_limit_error",
                           "api_error", "timeout_error", "overloaded_error"})
    if (error["type"].asString() == type) return type;
  return "unknown";
}
}

AnthropicMessageStream::AnthropicMessageStream(std::function<void(const std::string&)> text)
    : text_(std::move(text)) {}

bool AnthropicMessageStream::feed(std::string_view bytes) {
  if (invalid_) return false;
  bytes_ += bytes.size();
  if (bytes_ > 4 * 1024 * 1024) { failure_ = "body_limit"; invalid_ = true; return false; }
  if (buffer_.size() + bytes.size() > 256 * 1024) { failure_ = "event_limit"; invalid_ = true; return false; }
  if (complete_) return true;
  if (!message_.isObject() && prefix_.size() < 16 * 1024)
    prefix_.append(bytes.substr(0, 16 * 1024 - prefix_.size()));
  buffer_.append(bytes);
  std::size_t end;
  while ((end = buffer_.find('\n')) != std::string::npos) {
    std::string line = buffer_.substr(0, end);
    buffer_.erase(0, end + 1);
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty()) {
      if (!data_.empty() && !event(data_)) {
        if (std::string_view(failure_) == "none") failure_ = "invalid_event";
        invalid_ = true;
        return false;
      }
      data_.clear();
    } else if (line.rfind("data:", 0) == 0) {
      if (!data_.empty()) data_ += '\n';
      data_ += line.substr(line.size() > 5 && line[5] == ' ' ? 6 : 5);
      if (data_.size() > 256 * 1024) { failure_ = "event_limit"; invalid_ = true; return false; }
    }
  }
  return true;
}

bool AnthropicMessageStream::event(const std::string& data) {
  Json::CharReaderBuilder builder;
  std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  Json::Value event;
  std::string errors;
  if (!reader->parse(data.data(), data.data() + data.size(), &event, &errors)) { failure_ = "invalid_json"; return false; }
  if (!event.isObject()) return false;
  if (!event["type"].isString()) return false;
  const std::string type = event["type"].asString();
  if (type == "ping") return true;
  if (type == "error") {
    failure_ = "provider_error";
    providerError_ = knownProviderError(event["error"]);
    return false;
  }
  if (type == "message_start") {
    if (message_.isObject() || !event["message"].isObject()) return false;
    if (!event["message"]["usage"].isNull() && !event["message"]["usage"].isObject()) return false;
    message_ = event["message"];
    message_["content"] = Json::Value(Json::arrayValue);
    prefix_.clear();
    return true;
  }
  if (type != "message_delta" && type != "message_stop" && type != "content_block_start"
      && type != "content_block_delta" && type != "content_block_stop") return true;
  if (!message_.isObject()) return false;
  if (type == "message_delta") {
    if (!event["delta"].isObject()) return false;
    if (event["delta"]["stop_reason"].isString()) message_["stop_reason"] = event["delta"]["stop_reason"];
    if (!event["usage"].isNull() && !event["usage"].isObject()) return false;
    for (const auto& key : event["usage"].getMemberNames()) message_["usage"][key] = event["usage"][key];
    return true;
  }
  if (type == "message_stop") {
    complete_ = message_["stop_reason"].isString() && std::all_of(blockClosed_.begin(), blockClosed_.end(), [](bool closed) { return closed; });
    return complete_;
  }
  if (!event["index"].isUInt() || event["index"].asUInt() >= 256) return false;
  const auto index = event["index"].asUInt();
  if (type == "content_block_start") {
    if (index != message_["content"].size() || !event["content_block"].isObject() || !event["content_block"]["type"].isString()) return false;
    const auto& block = event["content_block"];
    for (const auto& field : {"text", "thinking", "signature"})
      if (block.isMember(field) && !block[field].isString()) return false;
    message_["content"].append(block);
    arguments_.emplace_back();
    blockClosed_.push_back(false);
    return true;
  }
  if (index >= message_["content"].size() || blockClosed_[index]) return false;
  Json::Value& block = message_["content"][index];
  if (type == "content_block_stop") {
    blockClosed_[index] = true;
    if (!arguments_[index].empty()) {
      Json::Value input;
      if (!reader->parse(arguments_[index].data(), arguments_[index].data() + arguments_[index].size(), &input, &errors) || !input.isObject()) return false;
      block["input"] = input;
    }
    return true;
  }
  const auto& delta = event["delta"];
  if (!delta.isObject() || !delta["type"].isString()) return false;
  const auto deltaType = delta["type"].asString();
  if (deltaType == "input_json_delta") {
    if (block["type"].asString() != "tool_use" || !delta["partial_json"].isString()) return false;
    arguments_[index] += delta["partial_json"].asString();
  }
  if (deltaType == "thinking_delta" && delta["thinking"].isString()) block["thinking"] = block.get("thinking", "").asString() + delta["thinking"].asString();
  if (deltaType == "signature_delta" && delta["signature"].isString()) block["signature"] = block.get("signature", "").asString() + delta["signature"].asString();
  if (deltaType == "text_delta") {
    if (block["type"].asString() != "text" || !delta["text"].isString()) return false;
    block["text"] = block.get("text", "").asString() + delta["text"].asString();
    std::string visible;
    for (const auto& part : message_["content"])
      if (part.get("type", "").asString() == "text") {
        if (!visible.empty()) visible += "\n";
        visible += part.get("text", "").asString();
      }
    if (text_) text_(visible);
  }
  return true;
}

std::optional<Json::Value> AnthropicMessageStream::finish(const std::string& interruption) {
  if (!message_.isObject()) return std::nullopt;
  if (!complete_ || invalid_) message_["stop_reason"] = interruption;
  return message_;
}

Json::Value AnthropicMessageStream::diagnostic(int httpStatus, int curlCode, bool cancelled, bool callbackFailed) const {
  Json::Value result(Json::objectValue);
  result["httpStatus"] = httpStatus;
  result["curlCode"] = curlCode;
  result["messageStarted"] = message_.isObject();
  result["messageComplete"] = complete_;
  result["cancelled"] = cancelled;
  result["callbackFailed"] = callbackFailed;
  result["parserFailure"] = std::string_view(failure_) != "none" ? failure_
      : complete_ ? "none" : message_.isObject() ? "missing_message_stop" : "missing_message_start";
  result["providerError"] = providerError_;
  if ((httpStatus < 200 || httpStatus >= 300) && std::string_view(providerError_) == "none") {
    const auto error = parse(prefix_);
    if (error.isObject() && error["type"].isString() && error["type"].asString() == "error")
      result["providerError"] = knownProviderError(error["error"]);
  }
  return result;
}

std::optional<Json::Value> streamAnthropicMessage(
    const std::string& apiKey, const std::string& baseUrl, const Json::Value& request,
    const std::function<void(const std::string&)>& text,
    const std::function<bool()>& continueRun,
    const std::function<void(const Json::Value&)>& diagnostic) {
  static const int initialized = curl_global_init(CURL_GLOBAL_DEFAULT);
  if (initialized != CURLE_OK) throw std::runtime_error("HTTP transport unavailable");
  if (baseUrl.rfind("https://", 0) != 0 && baseUrl.rfind("http://127.0.0.1:", 0) != 0 && baseUrl.rfind("http://localhost:", 0) != 0)
    throw std::invalid_argument("Anthropic endpoint requires HTTPS or a loopback fixture");
  struct Transfer {
    AnthropicMessageStream parser;
    const std::function<bool()>& continueRun;
    std::exception_ptr failure;
    bool stopped = false;
  } transfer{AnthropicMessageStream{text}, continueRun};
  const auto client = std::unique_ptr<CURL, decltype(&curl_easy_cleanup)>(curl_easy_init(), curl_easy_cleanup);
  if (!client) throw std::runtime_error("HTTP transport unavailable");
  Json::Value body = request;
  body["stream"] = true;
  const std::string payload = dump(body);
  const std::string url = baseUrl + "/v1/messages";
  curl_slist* rawHeaders = nullptr;
  for (const auto& header : {"x-api-key: " + apiKey, std::string("anthropic-version: ") + kAnthropicApiVersion,
                              std::string("content-type: application/json"), std::string("accept: text/event-stream")})
    rawHeaders = curl_slist_append(rawHeaders, header.c_str());
  const auto headers = std::unique_ptr<curl_slist, decltype(&curl_slist_free_all)>(rawHeaders, curl_slist_free_all);
  curl_easy_setopt(client.get(), CURLOPT_URL, url.c_str());
  curl_easy_setopt(client.get(), CURLOPT_HTTPHEADER, headers.get());
  curl_easy_setopt(client.get(), CURLOPT_POSTFIELDS, payload.data());
  curl_easy_setopt(client.get(), CURLOPT_POSTFIELDSIZE_LARGE, static_cast<curl_off_t>(payload.size()));
  curl_easy_setopt(client.get(), CURLOPT_TIMEOUT, 90L);
  curl_easy_setopt(client.get(), CURLOPT_CONNECTTIMEOUT, 15L);
  curl_easy_setopt(client.get(), CURLOPT_NOSIGNAL, 1L);
  curl_easy_setopt(client.get(), CURLOPT_WRITEFUNCTION, +[](char* data, std::size_t size, std::size_t count, void* context) -> std::size_t {
    auto& transfer = *static_cast<Transfer*>(context);
    try { return transfer.parser.feed(std::string_view(data, size * count)) ? size * count : 0; }
    catch (...) { transfer.failure = std::current_exception(); return 0; }
  });
  curl_easy_setopt(client.get(), CURLOPT_WRITEDATA, &transfer);
  curl_easy_setopt(client.get(), CURLOPT_NOPROGRESS, 0L);
  curl_easy_setopt(client.get(), CURLOPT_XFERINFOFUNCTION, +[](void* context, curl_off_t, curl_off_t, curl_off_t, curl_off_t) -> int {
    auto& transfer = *static_cast<Transfer*>(context);
    try {
      transfer.stopped = transfer.continueRun && !transfer.continueRun();
      return transfer.stopped ? 1 : 0;
    } catch (...) { transfer.failure = std::current_exception(); return 1; }
  });
  curl_easy_setopt(client.get(), CURLOPT_XFERINFODATA, &transfer);
  VendorCall vendor("anthropic", "messages.stream");
  const auto result = curl_easy_perform(client.get());
  long status = 0;
  curl_easy_getinfo(client.get(), CURLINFO_RESPONSE_CODE, &status);
  if (result != CURLE_OK && !transfer.stopped) vendor.lost(result == CURLE_OPERATION_TIMEDOUT ? VendorFault::timeout : VendorFault::network);
  else vendor.answered(static_cast<int>(status));
  const auto details = transfer.parser.diagnostic(static_cast<int>(status), static_cast<int>(result),
                                                  transfer.stopped, static_cast<bool>(transfer.failure));
  LOG_INFO << "anthropic_stream_diagnostic=" << dump(details);
  if (diagnostic) diagnostic(details);
  if (transfer.failure) std::rethrow_exception(transfer.failure);
  auto message = transfer.parser.finish(transfer.stopped ? "cancelled" : "transport_error");
  if (message && (result != CURLE_OK || status < 200 || status >= 300))
    (*message)["stop_reason"] = transfer.stopped ? "cancelled" : "transport_error";
  return message;
}

}

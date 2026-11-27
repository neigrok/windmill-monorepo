#include "platform/ai_service/AiServiceClient.h"

#include "platform/adapters/json/JsonText.h"
#include "platform/application/WriteObservation.h"

#include <curl/curl.h>
#include <drogon/utils/Utilities.h>
#include <openssl/rand.h>
#include <trantor/utils/Logger.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string_view>
#include <utility>

namespace wm {

namespace {

using SteadyTime = std::chrono::steady_clock::time_point;

// No answer the door gives holds more: an answer of 16,000 output tokens comes to well under 1 MiB, written twice.
constexpr std::size_t kAnswerBytes = 4 * 1024 * 1024;
constexpr std::size_t kRefusalBytes = 64 * 1024;

const TextAnswer kUnreadable{"unreadable", ""};

// A code as the service words one, or `unreadable`: what reaches a log line is a bounded word, whatever came back.
std::string codeIn(const Json::Value& value) {
  if (!value.isString()) return kUnreadable.code;
  const std::string code = value.asString();
  const bool word = !code.empty() && code.size() <= 64 && code.front() >= 'a' && code.front() <= 'z' &&
      std::all_of(code.begin(), code.end(), [](char c) { return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_'; });
  return word ? code : kUnreadable.code;
}

// 22 characters of base64url from 128 random bits: a callId no other call shares (§6.1).
std::string newCallId() {
  std::array<unsigned char, 16> bytes{};
  if (RAND_bytes(bytes.data(), static_cast<int>(bytes.size())) != 1) throw std::runtime_error("ai_call_id_unavailable");
  return drogon::utils::base64EncodeUnpadded(bytes.data(), bytes.size(), true);
}

// The question as the door's TextRequest (§6.2): the prompt as the one system string, the user text as one message.
std::string requestBody(const TextQuestion& question) {
  Json::Value part(Json::objectValue);
  part["text"] = question.user;
  Json::Value message(Json::objectValue);
  message["role"] = "user";
  message["parts"].append(part);

  Json::Value body(Json::objectValue);
  body["model"] = question.model;
  body["system"].append(question.system);
  body["messages"].append(message);
  body["output"]["maxTokens"] = question.maxTokens;
  body["output"]["schema"] = question.schema;
  body["effort"] = question.effort;
  body["cache"] = question.cache;
  return dump(body);
}

// How an `ended` or `failed` event ends the call. A `completed` answer is the text of its message's parts.
TextAnswer endOf(const std::string& event, const std::string& data) {
  const std::optional<Json::Value> end = parseWhole(data);
  if (!end || !end->isObject()) return kUnreadable;
  if (event == "failed") return {codeIn((*end)["code"]), ""};
  const std::string stop = codeIn((*end)["stop"]);
  if (stop == "tool_calls" || stop == "truncated" || stop == "declined") return {stop, ""};
  if (stop != "completed" || !(*end)["message"].isObject() || !(*end)["message"]["parts"].isArray()) return kUnreadable;
  std::string text;
  for (const Json::Value& part : (*end)["message"]["parts"])
    if (part.isObject() && part["text"].isString()) text += part["text"].asString();
  return {"completed", text};
}

// A text answer's event stream (§6.2), read to its first `ended` or `failed`. The events before it, `id` lines and the
// comment lines the service sends as heartbeats say nothing the backend acts on, and are passed over.
class EventStream {
public:
  // False stops the read: the answer has ended, or grown past what any answer holds.
  bool feed(std::string_view bytes) {
    read_ += bytes.size();
    if (read_ > kAnswerBytes) answer_ = kUnreadable;
    if (answer_) return false;
    buffer_.append(bytes);
    for (std::size_t end = buffer_.find('\n'); end != std::string::npos && !answer_; end = buffer_.find('\n')) {
      std::string line = buffer_.substr(0, end);
      buffer_.erase(0, end + 1);
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (line.empty()) {
        if (event_ == "ended" || event_ == "failed") answer_ = endOf(event_, data_);
        event_.clear();
        data_.clear();
      } else if (line.starts_with("event:")) {
        event_ = valueOf(line, 6);
      } else if (line.starts_with("data:")) {
        if (!data_.empty()) data_ += '\n';
        data_ += valueOf(line, 5);
      }
    }
    return !answer_;
  }

  const std::optional<TextAnswer>& answer() const { return answer_; }

private:
  static std::string valueOf(const std::string& line, std::size_t field) {
    return line.substr(line.size() > field && line[field] == ' ' ? field + 1 : field);
  }

  std::string buffer_;
  std::string event_;
  std::string data_;
  std::size_t read_ = 0;
  std::optional<TextAnswer> answer_;
};

// One PUT of the call and what it came to: the call's end, in the service's words or as `unreadable`, or none when the
// stream broke before its end or nothing connected, which the caller may ask again.
std::optional<TextAnswer> put(const std::string& url, const std::string& pass, const std::string& body,
                              SteadyTime deadline) {
  const auto left = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now());
  if (left.count() <= 0) return std::nullopt;
  const auto handle = std::unique_ptr<CURL, decltype(&curl_easy_cleanup)>(curl_easy_init(), curl_easy_cleanup);
  if (!handle) throw std::runtime_error("HTTP transport unavailable");

  struct Transfer {
    CURL* handle;
    EventStream stream;
    std::string refusal;
  } transfer{handle.get(), {}, {}};

  curl_slist* lines = nullptr;
  for (const std::string& line : {"Authorization: Bearer " + pass, std::string("Content-Type: application/json"),
                                  std::string("Accept: text/event-stream"), std::string("Expect:")})
    lines = curl_slist_append(lines, line.c_str());
  const auto headers = std::unique_ptr<curl_slist, decltype(&curl_slist_free_all)>(lines, curl_slist_free_all);
  curl_easy_setopt(handle.get(), CURLOPT_URL, url.c_str());
  curl_easy_setopt(handle.get(), CURLOPT_CUSTOMREQUEST, "PUT");
  curl_easy_setopt(handle.get(), CURLOPT_HTTPHEADER, headers.get());
  curl_easy_setopt(handle.get(), CURLOPT_POSTFIELDS, body.data());
  curl_easy_setopt(handle.get(), CURLOPT_POSTFIELDSIZE_LARGE, static_cast<curl_off_t>(body.size()));
  curl_easy_setopt(handle.get(), CURLOPT_CONNECTTIMEOUT, AiServiceClient::kConnectSeconds);
  curl_easy_setopt(handle.get(), CURLOPT_TIMEOUT_MS, static_cast<long>(left.count()));
  curl_easy_setopt(handle.get(), CURLOPT_LOW_SPEED_LIMIT, 1L);
  curl_easy_setopt(handle.get(), CURLOPT_LOW_SPEED_TIME, AiServiceClient::kSilentSeconds);
  curl_easy_setopt(handle.get(), CURLOPT_NOSIGNAL, 1L);
  curl_easy_setopt(handle.get(), CURLOPT_WRITEDATA, &transfer);
  curl_easy_setopt(handle.get(), CURLOPT_WRITEFUNCTION, +[](char* data, std::size_t size, std::size_t count, void* context) -> std::size_t {
    auto& transfer = *static_cast<Transfer*>(context);
    const std::string_view bytes(data, size * count);
    long status = 0;
    curl_easy_getinfo(transfer.handle, CURLINFO_RESPONSE_CODE, &status);
    if (status >= 200 && status < 300) return transfer.stream.feed(bytes) ? bytes.size() : 0;
    if (transfer.refusal.size() + bytes.size() > kRefusalBytes) return 0;
    transfer.refusal.append(bytes);
    return bytes.size();
  });
  const CURLcode result = curl_easy_perform(handle.get());
  long status = 0;
  curl_easy_getinfo(handle.get(), CURLINFO_RESPONSE_CODE, &status);

  // A stream is read to its end; one that stopped short of it broke.
  if (status >= 200 && status < 300) return transfer.stream.answer();
  if (status == 0) return std::nullopt;
  // A refusal before the stream is `{code, allowance}`, branched on by its code and never by its status (§6.3).
  const std::optional<Json::Value> refusal = parseWhole(transfer.refusal);
  if (refusal && refusal->isObject()) return TextAnswer{codeIn((*refusal)["code"]), ""};
  if (result != CURLE_OK) return std::nullopt;
  return kUnreadable;
}

}

AiServiceClient::AiServiceClient(std::string url, std::shared_ptr<const AiPasses> passes, Clock& clock,
                                 FailureReporter& reporter)
    : url_(std::move(url)), passes_(std::move(passes)), clock_(clock), unreachable_(reporter, "ai_service.unreachable") {
  if (!url_.starts_with("http://") && !url_.starts_with("https://")) throw std::invalid_argument("AI_SERVICE_URL must be http(s)");
  while (!url_.empty() && url_.back() == '/') url_.pop_back();
}

std::string AiServiceClient::keptPass(const UserId& account) {
  {
    std::lock_guard guard(lock_);
    const auto kept = kept_.find(account.str());
    if (kept != kept_.end() && clock_.nowMs() - kept->second.signedAtMs < kPassKeptMs) return kept->second.pass;
  }
  return signedPass(account);
}

std::string AiServiceClient::signedPass(const UserId& account) {
  const std::uint64_t now = clock_.nowMs();
  const std::string pass = passes_->serverPass(account, static_cast<long long>(now));
  std::lock_guard guard(lock_);
  std::erase_if(kept_, [now](const auto& entry) { return now - entry.second.signedAtMs >= kPassKeptMs; });
  kept_.insert_or_assign(account.str(), KeptPass{pass, now});
  return pass;
}

TextAnswer AiServiceClient::ask(const UserId& account, const TextQuestion& question) {
  const SteadyTime started = std::chrono::steady_clock::now();
  const SteadyTime deadline = started + std::chrono::seconds(kDeadlineSeconds);
  const std::string url = url_ + "/v1/calls/" + newCallId() + "/text?label=" + question.label;
  const std::string body = requestBody(question);

  std::string pass = keptPass(account);
  int asks = 0;
  bool askedAgain = false;
  bool signedAgain = false;
  TextAnswer answer;
  for (;;) {
    ++asks;
    const std::optional<TextAnswer> reply = put(url, pass, body, deadline);
    if (!reply && !askedAgain && std::chrono::steady_clock::now() < deadline) {
      askedAgain = true;
      continue;
    }
    if (reply && reply->code == "pass_expired" && !signedAgain) {
      signedAgain = true;
      pass = signedPass(account);
      continue;
    }
    answer = reply.value_or(TextAnswer{"unreachable", ""});
    break;
  }

  const auto took = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started);
  const std::string requestId = currentWriteRequestId();
  const std::string line = "ai_text_call operation=" + question.operation + " label=" + question.label +
      " code=" + answer.code + " asks=" + std::to_string(asks) + " duration_ms=" + std::to_string(took.count()) +
      (requestId.empty() ? "" : " request_id=" + requestId);
  if (answer.code == "completed") LOG_INFO << line;
  else LOG_WARN << line;

  const std::uint64_t now = clock_.nowMs();
  std::optional<std::uint64_t> unansweredForMs;
  {
    std::lock_guard guard(lock_);
    if (answer.code != "unreachable") unansweredSinceMs_.reset();
    else if (!unansweredSinceMs_) unansweredSinceMs_ = now;
    if (unansweredSinceMs_ && now - *unansweredSinceMs_ >= kUnansweredReportMs) unansweredForMs = now - *unansweredSinceMs_;
  }
  if (unansweredForMs && unreachable_.report("unanswered_minutes=" + std::to_string(*unansweredForMs / 60'000)))
    LOG_ERROR << "ai_service_unreachable unanswered_minutes=" << *unansweredForMs / 60'000;
  return answer;
}

}

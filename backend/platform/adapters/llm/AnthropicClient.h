#pragma once

#include "platform/domain/AiFuse.h"
#include "platform/domain/AiUsage.h"
#include "platform/ports/AiUsageRepository.h"

#include <drogon/HttpRequest.h>

#include <json/json.h>

#include <trantor/net/EventLoopThread.h>

#include <functional>
#include <memory>
#include <optional>
#include <string>

namespace wm {

constexpr const char* kAnthropicBaseUrl = "https://api.anthropic.com";
constexpr const char* kAnthropicHost = "api.anthropic.com";
constexpr const char* kAnthropicApiVersion = "2023-06-01";

void applyAnthropicHeaders(const drogon::HttpRequestPtr& request, const std::string& apiKey);

// Why a call produced no usable answer — a closed set the caller branches on.
struct MessagesFailure {
  static constexpr const char* transport = "transport";           // nothing came back, or came back 4xx/5xx
  static constexpr const char* rateLimited = "rate_limited";      // 429 or 529: come back later, the work stands
  static constexpr const char* truncated = "truncated";           // stopped early — the answer is half written
  static constexpr const char* schemaInvalid = "schema_invalid";  // something came back that cannot be read
  static constexpr const char* refused = "refused";               // HTTP 200 with stop_reason "refusal"
};

// One non-streaming Messages call. `system` is sent as one cache_control block: it must be
// byte-stable across calls, with nothing per-request interpolated into it. `schema` is a JSON
// Schema object the reply is constrained to.
struct MessagesRequest {
  std::string model;
  std::string system;
  std::string user;
  Json::Value schema;
  // max_tokens caps thinking and the response together; a budget sized for the JSON alone truncates.
  int maxTokens = 16000;
  // low | medium | high | xhigh | max. Thinking stays on: disabling it leaks reasoning into the
  // response text and breaks the JSON.
  std::string effort = "high";
};

// `ok` false always carries a failure and no output; `ok` true always carries an output. `tokens`
// and `outcome` ride on every reply, failures included.
struct MessagesReply {
  bool ok = false;
  std::string failure;
  Json::Value output;
  TokenUse tokens;
  std::string outcome;
};

struct MessagesApi {
  virtual ~MessagesApi() = default;
  virtual bool configured() const = 0;
  virtual MessagesReply send(const MessagesRequest& request) = 0;
};

std::string messagesPayload(const MessagesRequest& request);

MessagesReply readMessagesReply(int status, const std::string& body);

// Anthropic's /v1/messages, blocking, on a private event loop. An empty API key makes
// configured() false and every send a transport failure.
class AnthropicClient : public MessagesApi {
public:
  explicit AnthropicClient(std::string apiKey);

  bool configured() const override { return !apiKey_.empty(); }
  MessagesReply send(const MessagesRequest& request) override;

private:
  std::string apiKey_;
  trantor::EventLoopThread loop_;
};

// --- Metering ---

long long nowMs();

// A fresh id grouping one logical operation's turns in the ledger; it names rows and authorises nothing.
std::string newRunId(const std::string& prefix);

// Charge one reply to the fuse and post it to the ledger; a null fuse or sink is a no-op.
void meterSpend(AiSpend spend, const std::shared_ptr<AiFuse>& fuse,
                const std::shared_ptr<UsageSink>& usage);

// One tool-loop turn: request body in, parsed reply out, nullopt on any transport or parse failure.
using ModelCall = std::function<std::optional<Json::Value>(const Json::Value& request)>;

// Wrap a tool loop's model call so every turn is metered. `frame` carries who/product/operation/run;
// the wrapper adds the iteration number (it is invoked exactly once per turn), the outcome, and the
// `usage` the raw reply carries. Over the fuse it refuses without calling and answers nullopt, and
// reports the first trip through `report` under "ai.fuse", once.
ModelCall metered(ModelCall inner, AiSpend frame, std::shared_ptr<AiFuse> fuse,
                  std::shared_ptr<UsageSink> usage,
                  std::function<void(const std::string& where, const std::string& detail)> report);

}

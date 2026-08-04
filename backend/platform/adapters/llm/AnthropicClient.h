#pragma once

#include <json/json.h>

#include <trantor/net/EventLoopThread.h>

#include <string>

namespace wm {

// Why a call produced no usable answer. A closed set of words, because the caller has exactly one
// decision to make from it — is this work still owed, or is it done — and an open-ended vendor
// string is not something a batch can branch on. Every branch below lands on one of these five.
struct MessagesFailure {
  static constexpr const char* transport = "transport";           // nothing came back, or came back 4xx/5xx
  static constexpr const char* rateLimited = "rate_limited";      // 429 or 529: come back later, the work stands
  static constexpr const char* truncated = "truncated";           // stopped early — the answer is half written
  static constexpr const char* schemaInvalid = "schema_invalid";  // something came back that cannot be read
  static constexpr const char* refused = "refused";               // HTTP 200 with stop_reason "refusal"
};

// One non-streaming Messages call.
//
// `system` is the cached half: it is sent as a single cache_control block, so it must be byte-stable
// across calls and nothing per-request may ever be interpolated into it. `user` carries everything
// that varies. `schema` is a JSON Schema object the reply is constrained to — structured outputs are
// what turn schema_invalid from a branch you handle into a branch that barely exists.
struct MessagesRequest {
  std::string model;
  std::string system;
  std::string user;
  Json::Value schema;
  // max_tokens caps thinking AND the response together on a reasoning model, so a budget sized
  // around the JSON alone truncates mid-object once the model thinks first. Deliberately far larger
  // than any answer this seam asks for.
  int maxTokens = 16000;
  // low | medium | high | xhigh | max — the only honest way to spend less on a reasoning model.
  // Thinking itself stays on: disabling it leaks the model's reasoning into the response text and
  // breaks the JSON, which costs more than the tokens it saved.
  std::string effort = "high";
};

// The parsed structured output, or the one word that says why there isn't one. `ok` false always
// carries a failure and never an output; `ok` true always carries an output object.
struct MessagesReply {
  bool ok = false;
  std::string failure;
  Json::Value output;
};

// The seam a caller depends on and a test substitutes. One method, because one call per unit of
// work is the only shape a batch needs, and a fake standing in for it is then a dozen lines.
struct MessagesApi {
  virtual ~MessagesApi() = default;
  virtual bool configured() const = 0;
  virtual MessagesReply send(const MessagesRequest& request) = 0;
};

// The request body, as one string. Separate from the client so the wire shape can be read off a test
// rather than off a proxy: every trap this edge has to honour — the cached system block, the budget
// that covers thinking, thinking left on, structured outputs, no sampling parameters — is visible
// here and nowhere else.
std::string messagesPayload(const MessagesRequest& request);

// The reading half, pure: a status and a body in, a reply or a failure word out. Split out because
// this is where the vendor's sharp edges are — a refusal is an HTTP 200 whose content is empty, and
// a truncated answer is an HTTP 200 with half of one — and neither is reachable from a test that has
// to make a live call to see it.
MessagesReply readMessagesReply(int status, const std::string& body);

// Anthropic's /v1/messages, blocking, on a private event loop so the wait never sits on a request
// thread. Product-neutral: it knows the wire, the five failure words, and nothing at all about what
// is being asked. An empty API key makes configured() false and every send a transport failure.
class AnthropicClient : public MessagesApi {
public:
  explicit AnthropicClient(std::string apiKey);

  bool configured() const override { return !apiKey_.empty(); }
  MessagesReply send(const MessagesRequest& request) override;

private:
  std::string apiKey_;
  trantor::EventLoopThread loop_;
};

}

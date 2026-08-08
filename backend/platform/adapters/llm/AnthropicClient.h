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

// Where the vendor lives and which dialect of its wire we speak. Three spellings because three
// callers need three: a drogon client takes the base URL, a TLS policy and a raw `Host:` line take
// the bare host, and every request carries the version. One product retyping any of them is one
// product that keeps calling last year's API after this line moves.
constexpr const char* kAnthropicBaseUrl = "https://api.anthropic.com";
constexpr const char* kAnthropicHost = "api.anthropic.com";
constexpr const char* kAnthropicApiVersion = "2023-06-01";

// The credential and the version, on any request built for that host. A call missing either is
// answered 401 or 400 by the vendor, so the pair travels together or not at all.
void applyAnthropicHeaders(const drogon::HttpRequestPtr& request, const std::string& apiKey);

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
//
// `tokens` and `outcome` ride on EVERY reply, the failures above all. A max_tokens truncation burned
// the whole budget and returns nothing; a refusal was thought about and paid for. Counting only the
// replies we could use would under-report exactly where the money went. `outcome` is the ledger's
// word for the same event `failure` names on the wire — two closed sets, stated apart so an
// aggregate can branch on one without the other's spelling becoming load-bearing.
struct MessagesReply {
  bool ok = false;
  std::string failure;
  Json::Value output;
  TokenUse tokens;
  std::string outcome;
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

// --- Metering ---------------------------------------------------------------------------------
//
// The vendor edge knows what a call cost; only the caller knows whose it was. So attribution
// arrives here as data — an AiSpend the adapter fills in from its own frame — and nothing below
// reaches back for it. AnthropicClient::send stays exactly as advertised above: it records nothing.

// The wall clock the fuse's trailing hour is measured against. Deliberately not a Clock port: this
// feature has no clock seam by design, and the fuse only ever compares two of these to each other.
long long nowMs();

// A fresh id for one logical operation — a tend conversation, a coach exchange — so its dozen turns
// sum as one act in the ledger instead of reading as a dozen unrelated calls. It names rows and
// authorises nothing.
std::string newRunId(const std::string& prefix);

// Charge one reply to the process fuse and post it to the ledger. Every seam does these two things
// identically, and doing them in one place is what stops an adapter deriving a cost of its own from
// a token count. A null sink or a null fuse is the no-op, exactly as FailureReporter already is.
void meterSpend(AiSpend spend, const std::shared_ptr<AiFuse>& fuse,
                const std::shared_ptr<UsageSink>& usage);

// One tool-loop turn: the request body in, the parsed reply out, nullopt on any transport or parse
// failure. Roadmap's `MessagesCall` and gym's `CoachCall` are this type under two product names.
using ModelCall = std::function<std::optional<Json::Value>(const Json::Value& request)>;

// Wrap a tool loop's model call so every turn it takes is metered. `frame` carries what the run
// knows — who, which product, which operation, which run — and the wrapper adds what only the turn
// knows: the iteration number (it is invoked exactly once per turn), the outcome, and the `usage`
// the raw reply carries and the loop itself discards.
//
// Wrapping rather than reaching into driveAgent/driveCoach is the point. Those loops are pure: they
// have never seen a model name, a product, or a clock, and they gain nothing by starting now.
//
// Over the fuse it refuses without calling and answers nullopt, which is the failure both loops
// already handle — and reports the first trip through `report` under "ai.fuse", once, because a
// report per blocked call in a runaway loop is the same runaway aimed at the alerting instead.
ModelCall metered(ModelCall inner, AiSpend frame, std::shared_ptr<AiFuse> fuse,
                  std::shared_ptr<UsageSink> usage,
                  std::function<void(const std::string& where, const std::string& detail)> report);

}

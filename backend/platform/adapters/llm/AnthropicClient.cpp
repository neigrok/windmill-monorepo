#include "platform/adapters/llm/AnthropicClient.h"

#include "platform/adapters/http/VendorCall.h"

#include <drogon/HttpClient.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <memory>
#include <utility>

namespace wm {

namespace {

constexpr double kDeadlineSeconds = 300.0;

}

void applyAnthropicHeaders(const drogon::HttpRequestPtr& request, const std::string& apiKey) {
  request->addHeader("x-api-key", apiKey);
  request->addHeader("anthropic-version", kAnthropicApiVersion);
}

std::string messagesPayload(const MessagesRequest& request) {
  // The one cached block. Everything that varies per request lives in the user turn: a single
  // interpolated byte here moves the prefix and the cache silently never reads.
  Json::Value system(Json::objectValue);
  system["type"] = "text";
  system["text"] = request.system;
  system["cache_control"] = Json::Value(Json::objectValue);
  system["cache_control"]["type"] = "ephemeral";

  Json::Value message(Json::objectValue);
  message["role"] = "user";
  message["content"] = request.user;

  Json::Value format(Json::objectValue);
  format["type"] = "json_schema";
  format["schema"] = request.schema;

  Json::Value output(Json::objectValue);
  output["effort"] = request.effort;
  output["format"] = format;

  Json::Value body(Json::objectValue);
  body["model"] = request.model;
  body["max_tokens"] = request.maxTokens;
  body["system"] = Json::Value(Json::arrayValue);
  body["system"].append(system);
  body["messages"] = Json::Value(Json::arrayValue);
  body["messages"].append(message);
  body["output_config"] = output;
  // Thinking on, depth chosen by the model, spend chosen by `effort`. No budget_tokens and no temperature/top_p/top_k — all four are rejected outright.
  body["thinking"] = Json::Value(Json::objectValue);
  body["thinking"]["type"] = "adaptive";

  Json::StreamWriterBuilder builder;
  builder["indentation"] = "";
  return Json::writeString(builder, body);
}

MessagesReply readMessagesReply(int status, const std::string& body) {
  // `failure` is what the caller branches on; `outcome` is what the meter aggregates by.
  const auto failed = [](const char* failure, const char* outcome, const TokenUse& tokens) {
    MessagesReply reply;
    reply.failure = failure;
    reply.outcome = outcome;
    reply.tokens = tokens;
    return reply;
  };

  // 429 and 529 are both "come back later, the work stands" — a different instruction from "this request was wrong".
  if (status == 429 || status == 529)
    return failed(MessagesFailure::rateLimited, AiOutcome::rateLimited, TokenUse{});
  if (status < 200 || status >= 300)
    return failed(MessagesFailure::transport, AiOutcome::transport, TokenUse{});

  Json::CharReaderBuilder builder;
  const std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  std::string errors;

  Json::Value reply;
  if (!reader->parse(body.data(), body.data() + body.size(), &reply, &errors) || !reply.isObject())
    return failed(MessagesFailure::schemaInvalid, AiOutcome::schemaInvalid, TokenUse{});

  // Counted before anything is judged, because every branch below spent these.
  const TokenUse tokens = tokensFrom(reply["usage"]);

  // stop_reason is read BEFORE content: a refusal is an HTTP 200 whose content array is empty or half filled.
  const Json::Value& stop = reply["stop_reason"];
  if (stop.isString() && stop.asString() == "refusal")
    return failed(MessagesFailure::refused, AiOutcome::refused, tokens);
  // Anything that is not a clean finish — max_tokens, a missing stop_reason — is refused rather than parsed.
  if (!stop.isString() || stop.asString() != "end_turn")
    return failed(MessagesFailure::truncated, AiOutcome::truncated, tokens);

  const Json::Value& content = reply["content"];
  if (!content.isArray() || content.empty())
    return failed(MessagesFailure::schemaInvalid, AiOutcome::schemaInvalid, tokens);

  // A reasoning model leads with a thinking block; the constrained answer is the first TEXT block.
  std::string answer;
  for (const Json::Value& block : content) {
    if (block["type"].isString() && block["type"].asString() == "text" && block["text"].isString()) {
      answer = block["text"].asString();
      break;
    }
  }
  if (answer.empty()) return failed(MessagesFailure::schemaInvalid, AiOutcome::schemaInvalid, tokens);

  Json::Value output;
  if (!reader->parse(answer.data(), answer.data() + answer.size(), &output, &errors) ||
      !output.isObject())
    return failed(MessagesFailure::schemaInvalid, AiOutcome::schemaInvalid, tokens);

  MessagesReply good;
  good.ok = true;
  good.output = output;
  good.tokens = tokens;
  good.outcome = AiOutcome::ok;
  return good;
}

AnthropicClient::AnthropicClient(std::string apiKey) : apiKey_(std::move(apiKey)) { loop_.run(); }

MessagesReply AnthropicClient::send(const MessagesRequest& request) {
  if (apiKey_.empty()) return {false, MessagesFailure::transport, {}};

  auto client = drogon::HttpClient::newHttpClient(kAnthropicBaseUrl, loop_.getLoop());
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Post);
  req->setPath("/v1/messages");
  applyAnthropicHeaders(req, apiKey_);
  req->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  req->setBody(messagesPayload(request));

  // The line carries vendor, op, status and cost, and never a byte of the prompt or the reply.
  VendorCall call("anthropic", "messages");
  const std::pair<drogon::ReqResult, drogon::HttpResponsePtr> outcome =
      client->sendRequest(req, kDeadlineSeconds);
  const drogon::HttpResponsePtr& resp = outcome.second;

  // A call that never landed has no body to read and a status of zero.
  const int status = resp ? static_cast<int>(resp->getStatusCode()) : 0;
  if (!call.succeeded(outcome.first, resp)) return readMessagesReply(status, {});
  return readMessagesReply(status, std::string(resp->getBody()));
}

long long nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

std::string newRunId(const std::string& prefix) {
  // Wall time plus a process-lifetime counter. Nothing here is a secret.
  static std::atomic<unsigned long long> sequence{0};
  char tail[33];
  std::snprintf(tail, sizeof(tail), "%llx-%llx", static_cast<unsigned long long>(nowMs()),
                sequence.fetch_add(1));
  return prefix + "-" + tail;
}

void meterSpend(AiSpend spend, const std::shared_ptr<AiFuse>& fuse,
                const std::shared_ptr<UsageSink>& usage) {
  // The fuse first and unconditionally: floorCostNanos charges an unpriced model rather than zero.
  if (fuse) fuse->spent(floorCostNanos(spend.model, spend.tokens), nowMs());
  if (usage) usage->record(spend);
}

ModelCall metered(ModelCall inner, AiSpend frame, std::shared_ptr<AiFuse> fuse,
                  std::shared_ptr<UsageSink> usage,
                  std::function<void(const std::string&, const std::string&)> report) {
  auto turn = std::make_shared<int>(0);
  return [inner = std::move(inner), frame = std::move(frame), fuse = std::move(fuse),
          usage = std::move(usage), report = std::move(report),
          turn](const Json::Value& request) -> std::optional<Json::Value> {
    AiSpend spend = frame;

    // Asked before the call. allows() raises tripped() itself, so the flag is read first — whoever
    // finds it still down is the one call that reports.
    if (fuse) {
      const bool alreadyReported = fuse->tripped();
      if (!fuse->allows(nowMs())) {
        if (report && !alreadyReported)
          report("ai.fuse", "over the hourly spend ceiling — refusing " + spend.product + " " +
                                spend.operation + " calls until the window clears");
        return std::nullopt;
      }
    }
    // Numbered only now: a turn the fuse refused made no call and must not consume an ordinal.
    spend.iteration = (*turn)++;

    const std::optional<Json::Value> reply = inner(request);
    if (!reply) {
      spend.outcome = AiOutcome::transport;
      meterSpend(spend, fuse, usage);
      return reply;
    }

    spend.tokens = tokensFrom((*reply)["usage"]);
    const Json::Value& stop = (*reply)["stop_reason"];
    const std::string reason = stop.isString() ? stop.asString() : std::string();
    // A turn that ended asking for tools is as finished as one that ended talking.
    spend.outcome = reason == "end_turn" || reason == "tool_use" ? AiOutcome::ok
                    : reason == "refusal"                        ? AiOutcome::refused
                                                                 : AiOutcome::truncated;
    meterSpend(spend, fuse, usage);
    return reply;
  };
}

}

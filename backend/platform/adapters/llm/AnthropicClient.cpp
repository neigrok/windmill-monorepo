#include "platform/adapters/llm/AnthropicClient.h"

#include "platform/adapters/http/VendorCall.h"

#include <drogon/HttpClient.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <memory>
#include <utility>

namespace wm {

namespace {

constexpr const char* kBaseUrl = "https://api.anthropic.com";
constexpr const char* kApiVersion = "2023-06-01";

// Nobody is waiting on this call. It runs in a nightly batch, on a model that thinks before it
// writes, at an effort level the caller picks — so the deadline is sized for the slowest honest
// answer rather than for a person watching a spinner. A timeout here costs one page one night.
constexpr double kDeadlineSeconds = 300.0;

}

std::string messagesPayload(const MessagesRequest& request) {
  // The one cached block. Everything that varies per request lives in the user turn below, because
  // a single interpolated byte here moves the prefix and the cache silently never reads.
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
  // Stated rather than left to the model's default, because it is load-bearing and the default is
  // not the same on every model in the family: thinking on, depth chosen by the model, spend chosen
  // by `effort`. No budget_tokens and no temperature/top_p/top_k — all four are rejected outright.
  body["thinking"] = Json::Value(Json::objectValue);
  body["thinking"]["type"] = "adaptive";

  Json::StreamWriterBuilder builder;
  builder["indentation"] = "";
  return Json::writeString(builder, body);
}

MessagesReply readMessagesReply(int status, const std::string& body) {
  // 429 is the vendor asking for quiet; 529 is the vendor saying it is full. To a batch those are
  // the same instruction, and it is a different instruction from "this request was wrong".
  if (status == 429 || status == 529) return {false, MessagesFailure::rateLimited, {}};
  if (status < 200 || status >= 300) return {false, MessagesFailure::transport, {}};

  Json::CharReaderBuilder builder;
  const std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  std::string errors;

  Json::Value reply;
  if (!reader->parse(body.data(), body.data() + body.size(), &reply, &errors) || !reply.isObject())
    return {false, MessagesFailure::schemaInvalid, {}};

  // stop_reason is read BEFORE content, and this order is the whole point. A refusal on this model
  // is an HTTP 200 whose content array is empty or half filled, so code that reaches for content[0]
  // first reads a hole and calls it an answer.
  const Json::Value& stop = reply["stop_reason"];
  if (stop.isString() && stop.asString() == "refusal") return {false, MessagesFailure::refused, {}};
  // Anything that is not a clean finish — max_tokens above all, a missing stop_reason included — is
  // refused outright rather than parsed. Half a JSON object is not a smaller answer, it is a
  // different one, and a batch that stores it has no way to learn it was wrong.
  if (!stop.isString() || stop.asString() != "end_turn")
    return {false, MessagesFailure::truncated, {}};

  const Json::Value& content = reply["content"];
  if (!content.isArray() || content.empty()) return {false, MessagesFailure::schemaInvalid, {}};

  // A reasoning model leads with a thinking block; the constrained answer is the first TEXT block.
  std::string answer;
  for (const Json::Value& block : content) {
    if (block["type"].isString() && block["type"].asString() == "text" && block["text"].isString()) {
      answer = block["text"].asString();
      break;
    }
  }
  if (answer.empty()) return {false, MessagesFailure::schemaInvalid, {}};

  Json::Value output;
  if (!reader->parse(answer.data(), answer.data() + answer.size(), &output, &errors) ||
      !output.isObject())
    return {false, MessagesFailure::schemaInvalid, {}};
  return {true, {}, output};
}

AnthropicClient::AnthropicClient(std::string apiKey) : apiKey_(std::move(apiKey)) { loop_.run(); }

MessagesReply AnthropicClient::send(const MessagesRequest& request) {
  if (apiKey_.empty()) return {false, MessagesFailure::transport, {}};

  auto client = drogon::HttpClient::newHttpClient(kBaseUrl, loop_.getLoop());
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Post);
  req->setPath("/v1/messages");
  req->addHeader("x-api-key", apiKey_);
  req->addHeader("anthropic-version", kApiVersion);
  req->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  req->setBody(messagesPayload(request));

  // The line carries vendor, op, status and cost, and never a byte of the prompt or the reply. This
  // seam is handed whatever the caller is asking about, and on this codebase that is somebody's
  // private writing.
  VendorCall call("anthropic", "messages");
  const std::pair<drogon::ReqResult, drogon::HttpResponsePtr> outcome =
      client->sendRequest(req, kDeadlineSeconds);
  const drogon::HttpResponsePtr& resp = outcome.second;

  // A call that never landed has no body to read, and a status of zero — which the same reader
  // turns into the same word it would have used anyway. One mapping, one place.
  const int status = resp ? static_cast<int>(resp->getStatusCode()) : 0;
  if (!call.succeeded(outcome.first, resp)) return readMessagesReply(status, {});
  return readMessagesReply(status, std::string(resp->getBody()));
}

}

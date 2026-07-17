#include "adapters/llm/AnthropicComposer.h"

#include <drogon/HttpClient.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <json/json.h>

#include <utility>

namespace wm {

namespace {

// The load-bearing artifact: the output contract the model rewrites into. It restates the
// paste-import grammar (spec §03) as writing rules, because the client re-parses the reply
// with that grammar verbatim — a plan is only as good as its markdown shape.
constexpr const char* kSystemPrompt =
    "You convert the user's pasted text into a markdown plan. The plan is parsed by a "
    "strict, deterministic grammar, so the shape of the markdown is the whole job.\n"
    "\n"
    "Format:\n"
    "- The first line is `# <goal title>` — the goal of the whole plan. If the text names "
    "no goal, invent a short, honest one from what the text is about.\n"
    "- Group steps under `## <branch>` headings when the content has natural groupings "
    "(2-4 branches). When it doesn't, use no branch headings at all.\n"
    "- Each step is one line. Use `- ` bullets for parallel work that can happen in any "
    "order. Use `1.` `2.` `3.` numbered lists for ordered work where each step unlocks "
    "the next.\n"
    "- Indent a step by 2 spaces under the step above it only when it genuinely depends "
    "on that step being done first. Depth means dependency — never indent for looks.\n"
    "- Write `- [x]` only for steps the text says are already done. Everything else is a "
    "plain step — never guess at completion.\n"
    "- Keep step labels short imperatives, at most 8 words.\n"
    "- Anything that is context rather than a step — links, asides, half sentences — "
    "stays as a plain line (no bullet, no number) directly under the step it belongs to. "
    "Nothing from the text is dropped.\n"
    "\n"
    "Hard rules:\n"
    "- Never invent steps the text does not imply.\n"
    "- Never add commentary, preamble, explanations, or code fences.\n"
    "- Output the plan text and nothing else.";

}

std::string strippedPlan(const std::string& reply) {
  const auto trimmed = [](const std::string& s) {
    const std::size_t begin = s.find_first_not_of(" \t\r\n");
    if (begin == std::string::npos) return std::string();
    const std::size_t end = s.find_last_not_of(" \t\r\n");
    return s.substr(begin, end - begin + 1);
  };

  std::string plan = trimmed(reply);
  if (plan.rfind("```", 0) == 0) {
    const std::size_t firstBreak = plan.find('\n');
    plan = firstBreak == std::string::npos ? std::string() : plan.substr(firstBreak + 1);
  }
  const std::size_t lastBreak = plan.find_last_of('\n');
  const std::string lastLine = lastBreak == std::string::npos ? plan : plan.substr(lastBreak + 1);
  if (trimmed(lastLine) == "```") {
    plan = lastBreak == std::string::npos ? std::string() : plan.substr(0, lastBreak);
  }
  return trimmed(plan);
}

AnthropicComposer::AnthropicComposer(std::string apiKey) : apiKey_(std::move(apiKey)) {
  loop_.run();
}

bool AnthropicComposer::configured() const { return !apiKey_.empty(); }

void AnthropicComposer::compose(const std::string& text,
                                std::function<void(std::optional<std::string>)> done) {
  if (apiKey_.empty()) {
    done(std::nullopt);
    return;
  }

  Json::Value message(Json::objectValue);
  message["role"] = "user";
  message["content"] = text;
  Json::Value body(Json::objectValue);
  body["model"] = "claude-sonnet-5";
  body["max_tokens"] = 2000;
  body["temperature"] = 0;
  body["system"] = kSystemPrompt;
  body["messages"] = Json::Value(Json::arrayValue);
  body["messages"].append(message);

  Json::StreamWriterBuilder builder;
  builder["indentation"] = "";
  const std::string payload = Json::writeString(builder, body);

  auto client = drogon::HttpClient::newHttpClient("https://api.anthropic.com", loop_.getLoop());

  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Post);
  req->setPath("/v1/messages");
  req->addHeader("x-api-key", apiKey_);
  req->addHeader("anthropic-version", "2023-06-01");
  req->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  req->setBody(payload);

  client->sendRequest(
      req,
      [client, done = std::move(done)](drogon::ReqResult result, const drogon::HttpResponsePtr& resp) {
        const int status = resp ? static_cast<int>(resp->getStatusCode()) : 0;
        if (result != drogon::ReqResult::Ok || status < 200 || status >= 300) {  // accept any 2xx
          const std::string detail = resp ? std::string(resp->getBody()) : std::string("no response");
          LOG_ERROR << "compose upstream failed (status " << status << "): " << detail;
          done(std::nullopt);
          return;
        }

        std::shared_ptr<Json::Value> reply = resp->getJsonObject();
        if (!reply || !(*reply)["content"].isArray() || (*reply)["content"].empty() ||
            !(*reply)["content"][0]["text"].isString()) {
          LOG_ERROR << "compose upstream returned an unreadable reply";
          done(std::nullopt);
          return;
        }

        const Json::Value& stopReason = (*reply)["stop_reason"];
        if (!stopReason.isString() || stopReason.asString() != "end_turn") {
          // max_tokens or any other early stop means a truncated plan — never hand the
          // client half a plan to replace the user's paste with.
          LOG_ERROR << "compose upstream stopped early (stop_reason: "
                    << (stopReason.isString() ? stopReason.asString() : std::string("missing")) << ")";
          done(std::nullopt);
          return;
        }

        const std::string plan = strippedPlan((*reply)["content"][0]["text"].asString());
        if (plan.empty()) {
          done(std::nullopt);
          return;
        }
        done(plan);
      },
      20.0);
}

}

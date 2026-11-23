#pragma once

#include "platform/adapters/json/JsonText.h"
#include "platform/ai_service/AiText.h"

#include <json/json.h>

#include <optional>
#include <string>
#include <utility>

namespace wm {

// What both of Echoes' steps ask the AI service for (echoes-on-ai-service.md §11): the class `medium` at effort `low`,
// an answer of at most 16,000 tokens held to the step's schema, uncached, under the label `echoes`. The service serves
// `medium` from claude-sonnet-5, and the model and the effort head each step's version. A page is derived again when a
// step's version moves (§6), so kEchoServedModel changes by hand in the change that makes the service serve `medium`
// from another model.
inline constexpr const char* kEchoClass = "medium";
inline constexpr const char* kEchoServedModel = "claude-sonnet-5";
inline constexpr const char* kEchoEffort = "low";

// A step's answer: its JSON object, or why there is none in one word — the AI service's stop or code, its client's
// `unreachable` or `unreadable`, or `unreadable` for an answer that is no JSON object.
struct EchoAnswer {
  std::optional<Json::Value> output;
  std::string failure;
};

// One step asked of the AI service for the writer's account: the step's prompt as the system text, the page as the one
// user message. `operation` names the call on the client's line.
inline EchoAnswer askEchoStep(AiText& ai, const UserId& writer, const char* operation, const char* prompt,
                              std::string page, Json::Value schema) {
  TextQuestion question;
  question.label = "echoes";
  question.operation = operation;
  question.model = kEchoClass;
  question.effort = kEchoEffort;
  question.cache = false;
  question.maxTokens = 16000;
  question.system = prompt;
  question.user = std::move(page);
  question.schema = std::move(schema);

  const TextAnswer answer = ai.ask(writer, question);
  if (answer.code != "completed") return {std::nullopt, answer.code};
  std::optional<Json::Value> output = parseWhole(answer.text);
  if (!output || !output->isObject()) return {std::nullopt, "unreadable"};
  return {std::move(output), ""};
}

}

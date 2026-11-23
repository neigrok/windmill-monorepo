#pragma once

#include "platform/domain/Ids.h"

#include <json/json.h>

#include <string>

namespace wm {

// One question the backend asks the AI service's text door for work nobody waits on (ai-service.md §6.2): one system
// prompt and one user message, answered as JSON held to `schema`. `model` is a class (`large`, `medium`, `small`).
// `label` is the service's reporting label for the call, and `operation` names it on the backend's own log line.
struct TextQuestion {
  std::string label;
  std::string operation;
  std::string model;
  std::string effort;
  bool cache = true;
  int maxTokens = 0;
  std::string system;
  std::string user;
  Json::Value schema;
};

// How a call ended, in the service's words where it gave any: the `stop` of an `ended` event (`completed`, `tool_calls`,
// `truncated`, `declined`), or the `code` of a `failed` event or of a refusal before the stream (§6.3). The client adds
// two words of its own: `unreachable` when no answer came at all, and `unreadable` when one came that it could not read.
// `text` is the answer, and only a `completed` call carries one.
struct TextAnswer {
  std::string code;
  std::string text;
};

// The AI service's text door as the backend reaches it for an account's background work (ai-service.md §3).
struct AiText {
  virtual ~AiText() = default;
  virtual TextAnswer ask(const UserId& account, const TextQuestion& question) = 0;
};

}

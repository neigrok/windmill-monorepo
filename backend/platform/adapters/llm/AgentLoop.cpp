#include "platform/adapters/llm/AgentLoop.h"

#include <string>
#include <utility>

namespace wm {

namespace {

std::string trim(const std::string& text) {
  const std::size_t begin = text.find_first_not_of(" \t\r\n");
  if (begin == std::string::npos) return std::string();
  const std::size_t end = text.find_last_not_of(" \t\r\n");
  return text.substr(begin, end - begin + 1);
}

Json::Value ephemeral() {
  Json::Value mark(Json::objectValue);
  mark["type"] = "ephemeral";
  return mark;
}

Json::Value assistantMessage(const Json::Value& content) {
  Json::Value message(Json::objectValue);
  message["role"] = "assistant";
  message["content"] = content;  // whole content, so tool_use and thinking blocks survive the turn
  return message;
}

Json::Value userToolResults(const Json::Value& blocks) {
  Json::Value message(Json::objectValue);
  message["role"] = "user";
  message["content"] = blocks;
  return message;
}

// The static half of every request — the system prompt and the tool catalog — is written to the cache
// once and read at a tenth the price on every iteration after. The system breakpoint caches
// tools+system (they render before it); markAgentCachePoint extends the cached prefix through the
// seed document and the turns so far.
Json::Value messagesRequest(const AgentLoopSpec& spec, const Json::Value& tools,
                            const Json::Value& messages) {
  Json::Value systemBlock(Json::objectValue);
  systemBlock["type"] = "text";
  systemBlock["text"] = spec.system;
  systemBlock["cache_control"] = ephemeral();
  Json::Value system(Json::arrayValue);
  system.append(systemBlock);

  Json::Value body(Json::objectValue);
  body["model"] = spec.model;
  body["max_tokens"] = spec.maxTokens;
  if (!spec.effort.empty()) {
    Json::Value outputConfig(Json::objectValue);
    outputConfig["effort"] = spec.effort;
    body["output_config"] = outputConfig;
  }
  body["system"] = system;
  body["tools"] = tools;
  body["messages"] = messages;
  return body;
}

// What the person reads: the text blocks of the final turn, joined. Thinking blocks are skipped —
// they carry no text on these models and they are not ours to print either way.
std::string finalText(const Json::Value& content) {
  std::string out;
  for (const Json::Value& block : content) {
    if (block["type"].asString() == "text" && block["text"].isString()) {
      if (!out.empty()) out += "\n";
      out += block["text"].asString();
    }
  }
  return out;
}

}  // namespace

Json::Value agentToolCatalog(const Json::Value& mcpTools) {
  Json::Value out(Json::arrayValue);
  if (!mcpTools.isArray()) return out;
  for (const Json::Value& mcp : mcpTools) {
    Json::Value tool(Json::objectValue);
    tool["name"] = mcp["name"];
    tool["description"] = mcp["description"];
    tool["input_schema"] = mcp["inputSchema"];  // the whole job: MCP's name → Anthropic's name
    out.append(tool);
  }
  return out;
}

std::string agentToolText(const ToolResult& result) {
  std::string out;
  for (const Json::Value& block : result.content) {
    if (block["type"].asString() == "text" && block["text"].isString()) {
      if (!out.empty()) out += "\n";
      out += block["text"].asString();
    }
  }
  return out;
}

Json::Value agentToolResult(const std::string& toolUseId, const ToolResult& result) {
  Json::Value block(Json::objectValue);
  block["type"] = "tool_result";
  block["tool_use_id"] = toolUseId;
  block["content"] = agentToolText(result);
  if (result.isError) block["is_error"] = true;
  return block;
}

void markAgentCachePoint(Json::Value& messages) {
  for (Json::Value& message : messages) {
    Json::Value& content = message["content"];
    if (!content.isArray()) continue;
    for (Json::Value& block : content) block.removeMember("cache_control");
  }
  if (messages.empty()) return;
  Json::Value& content = messages[messages.size() - 1]["content"];
  if (content.isString()) {
    Json::Value block(Json::objectValue);
    block["type"] = "text";
    block["text"] = content.asString();
    Json::Value promoted(Json::arrayValue);
    promoted.append(block);
    content = promoted;
  }
  if (content.isArray() && !content.empty()) content[content.size() - 1]["cache_control"] = ephemeral();
}

AgentLoopOutcome driveAgentLoop(const AgentLoopSpec& spec, ToolHost& tools, const ToolCaller& caller,
                                const ModelCall& call, const AgentReport& report) {
  AgentLoopOutcome outcome;
  if (spec.messages.empty()) {
    outcome.error = "the loop was given no conversation to run";
    report(spec.where, outcome.error);
    return outcome;
  }

  const Json::Value catalog = agentToolCatalog(tools.listTools(caller));
  Json::Value messages = spec.messages;

  for (int iteration = 0; iteration < spec.maxIterations; ++iteration) {
    markAgentCachePoint(messages);  // the growing prefix is written once and read after
    const std::optional<Json::Value> reply = call(messagesRequest(spec, catalog, messages));
    if (!reply) {
      outcome.error = "the model call failed or returned an unreadable reply";
      report(spec.where, outcome.error);
      return outcome;
    }
    // COUNTED THE MOMENT A REPLY EXISTS, and above every judgement about what it says. From here the
    // vendor has answered and billed us; a reply that turns out to be unreadable, or a stop reason
    // nobody wanted, cost exactly what a good one cost.
    ++outcome.modelTurns;

    const Json::Value& content = (*reply)["content"];
    const Json::Value& stopReason = (*reply)["stop_reason"];
    if (!content.isArray() || !stopReason.isString()) {
      outcome.error = "the model reply was missing its content or stop reason";
      report(spec.where, outcome.error);
      return outcome;
    }

    messages.append(assistantMessage(content));

    if (stopReason.asString() == "end_turn") {
      outcome.text = trim(finalText(content));
      if (spec.answerRequired && outcome.text.empty()) {
        // A turn that ended with nothing to read is not an answer. Saying so beats printing a blank
        // answer and letting the person wonder what it meant.
        outcome.error = "the model finished without saying anything";
        report(spec.where, outcome.error);
        return outcome;
      }
      outcome.ok = true;
      return outcome;
    }

    if (stopReason.asString() != "tool_use") {
      // max_tokens, refusal, or any other early stop. A partial answer is a different answer, not a
      // shorter one.
      outcome.error = "the model stopped early (stop_reason: " + stopReason.asString() + ")";
      report(spec.where, outcome.error);
      return outcome;
    }

    // Execute every requested tool, in order, and answer each with a matching tool_result.
    Json::Value results(Json::arrayValue);
    for (const Json::Value& block : content) {
      if (block["type"].asString() != "tool_use") continue;
      const std::string name = block["name"].asString();
      const ToolResult result = tools.callTool(name, block["input"], caller);
      results.append(agentToolResult(block["id"].asString(), result));
      outcome.steps.push_back(AgentLoopStep{name, result.isError});
    }

    if (results.empty()) {
      outcome.error = "the model asked for tools but named none";
      report(spec.where, outcome.error);
      return outcome;
    }
    messages.append(userToolResults(results));
  }

  outcome.error = "hit the " + std::to_string(spec.maxIterations) +
                  "-iteration cap without the model finishing";
  report(spec.where, outcome.error);
  return outcome;
}

}

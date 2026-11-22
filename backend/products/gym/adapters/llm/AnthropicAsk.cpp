#include "products/gym/adapters/llm/AnthropicAsk.h"
#include "platform/adapters/llm/AiCallBudget.h"

#include "platform/adapters/llm/AnthropicStream.h"
#include "platform/application/WriteObservation.h"
#include "products/gym/coach/CoachWords.h"

#include <algorithm>
#include <stdexcept>
#include <charconv>
#include <string_view>
#include <drogon/utils/Utilities.h>
#include "platform/adapters/llm/AnthropicClient.h"


#include <trantor/utils/Logger.h>


#include <memory>
#include <string>
#include <utility>

namespace wm::gym {

namespace {

// Each prompt must stay byte-stable across requests: it plus the tool catalog is one cached prefix, and
// a single interpolated byte moves it so the cache never reads. The shipped prompt (CoachWords) is a
// turn's, where create_routine runs; Ask's rules swap that one line, so the prompt and the tools never
// disagree.
constexpr const char* kRoutineDrafts = R"coach(- create_routine prepares a new routine draft for review. It does not create a routine. The lifter must review the movements, equipment and set targets, then tap Save routine. Describe the plan as a draft and never claim it is saved until a subsequent receipt says so. At most six additions are allowed per answer, each with a distinct stable id and an immutable document. Replay server-held actions in their original order after interruption; draft receipts confirm only the pending plan, while saved receipts describe the original creation and never restore later edits or deletions. Read Notes for goals and constraints and list_exercises for actual movement IDs first. Report creation only after a saved receipt; use its returned ID for further tool references.
)coach";

constexpr const char* kNoRoutineDrafts = R"coach(- New routines cannot be saved from this version of the app. When the lifter wants a new routine, describe the plan in your answer and tell them they can update the app or build it themselves in Routines. Never claim that a routine was created or saved.
)coach";

// Hitting the cap is a failure.
constexpr int kMaxIterations = 8;


Json::Value textMessage(const char* role, const std::string& text) {
  Json::Value message(Json::objectValue);
  message["role"] = role;
  message["content"] = text;
  return message;
}

void appendToolRoundText(std::string& transcript, const Json::Value& message) {
  if (!message["stop_reason"].isString() || message["stop_reason"].asString() != "tool_use" || !message["content"].isArray()) return;
  std::string text;
  for (const auto& block : message["content"])
    if (block.isObject() && block["type"].isString() && block["type"].asString() == "text" && block["text"].isString()) {
      if (!text.empty()) text += "\n";
      text += block["text"].asString();
    }
  if (!text.empty()) transcript += text + "\n\n";
}

}  // namespace

const std::string& coachSystemPrompt(CoachRoutineRule rule) {
  const auto withRoutineLine = [](const char* line) {
    std::string prompt = coach::CoachWords::shipped().prompt();
    const std::size_t start = prompt.find("\n- create_routine ");
    if (start == std::string::npos) throw std::logic_error("the Coach prompt has no create_routine line");
    const std::size_t end = prompt.find('\n', start + 1);
    return prompt.replace(start + 1, end - start, line);
  };
  static const std::string drafts = withRoutineLine(kRoutineDrafts);
  static const std::string unavailable = withRoutineLine(kNoRoutineDrafts);
  if (rule == CoachRoutineRule::drafts) return drafts;
  if (rule == CoachRoutineRule::runs) return coach::CoachWords::shipped().prompt();
  return unavailable;
}

int coachMaxOutputTokens(const char* configured) {
  if (!configured || !*configured) return kCoachMaxOutputTokens;
  const std::string_view value{configured};
  int tokens = 0;
  const auto parsed = std::from_chars(value.data(), value.data() + value.size(), tokens);
  if (parsed.ec != std::errc{} || parsed.ptr != value.data() + value.size() || tokens < 1024 || tokens > 8000)
    throw std::invalid_argument("COACH_MAX_OUTPUT_TOKENS must be an integer from 1024 to 8000");
  return tokens;
}

Json::Value askOpeningMessages(const std::vector<AskTurn>& turns, const std::string& notesDocument,
                               const std::string& logDocument) {
  // Oldest first, with both documents welded to the first turn so the growing prefix stays
  // cacheable and the system prompt stays byte-stable. The notes come first: the lifter's
  // instructions frame the data, and the top note wins.
  Json::Value messages(Json::arrayValue);
  for (std::size_t index = 0; index < turns.size(); ++index) {
    const AskTurn& turn = turns[index];
    if (index == 0) {
      messages.append(textMessage(
          "user", "Here are my notes for you, exactly as list_notes returns them — my own "
                  "instructions, the top note winning where two disagree:\n" +
                      notesDocument +
                      "\n\nHere is the newest page of my training log, exactly as list_sessions "
                      "returns it:\n" +
                      logDocument + "\n\n" + turn.text));
    } else {
      messages.append(textMessage(turn.fromLifter ? "user" : "assistant", turn.text));
    }
    if (!turn.images.empty()) {
      auto& message = messages[messages.size() - 1];
      Json::Value blocks(Json::arrayValue);
      for (const auto& image : turn.images) {
        Json::Value block(Json::objectValue);
        block["type"] = "image";
        block["source"]["type"] = "base64";
        block["source"]["media_type"] = image.mediaType;
        block["source"]["data"] = drogon::utils::base64Encode(image.data);
        blocks.append(block);
      }
      Json::Value text(Json::objectValue);
      text["type"] = "text";
      text["text"] = message["content"].isString() ? message["content"] : message["content"][0]["text"];
      blocks.append(text);
      message["content"] = blocks;
    }
  }
  return messages;
}

AskAnswer driveAsk(const std::vector<AskTurn>& turns, const ToolCaller& caller, ToolHost& tools,
                   const AskCall& call, const AgentReport& report, const AskControl& control,
                   int maxOutputTokens) {
  AskAnswer outcome;
  if (turns.empty()) {
    outcome.error = "Coach was given no question to answer";
    report("ask.setup", outcome.error);
    return outcome;
  }

  // An unreadable log means no run, and so do unreadable notes.
  const ToolResult opening = tools.callTool("list_sessions", Json::Value(Json::objectValue), caller);
  if (opening.isError) {
    outcome.error = "could not read the log before answering";
    report("ask.setup", outcome.error);
    return outcome;
  }
  // A declared tool call, never a silent injection, so the step line can say "read your notes"
  // on every answer — an empty list welds an empty document and the step is still true. The log
  // read above is not a step because the receipt already carries what it served; a note is not a
  // log row, so this read is accounted for here and nowhere else.
  const ToolResult notes = tools.callTool("list_notes", Json::Value(Json::objectValue), caller);
  if (notes.isError) {
    outcome.error = "could not read the notes before answering";
    report("ask.setup", outcome.error);
    return outcome;
  }

  const auto offered = tools.declareTools();
  const bool drafts = std::any_of(offered.begin(), offered.end(), [](const auto& tool) { return tool.name() == "create_routine"; });
  AgentLoopSpec spec;
  spec.model = kCoachModel;
  spec.effort = kCoachEffort;
  spec.maxTokens = maxOutputTokens;
  spec.maxIterations = kMaxIterations;
  spec.system = coachSystemPrompt(drafts ? CoachRoutineRule::drafts : CoachRoutineRule::unavailable);
  spec.messages = askOpeningMessages(turns, agentToolText(notes), agentToolText(opening));
  spec.where = "ask.run";
  spec.continueRun = control.continueRun;

  std::string transcript;
  const AskCall collect = [&](const Json::Value& request) {
    auto reply = call(request);
    if (reply) appendToolRoundText(transcript, *reply);
    return reply;
  };
  const AgentLoopOutcome ran = driveAgentLoop(spec, tools, caller, collect, report);
  outcome.ok = ran.ok;
  outcome.answer = ran.ok ? transcript + ran.text : "";
  outcome.error = ran.error;
  outcome.modelTurns = ran.modelTurns;
  outcome.steps.push_back(AskStep{"list_notes", false});
  for (const AgentLoopStep& step : ran.steps) outcome.steps.push_back(AskStep{step.tool, step.failed});
  return outcome;
}

AnthropicAsk::AnthropicAsk(std::string apiKey, std::shared_ptr<FailureReporter> failures,
                           std::shared_ptr<AiFuse> fuse, std::shared_ptr<UsageSink> usage, std::string baseUrl,
                           std::shared_ptr<AiCallBudget> budget, int maxOutputTokens)
    : apiKey_(std::move(apiKey)),
      failures_(std::move(failures)),
      fuse_(std::move(fuse)),
      usage_(std::move(usage)), budget_(std::move(budget)), baseUrl_(std::move(baseUrl)),
      maxOutputTokens_(maxOutputTokens) {
  if (maxOutputTokens_ < 1024 || maxOutputTokens_ > 8000)
    throw std::invalid_argument("Coach output tokens must be from 1024 to 8000");
}

bool AnthropicAsk::configured() const { return !apiKey_.empty(); }

AskAnswer AnthropicAsk::answer(const std::vector<AskTurn>& turns, const ToolCaller& caller,
                               ToolHost& tools) {
  return answer(turns, caller, tools, {});
}

AskAnswer AnthropicAsk::answer(const std::vector<AskTurn>& turns, const ToolCaller& caller,
                               ToolHost& tools, const AskControl& control) {
  std::string refusal;
  const AgentReport report = [failures = failures_, &refusal](const std::string& where,
                                                    const std::string& detail) {
    if (where == "ai.fuse") return;
    if (detail == "the model stopped early (stop_reason: refusal)") refusal = "refused";
    if (!refusal.empty()) return;
    const std::runtime_error failure("Coach model failed");
    if (!currentWriteRequestId().empty()) {
      reportCurrentWriteFailure(failure);
      return;
    }
    WriteObservation observation{"ask.run", "gym", "Coach", "", failures.get()};
    observation.fail(failure);
  };

  if (apiKey_.empty()) {
    AskAnswer out;
    out.error = "Coach is not configured (no API key)";
    out.outcomeCode = "ask-not-configured";
    return out;
  }

  std::string transcript;
  const ModelRoundCall call = [this, &control, &transcript, &refusal](const Json::Value& request) {
    ModelRound round = streamAnthropicMessage(apiKey_, baseUrl_, request, [&](const std::string& text) {
      if (control.text) control.text(transcript + text);
    }, control.continueRun, [&](const Json::Value& diagnostic) {
      if (diagnostic["httpStatus"].asInt() == 429 || diagnostic["httpStatus"].asInt() == 529 ||
          diagnostic["providerError"].asString() == "rate_limit_error")
        refusal = "rate_limited";
    });
    if (round.reply) appendToolRoundText(transcript, *round.reply);
    return round;
  };

  // One row per turn, one run id across the exchange.
  AiSpend frame;
  frame.user = caller.user;
  frame.product = "gym";
  frame.operation = "ask";
  frame.model = kCoachModel;
  frame.runId = newRunId("ask");

  auto answer = driveAsk(turns, caller, tools,
                         metered(call, frame, fuse_, usage_, report, [&] { refusal = "ai-fuse"; },
                                 budget_, [&](const std::string& code) { refusal = code; }, 1'024),
                         report, control, maxOutputTokens_);
  answer.outcomeCode = refusal;
  return answer;
}

}

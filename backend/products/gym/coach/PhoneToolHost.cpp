#include "products/gym/coach/PhoneToolHost.h"

#include <trantor/utils/Logger.h>

#include <chrono>
#include <optional>
#include <utility>

namespace wm::gym::coach {

namespace {

// What the model reads of a refusal: the code first, so a transcript names the rule.
ToolResult refused(const std::string& code, const std::string& message) {
  return ToolResult::failure("[" + code + "] " + message, code);
}

ToolResult resultFor(const TurnCallResult& answer) {
  if (answer.ok) return ToolResult::json(answer.result);
  return refused(answer.code, "the phone refused this call.");
}

}  // namespace

PhoneToolHost::PhoneToolHost(const AbilityCatalog& catalog, Turn& turn, ToolHost* server,
                             std::chrono::milliseconds resultTimeout)
    : catalog_(catalog), turn_(turn), server_(server), resultTimeout_(resultTimeout),
      gate_(catalog, turn.principal().seat, turn.id()) {}

std::vector<ToolDeclaration> PhoneToolHost::declareTools() const { return catalog_.offered(turn_.principal().seat); }

ToolResult PhoneToolHost::callTool(const std::string& name, const Json::Value& arguments, const ToolCaller& caller) {
  return callTools({ToolCall{"", name, arguments}}, caller).front();
}

std::vector<ToolResult> PhoneToolHost::callTools(const std::vector<ToolCall>& calls, const ToolCaller& caller) {
  const auto started = std::chrono::steady_clock::now();
  std::vector<std::optional<ToolResult>> answered(calls.size());
  std::vector<const Ability*> admitted(calls.size(), nullptr);
  std::vector<TurnCall> phone;
  std::vector<std::size_t> phoneIndex;
  int refusedCalls = 0;
  int server = 0;
  for (std::size_t index = 0; index < calls.size(); ++index) {
    const ToolCall& call = calls[index];
    GateVerdict verdict = gate_.admit(call.name, call.arguments, turn_.stopRequested());
    if (!verdict.admitted) {
      ++refusedCalls;
      answered[index] = refused(verdict.code, verdict.message);
      continue;
    }
    ++callsByName_[call.name];
    admitted[index] = verdict.ability;
    if (verdict.ability->host == AbilityHost::server) {
      ++server;
      answered[index] = server_ ? server_->callTool(call.name, verdict.input, caller)
                                : refused(gate::seatRequired, call.name + ": not available on this seat.");
      gate_.settle(*verdict.ability, !answered[index]->isError);
      continue;
    }
    phone.push_back(TurnCall{call.id, call.name, std::move(verdict.input)});
    phoneIndex.push_back(index);
  }

  std::string outcome = "answered";
  if (!phone.empty()) {
    ++batches_;
    const TurnBatch batch = turn_.sendBatch(std::move(phone));
    const std::optional<std::vector<TurnCallResult>> results = turn_.awaitResults(resultTimeout_);
    if (!results) {
      outcome = turn_.stopRequested() ? "stopped" : "timeout";
      interrupted_ = !turn_.stopRequested();
      for (const std::size_t index : phoneIndex)
        answered[index] = refused(outcome, "the phone did not answer this call.");
    } else {
      for (std::size_t at = 0; at < results->size(); ++at) {
        answered[phoneIndex[at]] = resultFor((*results)[at]);
        gate_.settle(*admitted[phoneIndex[at]], (*results)[at].ok);
      }
    }
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started);
    LOG_INFO << "coach_batch turn=" << turn_.id() << " batch=" << batch.number << " seat=" << std::string(nameOf(turn_.principal().seat))
             << " calls=" << batch.calls.size() << " server=" << server << " refused=" << refusedCalls
             << " outcome=" << outcome << " duration_ms=" << elapsed.count();
  }

  std::vector<ToolResult> out;
  for (std::optional<ToolResult>& result : answered) out.push_back(std::move(*result));
  return out;
}

}

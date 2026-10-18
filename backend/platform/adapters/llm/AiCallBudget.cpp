#include "platform/adapters/llm/AiCallBudget.h"

#include "platform/application/WriteObservation.h"

#include <drogon/utils/Utilities.h>
#include <stdexcept>
#include <vector>

namespace wm {

std::optional<long long> anthropicReservationNanos(const Json::Value& request) {
  if (!request.isObject() || !request["model"].isString() || !request["max_tokens"].isInt64())
    return std::nullopt;
  const auto output = request["max_tokens"].asInt64();
  if (output <= 0 || output > 128'000) return std::nullopt;
  if (request.isMember("speed") || request.isMember("inference_geo") ||
      request.isMember("service_tier") || request.isMember("betas") || request.isMember("container"))
    return std::nullopt;
  if (request.isMember("tools")) {
    if (!request["tools"].isArray()) return std::nullopt;
    for (const auto& tool : request["tools"])
      if (!tool.isObject() || (tool.isMember("type") && tool["type"] != "custom"))
        return std::nullopt;
  }
  std::vector<const Json::Value*> values{&request};
  while (!values.empty()) {
    const auto* value = values.back();
    values.pop_back();
    if (!value->isObject() && !value->isArray()) continue;
    if (value->isObject() && value->isMember("cache_control")) {
      const auto& cache = (*value)["cache_control"];
      if (!cache.isObject() || cache["type"] != "ephemeral" ||
          (cache.isMember("ttl") && cache["ttl"] != "5m")) return std::nullopt;
    }
    for (const auto& child : *value) values.push_back(&child);
  }
  const std::string model = request["model"].asString();
  const bool supported = model == "claude-opus-5" || model == "claude-opus-4-8" ||
      model == "claude-opus-4-7" || model == "claude-opus-4-6" || model == "claude-fable-5" ||
      model == "claude-mythos-5" || model == "claude-sonnet-5" || model == "claude-sonnet-4-6" ||
      model == "claude-haiku-4-5" || model == "claude-haiku-4-5-20251001";
  if (!supported) return std::nullopt;
  return costNanos(model, TokenUse{0, output, 0, 1'000'000});
}

std::optional<long long> anthropicActualNanos(const std::string& model, const Json::Value& usage) {
  if (!usage.isObject()) return std::nullopt;
  for (const auto* field : {"input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"})
    if (!usage[field].isInt64() || usage[field].asInt64() < 0 || usage[field].asInt64() > 1'000'000)
      return std::nullopt;
  const auto tokens = tokensFrom(usage);
  if (tokens.input + tokens.cacheRead + tokens.cacheWrite > 1'000'000 || tokens.output > 128'000)
    return std::nullopt;
  if (usage.isMember("server_tool_use") && !usage["server_tool_use"].empty()) return std::nullopt;
  if (usage.isMember("cache_creation")) {
    const auto& cache = usage["cache_creation"];
    if (!cache.isObject() || !cache["ephemeral_1h_input_tokens"].isInt64() ||
        cache["ephemeral_1h_input_tokens"].asInt64() != 0) return std::nullopt;
  }
  return costNanos(model, tokens);
}

AiCallBudget::AiCallBudget(std::shared_ptr<AiBudgetService> budgets, Entitlements& entitlements,
                           AuthRepository& accounts, FailureReporter& failures)
    : budgets_(std::move(budgets)), entitlements_(entitlements), accounts_(accounts), failures_(failures) {}

AiCallAdmission AiCallBudget::begin(const AiSpend& spend, const Json::Value& request) {
  WriteObservation observation{"ai.call.admit", "platform", "vendor", "", &failures_};
  WriteContext context{observation};
  try {
    if (!spend.user) {
      observation.finish("device_verification_required");
      return {{}, "device_verification_required"};
    }
    const auto account = accounts_.findUserById(*spend.user);
    if (!account || account->deletedAt) {
      observation.finish("unauthenticated");
      return {{}, "unauthenticated"};
    }
    const auto amount = request["model"] == spend.model ? anthropicReservationNanos(request) : std::nullopt;
    if (!amount) {
      observation.finish("unsupported_ai_pricing");
      return {{}, "unsupported_ai_pricing"};
    }
    const auto principal = entitlements_.aiPrincipalFor(account->id, account->email.value);
    const auto reservation = budgets_->reserve(drogon::utils::getUuid(), principal, *amount);
    if (reservation.code != AiBudgetCode::Ok || !reservation.reservation) {
      const std::string code(aiBudgetCodeName(reservation.code));
      observation.finish(code);
      return {{}, code};
    }
    const auto dispatch = budgets_->markDispatched(reservation.reservation->id);
    if (dispatch.code != AiBudgetCode::Ok) {
      const std::string code(aiBudgetCodeName(dispatch.code));
      observation.finish(code);
      return {{}, code};
    }
    observation.finish();
    return {reservation.reservation, {}};
  } catch (const std::exception& error) {
    observation.fail(error);
    return {{}, "ai_accounting_unavailable"};
  } catch (...) {
    observation.failUnknown();
    return {{}, "ai_accounting_unavailable"};
  }
}

void AiCallBudget::finish(const AiBudgetReservation& reservation, const std::string& model,
                          const Json::Value& usage, bool complete) {
  WriteObservation observation{"ai.call.account", "platform", "vendor", "", &failures_};
  WriteContext context{observation};
  try {
    const auto amount = complete ? anthropicActualNanos(model, usage) : std::nullopt;
    const auto result = amount ? budgets_->settle(reservation.id, *amount) : budgets_->markUncertain(reservation.id);
    if (result.code != AiBudgetCode::Ok && result.code != AiBudgetCode::Replay)
      throw std::runtime_error("AI accounting transition refused");
    observation.finish(amount ? "settled" : "uncertain");
  } catch (const std::exception& error) {
    observation.fail(error);
  } catch (...) {
    observation.failUnknown();
  }
}

}

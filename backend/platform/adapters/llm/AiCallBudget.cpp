#include "platform/adapters/llm/AiCallBudget.h"
#include "platform/ai_installations/AiInstallations.h"

#include "platform/application/WriteObservation.h"

#include <drogon/utils/Utilities.h>
#include <trantor/utils/Logger.h>
#include <cstdint>
#include <stdexcept>
#include <vector>

namespace wm {

std::optional<long long> anthropicReservationNanos(const Json::Value& request) {
  if (!request.isObject() || !request["model"].isString() || !request["max_tokens"].isInt64())
    return std::nullopt;
  const auto maxOutputTokens = request["max_tokens"].asInt64();
  if (maxOutputTokens <= 0 || maxOutputTokens > 128'000) return std::nullopt;
  if (request.isMember("speed") || request.isMember("inference_geo") ||
      request.isMember("service_tier") || request.isMember("betas") || request.isMember("container"))
    return std::nullopt;
  const std::string model = request["model"].asString();
  const bool supported = model == "claude-opus-5" || model == "claude-opus-4-8" ||
      model == "claude-opus-4-7" || model == "claude-opus-4-6" || model == "claude-fable-5" ||
      model == "claude-mythos-5" || model == "claude-sonnet-5" || model == "claude-sonnet-4-6" ||
      model == "claude-haiku-4-5" || model == "claude-haiku-4-5-20251001";
  if (!supported) return std::nullopt;
  if (!request["messages"].isArray() || request["messages"].empty()) return std::nullopt;

  enum class Shape { Json, System, Messages, Message, Content, Block, SystemBlock, Tools, Tool, ImageSource };
  struct Item {
    const Json::Value* value;
    Shape shape = Shape::Json;
    unsigned depth = 0;
  };
  const bool highResolution = model != "claude-opus-4-6" && model != "claude-sonnet-4-6" &&
      model != "claude-haiku-4-5" && model != "claude-haiku-4-5-20251001";
  std::vector<Item> values{{&request}};
  std::uint64_t textBytes = 0;
  long long framingTokens = 32;
  long long imageTokens = 0;
  unsigned nodes = 0;
  bool cacheWrite = false;
  const auto addBytes = [&](std::uint64_t size) {
    if (size > 3'000'000 - textBytes) return false;
    textBytes += size;
    return true;
  };
  while (!values.empty()) {
    const auto item = values.back();
    values.pop_back();
    const auto& value = *item.value;
    if (++nodes > 100'000 || item.depth > 64) return std::nullopt;
    if (item.shape == Shape::Messages) {
      if (!value.isArray()) return std::nullopt;
      framingTokens += 8LL * value.size();
    }
    if (item.shape == Shape::Message && (!value.isObject() ||
        (value["role"] != "user" && value["role"] != "assistant") || !value.isMember("content")))
      return std::nullopt;
    if ((item.shape == Shape::System || item.shape == Shape::Content) &&
        !value.isString() && !value.isArray()) return std::nullopt;
    if (item.shape == Shape::Tools) {
      if (!value.isArray()) return std::nullopt;
      if (!value.empty()) framingTokens += 350;
    }
    if (item.shape == Shape::Tool && (!value.isObject() || !value["name"].isString() || value["name"].asString().empty() ||
        !value["input_schema"].isObject() || (value.isMember("description") && !value["description"].isString()) ||
        (value.isMember("type") && value["type"] != "custom"))) return std::nullopt;
    if (item.shape == Shape::Block || item.shape == Shape::SystemBlock) {
      if (!value.isObject() || !value["type"].isString()) return std::nullopt;
      const auto type = value["type"].asString();
      if (item.shape == Shape::SystemBlock && type != "text") return std::nullopt;
      if (type == "text") {
        if (!value["text"].isString()) return std::nullopt;
      } else if (type == "image") {
        if (!value["source"].isObject()) return std::nullopt;
        imageTokens += highResolution ? 4'784 : 1'568;
      } else if (type == "tool_use") {
        if (!value["id"].isString() || !value["name"].isString() || !value["input"].isObject()) return std::nullopt;
      } else if (type == "tool_result") {
        if (!value["tool_use_id"].isString() || (value.isMember("is_error") && !value["is_error"].isBool()))
          return std::nullopt;
      } else if (type == "thinking") {
        if (!value["thinking"].isString() || !value["signature"].isString()) return std::nullopt;
      } else if (type == "redacted_thinking") {
        if (!value["data"].isString()) return std::nullopt;
      } else return std::nullopt;
    }
    if (item.shape == Shape::ImageSource) {
      if (value["type"] != "base64" ||
          (value["media_type"] != "image/jpeg" && value["media_type"] != "image/png") || !value["data"].isString())
        return std::nullopt;
      const auto data = value["data"].asString();
      if (data.empty() || data.size() % 4 || data.size() > 6'990'508) return std::nullopt;
      const auto padding = data.ends_with("==") ? 2u : data.ends_with("=") ? 1u : 0u;
      if (data.size() / 4 * 3 - padding > 5 * 1024 * 1024) return std::nullopt;
      for (std::size_t index = 0; index < data.size() - padding; ++index) {
        const auto byte = data[index];
        if ((byte < 'A' || byte > 'Z') && (byte < 'a' || byte > 'z') &&
            (byte < '0' || byte > '9') && byte != '+' && byte != '/') return std::nullopt;
      }
    }
    const bool cachePosition = item.value == &request || item.shape == Shape::Tool ||
        item.shape == Shape::Block || item.shape == Shape::SystemBlock;
    if (cachePosition && value.isObject() && value.isMember("cache_control")) {
      const auto& cache = value["cache_control"];
      if (!cache.isObject() || cache["type"] != "ephemeral" ||
          (cache.isMember("ttl") && cache["ttl"] != "5m")) return std::nullopt;
      cacheWrite = true;
    }
    if ((value.isArray() || value.isObject()) &&
        static_cast<std::uint64_t>(nodes) + values.size() + value.size() > 100'000) return std::nullopt;
    if (value.isObject()) {
      if (!addBytes(2 + value.size())) return std::nullopt;
      for (const auto& name : value.getMemberNames()) {
        if (item.shape == Shape::ImageSource && name == "data") continue;
        if (!addBytes(name.size() + 3)) return std::nullopt;
        auto shape = Shape::Json;
        if (item.value == &request) {
          if (name == "messages") shape = Shape::Messages;
          if (name == "system") shape = Shape::System;
          if (name == "tools") shape = Shape::Tools;
        } else if (item.shape == Shape::Message && name == "content") shape = Shape::Content;
        else if (item.shape == Shape::Block && value["type"] == "tool_result" && name == "content") shape = Shape::Content;
        else if (item.shape == Shape::Block && value["type"] == "image" && name == "source") shape = Shape::ImageSource;
        values.push_back({&value[name], shape, item.depth + 1});
      }
    } else if (value.isArray()) {
      if (!addBytes(2 + value.size())) return std::nullopt;
      auto shape = item.shape == Shape::Messages ? Shape::Message : item.shape == Shape::Tools ? Shape::Tool :
          item.shape == Shape::System ? Shape::SystemBlock : item.shape == Shape::Content ? Shape::Block : Shape::Json;
      for (const auto& child : value) values.push_back({&child, shape, item.depth + 1});
    } else if (!addBytes(value.isString() ? value.asString().size() + 2 : value.isNull() ? 4 : value.asString().size())) {
      return std::nullopt;
    }
  }
  // Local approximation with text margin and framing; actual provider usage settles the charge.
  const auto inputTokens = static_cast<long long>((textBytes + 2) / 3) + framingTokens + imageTokens;
  if (inputTokens > 1'000'000) return std::nullopt;
  return costNanos(model, cacheWrite ? TokenUse{0, maxOutputTokens, 0, inputTokens}
                                   : TokenUse{inputTokens, maxOutputTokens, 0, 0});
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

std::optional<AiOutputBudget> anthropicOutputBudget(const Json::Value& request, int minOutputTokens) {
  const auto amount = anthropicReservationNanos(request);
  if (!amount || minOutputTokens <= 0) return std::nullopt;
  if (request.isMember("thinking") && (!request["thinking"].isObject() ||
      (request["thinking"]["type"] != "adaptive" && request["thinking"]["type"] != "disabled"))) return std::nullopt;
  const auto unit = costNanos(request["model"].asString(), TokenUse{0, 1, 0, 0});
  if (!unit) return std::nullopt;
  const auto maxTokens = request["max_tokens"].asInt();
  const AiOutputBudget offer{*amount - maxTokens * *unit, *unit, minOutputTokens, maxTokens};
  if (!offer.valid()) return std::nullopt;
  return offer;
}

AiCallBudget::AiCallBudget(std::shared_ptr<AiBudgetService> budgets, Entitlements& entitlements,
                           AuthRepository& accounts, FailureReporter& failures)
    : budgets_(std::move(budgets)), entitlements_(entitlements), accounts_(accounts), failures_(failures) {}

AiCallAdmission AiCallBudget::begin(const AiSpend& spend, const Json::Value& request, int minOutputTokens) {
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
    const auto principal = entitlements_.aiPrincipalFor(account->id, account->email.value);
    observation.skip();
    return admit(principal, spend, request, minOutputTokens);
  } catch (...) {
    observation.failUnknown();
    return {{}, "ai_accounting_unavailable"};
  }
}

AiCallAdmission AiCallBudget::beginInstallation(const AiInstallationPrincipal& installation, const AiSpend& spend,
                                                const Json::Value& request, int minOutputTokens) {
  if (spend.user) {
    WriteObservation observation{"ai.call.admit", "platform", "vendor", "", &failures_};
    observation.finish("invalid_installation_principal");
    return {{}, "invalid_installation_principal"};
  }
  return admit({{AiBudgetSubjectKind::Device, installation.id()}, AiBudgetTier::Anonymous}, spend, request, minOutputTokens);
}

AiCallAdmission AiCallBudget::admit(const AiBudgetPrincipal& principal, const AiSpend& spend,
                                    const Json::Value& request, int minOutputTokens) {
  WriteObservation observation{"ai.call.admit", "platform", "vendor", "", &failures_};
  WriteContext context{observation};
  try {
    const auto offer = minOutputTokens > 0 ? anthropicOutputBudget(request, minOutputTokens) : std::nullopt;
    const auto amount = offer ? std::optional<long long>{offer->costNanos(offer->maxTokens)} : anthropicReservationNanos(request);
    if (request["model"] != spend.model || !amount || minOutputTokens < 0 || (minOutputTokens > 0 && !offer)) {
      observation.finish("unsupported_ai_pricing");
      return {{}, "unsupported_ai_pricing"};
    }
    const auto reservation = budgets_->reserve(drogon::utils::getUuid(), principal, *amount, offer);
    if (offer) {
      LOG_INFO << "ai_output_admission input_nanos=" << offer->inputNanos
               << " output_token_nanos=" << offer->outputTokenNanos << " min_tokens=" << offer->minTokens
               << " max_tokens=" << offer->maxTokens << " selected_tokens="
               << (reservation.reservation ? offer->tokensFor(reservation.reservation->amountNanos).value_or(0) : 0)
               << " code=" << std::string(aiBudgetCodeName(reservation.code));
    }
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

#include "platform/adapters/json/AiBudgetJson.h"

namespace wm {

Json::Value aiAllowanceJson(const AiBudgetView& allowance) {
  Json::Value body(Json::objectValue);
  body["code"] = std::string(aiBudgetCodeName(allowance.code));
  body["currency"] = "USD";
  body["period"] = std::string(aiBudgetWindowName(allowance.window));
  body["tier"] = std::string(aiBudgetTierName(allowance.tier));
  body["configured"] = allowance.configured;
  body["limit"] = allowance.limitNanos ? Json::Value(formatAiUsd(*allowance.limitNanos)) : Json::Value();
  body["used"] = formatAiUsd(allowance.usedNanos);
  body["reserved"] = formatAiUsd(allowance.heldNanos);
  body["remaining"] = formatAiUsd(allowance.remainingNanos);
  body["resetsAtMs"] = allowance.resetsAtMs ? Json::Value(Json::Int64(*allowance.resetsAtMs)) : Json::Value();
  body["budgetResetsAtMs"] = allowance.budgetResetsAtMs ? Json::Value(Json::Int64(*allowance.budgetResetsAtMs)) : Json::Value();
  return body;
}

std::optional<AiBudgetView> aiAllowanceFromJson(const Json::Value& body) {
  if (!body.isObject() || body["currency"] != "USD" || !body["configured"].isBool() ||
      !body["used"].isString() || !body["reserved"].isString() || !body["remaining"].isString() ||
      (!body["limit"].isString() && !body["limit"].isNull())) return std::nullopt;
  std::optional<AiBudgetTier> tier;
  std::optional<AiBudgetCode> code;
  std::optional<AiBudgetWindow> window;
  for (const auto value : {AiBudgetTier::Anonymous, AiBudgetTier::LoggedIn, AiBudgetTier::WindmillOne})
    if (body["tier"] == std::string(aiBudgetTierName(value))) tier = value;
  for (const auto value : {AiBudgetCode::Ok, AiBudgetCode::FreeMonthExhausted, AiBudgetCode::FreeDayExhausted,
                           AiBudgetCode::SubjectExhausted, AiBudgetCode::DebtOutstanding, AiBudgetCode::Unconfigured,
                           AiBudgetCode::ConcurrencyExhausted, AiBudgetCode::DeviceBound, AiBudgetCode::FundingRequired})
    if (body["code"] == std::string(aiBudgetCodeName(value))) code = value;
  for (const auto value : {AiBudgetWindow::Lifetime, AiBudgetWindow::CalendarMonth, AiBudgetWindow::BillingPeriod})
    if (body["period"] == std::string(aiBudgetWindowName(value))) window = value;
  const auto limit = body["limit"].isString() ? parseAiUsd(body["limit"].asString()) : std::nullopt;
  const auto used = parseAiUsd(body["used"].asString());
  const auto reserved = parseAiUsd(body["reserved"].asString());
  const auto remaining = parseAiUsd(body["remaining"].asString());
  if (!tier || !code || !window || !used || !reserved || !remaining ||
      (!limit && !body["limit"].isNull())) return std::nullopt;
  std::optional<long long> reset;
  if (*window == AiBudgetWindow::Lifetime) {
    if (!body.isMember("resetsAtMs") || !body["resetsAtMs"].isNull()) return std::nullopt;
  } else if (body["resetsAtMs"].isInt64() && body["resetsAtMs"].asInt64() > 0) {
    reset = body["resetsAtMs"].asInt64();
    if (*window == AiBudgetWindow::CalendarMonth) {
      const auto month = AiBudgetPeriod::at(*reset - 1);
      if (!month || month->endMs != *reset) return std::nullopt;
    }
  } else if (*code != AiBudgetCode::FundingRequired || !body["resetsAtMs"].isNull()) {
    return std::nullopt;
  }
  std::optional<long long> budgetReset;
  if (body["budgetResetsAtMs"].isInt64() && body["budgetResetsAtMs"].asInt64() > 0)
    budgetReset = body["budgetResetsAtMs"].asInt64();
  else if (!body["budgetResetsAtMs"].isNull()) return std::nullopt;
  return AiBudgetView{*tier, body["configured"].asBool(), limit, *used, *reserved, *remaining, reset, *code, *window, budgetReset};
}

}

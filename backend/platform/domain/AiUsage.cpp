#include "platform/domain/AiUsage.h"

#include <array>
#include <cstddef>

namespace wm {
namespace {

// Nanos per token: the per-MTok USD rate times a thousand, so $5/MTok is 5000 nanos and nothing
// here needs a division to be exact.
struct ModelRate {
  const char* model;
  long long inputNanos;
  long long outputNanos;
};

constexpr std::array<ModelRate, 10> kRates{{
    {"claude-opus-5", 5'000, 25'000},
    {"claude-opus-4-8", 5'000, 25'000},
    {"claude-opus-4-7", 5'000, 25'000},
    {"claude-opus-4-6", 5'000, 25'000},
    {"claude-fable-5", 10'000, 50'000},
    {"claude-mythos-5", 10'000, 50'000},
    {"claude-sonnet-5", 3'000, 15'000},
    {"claude-sonnet-4-6", 3'000, 15'000},
    {"claude-haiku-4-5", 1'000, 5'000},
    {"claude-haiku-4-5-20251001", 1'000, 5'000},
}};

// True when everything after `at` is "-" followed by digits: the shape of a pinned snapshot.
bool datedSnapshot(const std::string& model, std::size_t at) {
  if (at + 1 >= model.size() || model[at] != '-') return false;
  for (std::size_t i = at + 1; i < model.size(); ++i) {
    if (model[i] < '0' || model[i] > '9') return false;
  }
  return true;
}

long long countAt(const Json::Value& usage, const char* field) {
  const Json::Value& value = usage[field];
  if (!value.isInt64()) return 0;
  const long long count = value.asInt64();
  return count > 0 ? count : 0;
}

}

TokenUse tokensFrom(const Json::Value& usage) {
  if (!usage.isObject()) return TokenUse{};
  return TokenUse{countAt(usage, "input_tokens"), countAt(usage, "output_tokens"),
                  countAt(usage, "cache_read_input_tokens"),
                  countAt(usage, "cache_creation_input_tokens")};
}

// An unpriced model is charged the dearest rate known, so the guess errs toward refusing. The
// ledger still stores NULL for the true cost.
long long floorCostNanos(const std::string& model, const TokenUse& tokens) {
  if (const std::optional<long long> known = costNanos(model, tokens)) return *known;
  long long dearest = 0;
  for (const ModelRate& rate : kRates) {
    const long long at = tokens.input * rate.inputNanos + tokens.output * rate.outputNanos +
                         tokens.cacheRead * (rate.inputNanos / 10) +
                         tokens.cacheWrite * (rate.inputNanos * 5 / 4);
    if (at > dearest) dearest = at;
  }
  return dearest;
}

std::optional<long long> costNanos(const std::string& model, const TokenUse& tokens) {
  const ModelRate* rate = nullptr;
  for (const ModelRate& candidate : kRates) {
    if (model != candidate.model) continue;
    rate = &candidate;
    break;
  }
  // A dated snapshot is priced as the alias it pins, so fall back to the longest matching prefix.
  // The remainder must be a date and nothing else, or a cheaper sibling would inherit this rate.
  if (!rate) {
    std::size_t matched = 0;
    for (const ModelRate& candidate : kRates) {
      const std::string name = candidate.model;
      if (model.rfind(name, 0) != 0 || name.size() <= matched) continue;
      if (!datedSnapshot(model, name.size())) continue;
      matched = name.size();
      rate = &candidate;
    }
  }
  if (!rate) return std::nullopt;

  // Cache modifiers ride on the input rate: a read is a tenth of it, a 5m-ephemeral write a
  // quarter more. Integer maths only — every rate is a multiple of 1000 nanos, so nothing is lost.
  return tokens.input * rate->inputNanos + tokens.output * rate->outputNanos +
         tokens.cacheRead * (rate->inputNanos / 10) + tokens.cacheWrite * (rate->inputNanos * 5 / 4);
}

}

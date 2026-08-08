#include "platform/domain/AiUsage.h"

#include <array>
#include <cstddef>

namespace wm {
namespace {

// Nanos per token, which is the per-MTok USD rate times a thousand — so $5/MTok is 5000 nanos and
// nothing here needs a division to become exact. One table, one place to edit when a rate moves.
// No validity dates: a cost is computed once and stored on its row, which is the immutability a
// from/until pair would only have approximated.
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

// True when everything after `at` is "-" followed by digits — the shape of a pinned snapshot, and
// deliberately nothing else.
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

// What a call costs when we cannot price it. Every spend CONTROL reads this rather than the optional
// above, because the alternative is charging an unknown model zero — and an unknown model charged
// zero is exactly the runaway nobody stops: it moves no ceiling and trips no fuse, so the one
// failure the ledger shouts about on screen is the one failure it silently permits. Priced at the
// dearest rate we know, so the guess errs toward refusing, which is the right way for a fuse to be
// wrong. The ledger still stores NULL for the true cost — "we did not price this" and "this cost
// nothing" are different facts, and only the display half is allowed to say the first one.
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
  // A dated snapshot ("claude-sonnet-5-20260114") is the same price as the alias it pins, so fall
  // back to the longest prefix that matches rather than calling a real, billed model unpriced. The
  // remainder must be a DATE and nothing else: a bare prefix rule cannot tell "-20260114" from
  // "-mini", so the day a cheaper or dearer sibling ships it would silently inherit this family's
  // rate and never light the unpriced badge — the one signal that says look at this.
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

  // Cache modifiers ride on the model's INPUT rate: a read is a tenth of it, a write (5m ephemeral,
  // the only kind we ever ask for) is a quarter more. Both as integer maths — every rate here is a
  // multiple of 1000 nanos, so neither division loses a nano.
  return tokens.input * rate->inputNanos + tokens.output * rate->outputNanos +
         tokens.cacheRead * (rate->inputNanos / 10) + tokens.cacheWrite * (rate->inputNanos * 5 / 4);
}

}

#include "platform/adapters/amplitude/AmplitudeUsageSink.h"

#include "platform/domain/AiUsage.h"

#include <json/json.h>

#include <chrono>
#include <utility>

namespace wm {
namespace {

// Amplitude needs a device_id or a user_id, and a server has neither.
constexpr const char* kServerDevice = "windmill-backend";

std::string propsOf(const AiSpend& spend) {
  Json::Value props(Json::objectValue);
  props["product"] = spend.product;
  props["operation"] = spend.operation;
  props["model"] = spend.model;
  props["outcome"] = spend.outcome;
  props["iteration"] = spend.iteration;
  props["input_tokens"] = static_cast<Json::Int64>(spend.tokens.input);
  props["output_tokens"] = static_cast<Json::Int64>(spend.tokens.output);
  props["cache_read_tokens"] = static_cast<Json::Int64>(spend.tokens.cacheRead);
  props["cache_write_tokens"] = static_cast<Json::Int64>(spend.tokens.cacheWrite);
  props["attributed"] = spend.user.has_value();

  // Dollars as a double, deliberately, and ONLY here. The ledger keeps integer nanos because money
  // that controls a ceiling must not round; the conversion happens at the edge that displays.
  const std::optional<long long> cost = costNanos(spend.model, spend.tokens);
  props["priced"] = cost.has_value();
  props["cost_usd"] = cost ? static_cast<double>(*cost) / 1'000'000'000.0 : 0.0;
  // What the ceilings were charged: an unpriced model gets a conservative floor, not zero.
  props["cost_floor_usd"] = static_cast<double>(floorCostNanos(spend.model, spend.tokens)) / 1'000'000'000.0;

  Json::StreamWriterBuilder builder;
  builder["indentation"] = "";
  return Json::writeString(builder, props);
}

}

AmplitudeUsageSink::AmplitudeUsageSink(std::shared_ptr<UsageSink> ledger,
                                       std::shared_ptr<AmplitudeClient> amplitude)
    : ledger_(std::move(ledger)), amplitude_(std::move(amplitude)) {}

void AmplitudeUsageSink::record(const AiSpend& spend) noexcept {
  // The ledger first and unconditionally; the mirror must never cost us a row. `record` is noexcept
  // on both sides, so nothing here escapes into the reply the user is owed.
  if (ledger_) ledger_->record(spend);
  if (!amplitude_) return;

  try {
    const std::int64_t atMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                                  std::chrono::system_clock::now().time_since_epoch())
                                  .count();
    // runId + iteration is unique per vendor call: two calls landing in the same millisecond would
    // otherwise share an insert_id and one would be dropped as a duplicate.
    const std::string seed = spend.runId + "/" + std::to_string(spend.iteration);
    amplitude_->forward(kServerDevice, spend.user, {FunnelEvent{"ai_spend", atMs, propsOf(spend)}},
                        seed);
  } catch (...) {
    // A mirror that throws would be a mirror that costs a reply. It cannot.
  }
}

}

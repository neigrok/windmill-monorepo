#include "platform/domain/AiFuse.h"
#include "platform/domain/AiUsage.h"

#include "test/testing.h"

#include <json/json.h>

#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <vector>

// The pure half of the meter: what a reply says it used, what that costs, and the two fuses that
// read those numbers. Everything here is arithmetic, so everything here is provable without a
// database, a vendor or a clock.
using namespace wm;

namespace {

Json::Value parse(const std::string& text) {
  Json::Value value;
  Json::CharReaderBuilder builder;
  std::string errors;
  const std::unique_ptr<Json::CharReader> reader{builder.newCharReader()};
  reader->parse(text.c_str(), text.c_str() + text.size(), &value, &errors);
  return value;
}

}

// The shape a real non-streaming reply carries, cache fields and all.
TEST(ai_usage_tokens_come_off_a_real_reply_in_all_four_buckets) {
  const Json::Value reply = parse(R"({
    "id": "msg_01",
    "model": "claude-sonnet-5",
    "stop_reason": "end_turn",
    "usage": {
      "input_tokens": 412,
      "output_tokens": 1180,
      "cache_read_input_tokens": 9024,
      "cache_creation_input_tokens": 2048
    }
  })");

  const TokenUse tokens = tokensFrom(reply["usage"]);
  CHECK_EQ(tokens.input, 412);
  CHECK_EQ(tokens.output, 1180);
  CHECK_EQ(tokens.cacheRead, 9024);
  CHECK_EQ(tokens.cacheWrite, 2048);
}

// A reply we cannot count is still a reply we must return. Every one of these is a shape a vendor
// or a proxy has produced at some point, and not one of them may throw.
TEST(ai_usage_an_unreadable_usage_object_counts_zero_and_never_throws) {
  const TokenUse absent = tokensFrom(Json::Value{});
  CHECK_EQ(absent.input, 0);
  CHECK_EQ(absent.output, 0);
  CHECK_EQ(absent.cacheRead, 0);
  CHECK_EQ(absent.cacheWrite, 0);

  const TokenUse null = tokensFrom(parse(R"({"usage": null})")["usage"]);
  CHECK_EQ(null.input, 0);
  CHECK_EQ(null.output, 0);

  const TokenUse notAnObject = tokensFrom(parse(R"({"usage": "1200"})")["usage"]);
  CHECK_EQ(notAnObject.input, 0);
  CHECK_EQ(notAnObject.output, 0);

  // Present, an object, and every field the wrong kind or missing.
  const TokenUse garbage = tokensFrom(parse(R"({
    "input_tokens": "many", "output_tokens": null, "cache_read_input_tokens": {"a": 1}
  })"));
  CHECK_EQ(garbage.input, 0);
  CHECK_EQ(garbage.output, 0);
  CHECK_EQ(garbage.cacheRead, 0);
  CHECK_EQ(garbage.cacheWrite, 0);

  // A partial object still yields the halves it does carry.
  const TokenUse partial = tokensFrom(parse(R"({"input_tokens": 30})"));
  CHECK_EQ(partial.input, 30);
  CHECK_EQ(partial.output, 0);
  CHECK_EQ(partial.cacheRead, 0);
  CHECK_EQ(partial.cacheWrite, 0);
}

// Each family, priced from fresh input and output alone: $5/$25, $10/$50, $3/$15, $1/$5 per MTok,
// which is 5000/25000, 10000/50000, 3000/15000 and 1000/5000 nanos a token.
TEST(ai_usage_each_model_family_prices_from_its_own_rate) {
  const TokenUse tokens{1000, 1000, 0, 0};

  CHECK_EQ(costNanos("claude-opus-5", tokens), std::optional<long long>(30'000'000));
  CHECK_EQ(costNanos("claude-opus-4-8", tokens), std::optional<long long>(30'000'000));
  CHECK_EQ(costNanos("claude-opus-4-7", tokens), std::optional<long long>(30'000'000));
  CHECK_EQ(costNanos("claude-opus-4-6", tokens), std::optional<long long>(30'000'000));
  CHECK_EQ(costNanos("claude-fable-5", tokens), std::optional<long long>(60'000'000));
  CHECK_EQ(costNanos("claude-mythos-5", tokens), std::optional<long long>(60'000'000));
  CHECK_EQ(costNanos("claude-sonnet-5", tokens), std::optional<long long>(18'000'000));
  CHECK_EQ(costNanos("claude-sonnet-4-6", tokens), std::optional<long long>(18'000'000));
  CHECK_EQ(costNanos("claude-haiku-4-5", tokens), std::optional<long long>(6'000'000));
  CHECK_EQ(costNanos("claude-haiku-4-5-20251001", tokens), std::optional<long long>(6'000'000));
}

// The modifiers ride on the model's INPUT rate: a read is a tenth of it, a 5m ephemeral write a
// quarter more. Both as integer maths — a double here would be a rounding error in money.
TEST(ai_usage_cache_reads_and_writes_price_off_the_input_rate) {
  // sonnet input is 3000 nanos a token, so a read is 300 and a write 3750.
  CHECK_EQ(costNanos("claude-sonnet-5", TokenUse{0, 0, 10'000, 0}),
           std::optional<long long>(3'000'000));
  CHECK_EQ(costNanos("claude-sonnet-5", TokenUse{0, 0, 0, 10'000}),
           std::optional<long long>(37'500'000));

  // All four buckets at once, which is what an actual cached call looks like.
  CHECK_EQ(costNanos("claude-sonnet-5", TokenUse{400, 1000, 8000, 2000}),
           std::optional<long long>(400 * 3000 + 1000 * 15000 + 8000 * 300 + 2000 * 3750));

  // opus input is 5000, so a read is 500 and a write 6250 — the ×1.25 is exact, not truncated.
  CHECK_EQ(costNanos("claude-opus-5", TokenUse{0, 0, 0, 4}), std::optional<long long>(25'000));
}

// Seams pin an alias; a deploy can pin the dated snapshot behind it. Both are the same billed model,
// and calling the dated one unpriced would blind the meter to a whole product overnight.
TEST(ai_usage_a_dated_snapshot_resolves_to_the_alias_it_pins) {
  const TokenUse tokens{1000, 1000, 0, 0};
  CHECK_EQ(costNanos("claude-sonnet-5-20260114", tokens), std::optional<long long>(18'000'000));
  CHECK_EQ(costNanos("claude-opus-5-20260301", tokens), std::optional<long long>(30'000'000));
  CHECK_EQ(costNanos("claude-haiku-4-5-20251001", tokens), std::optional<long long>(6'000'000));
}

// Unpriced must be LOUD. A model we have never priced returns nothing at all, so the row stores null
// and every total it lands in is marked a floor — rather than quietly counting as free.
TEST(ai_usage_a_model_we_cannot_price_returns_nothing_rather_than_zero) {
  const TokenUse tokens{1000, 1000, 0, 0};
  CHECK_FALSE(costNanos("gpt-4o", tokens).has_value());
  CHECK_FALSE(costNanos("", tokens).has_value());
  CHECK_FALSE(costNanos("claude", tokens).has_value());
  CHECK_FALSE(costNanos("claude-opus", tokens).has_value());
  CHECK_FALSE(costNanos("laude-opus-5", tokens).has_value());
}

// The whole reason the unit is nanos. In micro-dollars haiku input is 1 per 1000 tokens, so a
// 300-token compose truncates to ZERO — and a cache read at a tenth of that is ten times worse. The
// unit would have systematically zeroed exactly the cheap high-volume calls the meter exists to
// count, and the meter would have reported our cheapest product as costing nothing.
TEST(ai_usage_a_three_hundred_token_haiku_call_does_not_round_to_zero) {
  const std::optional<long long> input = costNanos("claude-haiku-4-5", TokenUse{300, 0, 0, 0});
  REQUIRE(input.has_value());
  CHECK_EQ(*input, 300'000);

  const std::optional<long long> cached = costNanos("claude-haiku-4-5", TokenUse{0, 0, 300, 0});
  REQUIRE(cached.has_value());
  CHECK_EQ(*cached, 30'000);
}

// The allowance is TendingAllowance's twin: at the limit the door is shut, and remaining never goes
// negative, because "you are 4 cents past your budget" is not a number anyone should have to render.
TEST(ai_usage_the_allowance_answers_under_at_and_over_the_limit) {
  const AiAllowance under{kFreeMonthlyAiNanos, 1'000'000'000};
  CHECK(under.allows());
  CHECK_EQ(under.remainingNanos(), 24'000'000'000);

  const AiAllowance at{kFreeMonthlyAiNanos, kFreeMonthlyAiNanos};
  CHECK_FALSE(at.allows());
  CHECK_EQ(at.remainingNanos(), 0);

  const AiAllowance over{kFreeMonthlyAiNanos, kFreeMonthlyAiNanos + 12'345};
  CHECK_FALSE(over.allows());
  CHECK_EQ(over.remainingNanos(), 0);

  const AiAllowance fresh;
  CHECK_FALSE(fresh.allows());
  CHECK_EQ(fresh.remainingNanos(), 0);

  CHECK_EQ(kFreeMonthlyAiNanos, 25'000'000'000);
  CHECK_EQ(kProMonthlyAiNanos, 50'000'000'000);
  CHECK_EQ(kSweepMonthlyAiNanos, 2'000'000'000);
  CHECK_EQ(kHourlyFuseNanos, 20'000'000'000);
}

// The window is trailing, not cumulative: spend that has aged out stops counting, or the fuse would
// blow once and stay blown for the life of the process.
TEST(ai_fuse_spend_older_than_the_window_stops_counting) {
  AiFuse fuse{1000, 100};

  fuse.spent(400, 1'000);
  CHECK_EQ(fuse.trailingNanos(1'000), 400);
  CHECK(fuse.allows());

  fuse.spent(400, 1'050);
  CHECK_EQ(fuse.trailingNanos(1'050), 800);
  CHECK(fuse.allows());

  // At exactly one window past the first sample, that sample is gone and the second is not.
  CHECK_EQ(fuse.trailingNanos(1'100), 400);
  // ...and one window past the second, nothing is left.
  CHECK_EQ(fuse.trailingNanos(1'150), 0);
  CHECK(fuse.allows());
}

// Over the ceiling it refuses, and it remembers that it refused — so the alert is sent once instead
// of on every blocked call in the storm that tripped it.
TEST(ai_fuse_refuses_over_the_ceiling_and_recovers_when_the_window_passes) {
  AiFuse fuse{1000, 100};
  CHECK(fuse.allows());
  CHECK_FALSE(fuse.tripped());

  fuse.spent(600, 1'000);
  CHECK(fuse.allows());
  CHECK_FALSE(fuse.tripped());

  fuse.spent(400, 1'010);  // exactly at the ceiling: the budget is spent, so the door is shut
  CHECK_EQ(fuse.trailingNanos(1'010), 1000);
  CHECK_FALSE(fuse.allows());
  CHECK(fuse.tripped());

  fuse.spent(5, 1'200);  // the two old samples age out as this one lands
  CHECK_EQ(fuse.trailingNanos(1'200), 5);
  CHECK(fuse.allows());
  CHECK(fuse.tripped());  // still true: it HAS refused, and that is what the flag says
}

// Five event-loop threads is the real deployment, so the accumulator has to be exact under all of
// them at once — a lost add is a dollar the fuse never sees.
TEST(ai_fuse_counts_every_concurrent_add_exactly) {
  AiFuse fuse{1'000'000'000, 1'000'000};

  std::vector<std::thread> threads;
  for (int t = 0; t < 5; ++t) {
    threads.emplace_back([&fuse] {
      for (int i = 0; i < 2000; ++i) {
        fuse.spent(7, 500'000);
        fuse.allows();
        fuse.trailingNanos(500'000);
      }
    });
  }
  for (std::thread& thread : threads) thread.join();

  CHECK_EQ(fuse.trailingNanos(500'000), 5 * 2000 * 7);
  CHECK(fuse.allows());
  CHECK_FALSE(fuse.tripped());
}

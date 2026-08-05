#include "platform/adapters/http/RateLimiter.h"

#include "test/testing.h"

#include <string>

using namespace wm;

TEST(rate_limiter_grants_the_burst_then_denies_the_next_call) {
  RateLimiter limiter{10.0 / 600.0, 5.0};  // the compose per-IP shape: ~10/10min, burst 5
  for (int i = 0; i < 5; ++i) CHECK(limiter.allow("203.0.113.7"));
  CHECK_FALSE(limiter.allow("203.0.113.7"));
  CHECK_FALSE(limiter.allow("203.0.113.7"));
}

TEST(rate_limiter_keys_are_independent) {
  RateLimiter limiter{10.0 / 600.0, 5.0};
  for (int i = 0; i < 5; ++i) CHECK(limiter.allow("203.0.113.7"));
  CHECK_FALSE(limiter.allow("203.0.113.7"));
  CHECK(limiter.allow("198.51.100.4"));
}

TEST(rate_limiter_global_key_caps_all_callers_together) {
  RateLimiter global{0.5, 3.0};
  CHECK(global.allow("global"));
  CHECK(global.allow("global"));
  CHECK(global.allow("global"));
  CHECK_FALSE(global.allow("global"));
}

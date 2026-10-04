#include "platform/domain/Auth.h"
#include "test/testing.h"

using namespace wm;

TEST(apple_ticket_lifetime_is_exactly_fifteen_minutes_with_an_exclusive_expiry_boundary) {
  constexpr UnixMs now = 1'700'000'000'000;
  const auto expires = appleTicketExpiry(now);
  CHECK_EQ(expires, now + 900'000);
  CHECK(verifyLink(true, false, expires, expires - 1) == LinkVerdict::valid);
  CHECK(verifyLink(true, false, expires, expires) == LinkVerdict::expired);
  CHECK(verifyLink(true, true, expires, now) == LinkVerdict::alreadyUsed);
  CHECK(verifyLink(false, false, expires, now) == LinkVerdict::unknown);
}

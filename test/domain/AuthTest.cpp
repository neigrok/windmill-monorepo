#include "domain/Auth.h"
#include "test/testing.h"

using namespace wm;

TEST(parse_email_normalizes_case_and_surrounding_space) {
  std::optional<Email> email = parseEmail("  Sam.Gold@Example.COM  ");
  CHECK(email.has_value());
  CHECK_EQ(email->value, std::string("sam.gold@example.com"));
}

TEST(parse_email_rejects_unfinished_addresses) {
  CHECK_FALSE(parseEmail("sam").has_value());            // no @
  CHECK_FALSE(parseEmail("sam@").has_value());           // no domain
  CHECK_FALSE(parseEmail("@example.com").has_value());   // no local part
  CHECK_FALSE(parseEmail("sam@example").has_value());    // domain has no dot
  CHECK_FALSE(parseEmail("sam@example.").has_value());   // trailing dot
  CHECK_FALSE(parseEmail("sam@.com").has_value());       // leading dot
  CHECK_FALSE(parseEmail("sam@@example.com").has_value());  // two @
  CHECK_FALSE(parseEmail("sam gold@example.com").has_value());  // interior space
  CHECK_FALSE(parseEmail("   ").has_value());            // blank
}

TEST(name_defaults_to_the_local_part) {
  CHECK_EQ(nameFromEmail(Email{"sam.gold@example.com"}), std::string("sam.gold"));
}

TEST(rate_limit_admits_up_to_the_cap_then_holds) {
  CHECK(withinRateLimit(0));
  CHECK(withinRateLimit(AuthPolicy::maxLinksPerWindow - 1));
  CHECK_FALSE(withinRateLimit(AuthPolicy::maxLinksPerWindow));
  CHECK_FALSE(withinRateLimit(AuthPolicy::maxLinksPerWindow + 1));
}

TEST(link_expiry_is_fifteen_minutes_out) {
  const UnixMs now = 1'700'000'000'000;
  CHECK_EQ(linkExpiry(now), now + 15ull * 60 * 1000);
}

TEST(session_expiry_is_ninety_days_out_and_lapses_at_the_boundary) {
  const UnixMs now = 1'700'000'000'000;
  const UnixMs expires = sessionExpiry(now);
  CHECK_EQ(expires, now + 90ull * 24 * 60 * 60 * 1000);
  CHECK_FALSE(sessionExpired(expires, now));
  CHECK_FALSE(sessionExpired(expires, expires - 1));
  CHECK(sessionExpired(expires, expires));       // now >= expiresAt is lapsed
  CHECK(sessionExpired(expires, expires + 1));
}

TEST(verify_link_distinguishes_every_outcome) {
  const UnixMs now = 1'000;
  CHECK(verifyLink(true, false, now + 1, now) == LinkVerdict::valid);
  CHECK(verifyLink(false, false, now + 1, now) == LinkVerdict::unknown);
  CHECK(verifyLink(true, true, now + 1, now) == LinkVerdict::alreadyUsed);
  CHECK(verifyLink(true, false, now, now) == LinkVerdict::expired);
  CHECK(verifyLink(true, false, now - 1, now) == LinkVerdict::expired);
  CHECK(verifyLink(true, true, now - 1, now) == LinkVerdict::alreadyUsed);  // used beats expired
}

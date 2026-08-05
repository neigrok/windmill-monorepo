#include "platform/domain/Auth.h"
#include "test/testing.h"

using namespace wm;

TEST(parse_email_normalizes_case_and_surrounding_space) {
  std::optional<Email> email = parseEmail("  Sam.Gold@Example.COM  ");
  REQUIRE(email.has_value());
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

TEST(a_name_still_derived_from_the_address_is_not_sharable) {
  const Email email{"sam.gold@example.com"};
  CHECK_EQ(sharableName(User{UserId{"u1"}, email, "sam.gold", std::nullopt}), std::string(""));
  CHECK_EQ(sharableName(User{UserId{"u1"}, email, "Sam Gold", std::nullopt}), std::string("Sam Gold"));
  CHECK_EQ(sharableName(User{UserId{"u1"}, email, "", std::nullopt}), std::string(""));
}

TEST(a_derived_name_is_caught_whatever_case_it_arrives_in) {
  const Email email{"sam.gold@example.com"};  // stored lowercased; a Google profile name is not
  CHECK_EQ(sharableName(User{UserId{"u1"}, email, "Sam.Gold", std::nullopt}), std::string(""));
  CHECK_EQ(sharableName(User{UserId{"u1"}, email, "SAM.GOLD", std::nullopt}), std::string(""));
  CHECK_EQ(sharableName(User{UserId{"u1"}, email, "Sam Gold", std::nullopt}), std::string("Sam Gold"));
}

TEST(a_name_that_could_rearrange_the_line_it_sits_in_is_refused) {
  CHECK_FALSE(parseName("Sam\aGold").has_value());       // a control character
  CHECK_FALSE(parseName("Sam\u202EGold").has_value());   // right-to-left override
  CHECK_FALSE(parseName("Sam\u200FGold").has_value());   // right-to-left mark
  CHECK_FALSE(parseName("Sam\u2068Gold").has_value());   // first strong isolate
  CHECK_FALSE(parseName("Sam\u0085Gold").has_value());   // a C1 control
  CHECK(parseName("Sam Gold").has_value());
  CHECK_EQ(*parseName("  Sam \u2014 Gold  "), std::string("Sam \u2014 Gold"));  // an em dash is fine
  CHECK_EQ(*parseName("  \u00DCnal G\u00F6l\u00E7  "), std::string("\u00DCnal G\u00F6l\u00E7"));  // so are real names
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

TEST(provider_names_round_trip_through_the_stored_spelling) {
  CHECK_EQ(toString(Provider::google), std::string("google"));
  CHECK_EQ(toString(Provider::apple), std::string("apple"));
  CHECK(parseProvider("google") == std::optional<Provider>{Provider::google});
  CHECK(parseProvider("apple") == std::optional<Provider>{Provider::apple});
  CHECK_FALSE(parseProvider("Apple").has_value());  // the column's check constraint is lowercase
  CHECK_FALSE(parseProvider("").has_value());
  CHECK_FALSE(parseProvider("facebook").has_value());
}

TEST(the_apple_relay_domain_is_recognised_and_nothing_else_is) {
  CHECK(isPrivateRelay(Email{"abc123@privaterelay.appleid.com"}));
  CHECK_FALSE(isPrivateRelay(Email{"sam@example.com"}));
  CHECK_FALSE(isPrivateRelay(Email{"sam@appleid.com"}));
  CHECK_FALSE(isPrivateRelay(Email{"sam@privaterelay.appleid.com.example.com"}));
  // The suffix alone is not an address — a bare domain names no human.
  CHECK_FALSE(isPrivateRelay(Email{"@privaterelay.appleid.com"}));
}

// The whole trust ladder as a table. Only `unusable` refuses; `appOnly` is a full sign-in that also
// tells the client to offer the link door, because a relay can never find the human's web account.
TEST(address_trust_separates_refusal_from_the_link_door) {
  ProviderIdentity real{Provider::google, "g-1", Email{"sam@example.com"}, "Sam", true, false};
  CHECK(trustOf(real) == AddressTrust::crossDoor);

  ProviderIdentity relayByDomain{Provider::apple, "a-1", Email{"abc@privaterelay.appleid.com"}, "", true, false};
  CHECK(trustOf(relayByDomain) == AddressTrust::appOnly);

  // The provider's own claim stands even on an address whose domain we don't recognise, so a future
  // relay domain can't quietly downgrade to crossDoor.
  ProviderIdentity relayByClaim{Provider::apple, "a-2", Email{"abc@newrelay.example"}, "", true, true};
  CHECK(trustOf(relayByClaim) == AddressTrust::appOnly);

  ProviderIdentity unverified = real;
  unverified.emailVerified = false;
  CHECK(trustOf(unverified) == AddressTrust::unusable);

  ProviderIdentity unparseable{Provider::apple, "a-3", Email{"sam@example"}, "", true, false};
  CHECK(trustOf(unparseable) == AddressTrust::unusable);
}

#include "platform/domain/Auth.h"
#include "test/testing.h"

#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

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

// The mail copy ("6-digit", "works once and lasts 15 minutes") and the app door's field are built on these numbers.
TEST(the_code_is_six_digits_with_five_attempts_on_the_links_own_clock) {
  CHECK_EQ(AuthPolicy::codeLength, 6);
  CHECK_EQ(AuthPolicy::maxCodeAttempts, 5);
}

// The lookup owns liveness, so the verdict decides only what is left: no live row and a wrong guess differ because only the wrong guess spends an attempt.
TEST(verify_code_distinguishes_a_wrong_guess_from_no_live_code) {
  CHECK(verifyCode(true, true) == CodeVerdict::valid);
  CHECK(verifyCode(true, false) == CodeVerdict::wrongCode);
  CHECK(verifyCode(false, false) == CodeVerdict::noLiveCode);
  CHECK(verifyCode(false, true) == CodeVerdict::noLiveCode);  // a match against no row is no match
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
  CHECK_FALSE(isPrivateRelay(Email{"@privaterelay.appleid.com"}));
}

// Only `unusable` refuses; `appOnly` is a full sign-in that also tells the client to offer the link door.
TEST(address_trust_separates_refusal_from_the_link_door) {
  ProviderIdentity real{Provider::google, "g-1", Email{"sam@example.com"}, "Sam", true, false};
  CHECK(trustOf(real) == AddressTrust::crossDoor);

  ProviderIdentity relayByDomain{Provider::apple, "a-1", Email{"abc@privaterelay.appleid.com"}, "", true, false};
  CHECK(trustOf(relayByDomain) == AddressTrust::appOnly);

  ProviderIdentity relayByClaim{Provider::apple, "a-2", Email{"abc@newrelay.example"}, "", true, true};
  CHECK(trustOf(relayByClaim) == AddressTrust::appOnly);

  ProviderIdentity unverified = real;
  unverified.emailVerified = false;
  CHECK(trustOf(unverified) == AddressTrust::unusable);

  ProviderIdentity unparseable{Provider::apple, "a-3", Email{"sam@example"}, "", true, false};
  CHECK(trustOf(unparseable) == AddressTrust::unusable);
}

// Every refusal refusalOf answers for `domains`, one per line: the Domain as given, then why, or "scope" for none.
static std::string refusalsOf(const std::vector<std::string>& domains) {
  std::string text;
  for (const std::string& domain : domains) text += SessionCookieScopes::refusalOf(domain).value_or("\"" + domain + "\" scope") + "\n";
  return text;
}

TEST(a_session_cookie_domain_is_a_bare_host_name_under_a_registrable_domain_or_empty_for_host_only) {
  CHECK_EQ(refusalsOf({"", " \t", "windmill.works", ".windmill.works", "app.windmill.works", " \tWindmill.Works\t ", "xn--bcher-kva.example",
                       "a-b.c-d.example", "sync-probe.test", "localhost.example", "1password.com", "example.0x1g"}),
           std::string("\"\" scope\n"
                       "\" \t\" scope\n"
                       "\"windmill.works\" scope\n"
                       "\".windmill.works\" scope\n"
                       "\"app.windmill.works\" scope\n"
                       "\" \tWindmill.Works\t \" scope\n"
                       "\"xn--bcher-kva.example\" scope\n"
                       "\"a-b.c-d.example\" scope\n"
                       "\"sync-probe.test\" scope\n"
                       "\"localhost.example\" scope\n"
                       "\"1password.com\" scope\n"
                       "\"example.0x1g\" scope\n"));
}

TEST(a_session_cookie_domain_with_no_registrable_domain_or_that_is_not_a_bare_host_name_is_refused) {
  CHECK_EQ(refusalsOf({"localhost", ".localhost", "localhost.", "intranet", "app.localhost", "App.LocalHost", "127.0.0.1", "10.0.0.07",
                       "1.2.3", "host.0x7f", "host.0X7F", "::1", "[::1]", "2001:db8::1",
                       "windmill.works:443", "windmill works", "windmill.works\n", "windmill.works\r", "\nwindmill.works", "windmill.works\v",
                       "windmill\x7F.works", "windmill_works.com", "windmill.works/", "..windmill.works", "windmill..works", "windmill.works.",
                       ".", "é.example", "windmill.works;x=1"}),
           std::string("\"localhost\" is a single label, with no registrable domain\n"
                       "\".localhost\" is a single label, with no registrable domain\n"
                       "\"localhost.\" has an empty label\n"
                       "\"intranet\" is a single label, with no registrable domain\n"
                       "\"app.localhost\" ends in the label localhost, with no registrable domain\n"
                       "\"App.LocalHost\" ends in the label localhost, with no registrable domain\n"
                       "\"127.0.0.1\" is an IP address\n"
                       "\"10.0.0.07\" is an IP address\n"
                       "\"1.2.3\" is an IP address\n"
                       "\"host.0x7f\" is an IP address\n"
                       "\"host.0X7F\" is an IP address\n"
                       "\"::1\" is an IP address\n"
                       "\"[::1]\" is an IP address\n"
                       "\"2001:db8::1\" is an IP address\n"
                       "\"windmill.works:443\" is not a bare host name\n"
                       "\"windmill works\" is not a bare host name\n"
                       "\"windmill.works\n\" is not a bare host name\n"
                       "\"windmill.works\r\" is not a bare host name\n"
                       "\"\nwindmill.works\" is not a bare host name\n"
                       "\"windmill.works\v\" is not a bare host name\n"
                       "\"windmill\x7F.works\" is not a bare host name\n"
                       "\"windmill_works.com\" is not a bare host name\n"
                       "\"windmill.works/\" is not a bare host name\n"
                       "\"..windmill.works\" has an empty label\n"
                       "\"windmill..works\" has an empty label\n"
                       "\"windmill.works.\" has an empty label\n"
                       "\".\" has an empty label\n"
                       "\"é.example\" is not a bare host name\n"
                       "\"windmill.works;x=1\" is not a bare host name\n"));
}

TEST(the_session_cookie_scopes_are_the_live_domain_first_then_host_only_then_each_retired_domain_once_trimmed) {
  const SessionCookieScopes scopes(" \twindmill.works\t", " api.windmill.works, .WINDMILL.works ,,\t\t, old.example ,API.windmill.works");
  CHECK_EQ(scopes.all(), (std::vector<std::string>{"windmill.works", "", "api.windmill.works", "old.example"}));
  CHECK_EQ(scopes.live(), std::string("windmill.works"));
  CHECK_EQ(std::vector<std::string>(scopes.others().begin(), scopes.others().end()),
           (std::vector<std::string>{"", "api.windmill.works", "old.example"}));
  CHECK_EQ(SessionCookieScopes("", "").all(), (std::vector<std::string>{""}));
  CHECK_EQ(SessionCookieScopes("windmill.works", ".windmill.works").all(), (std::vector<std::string>{"windmill.works", ""}));
  CHECK_EQ(SessionCookieScopes(".Windmill.Works", "windmill.works, WINDMILL.WORKS, .windmill.works").all(),
           (std::vector<std::string>{".Windmill.Works", ""}));
  CHECK_EQ(SessionCookieScopes(" ", "windmill.works").all(), (std::vector<std::string>{"", "windmill.works"}));
}

TEST(the_session_cookie_scopes_refuse_to_exist_with_a_domain_that_is_not_a_scope_live_or_retired) {
  const auto refusalOf = [](std::string_view domain, std::string_view retired) -> std::string {
    try {
      SessionCookieScopes(domain, retired);
      return "none";
    } catch (const std::invalid_argument& refused) {
      return refused.what();
    }
  };
  CHECK_EQ(refusalOf("localhost", ""), std::string("the session cookie's Domain \"localhost\" is a single label, with no registrable domain"));
  CHECK_EQ(refusalOf("windmill.works", "old.example, 127.0.0.1"), std::string("the session cookie's Domain \" 127.0.0.1\" is an IP address"));
  CHECK_EQ(refusalOf("windmill.works\n", ""), std::string("the session cookie's Domain \"windmill.works\n\" is not a bare host name"));
  CHECK_EQ(refusalOf("windmill.works", "old.example"), std::string("none"));
}


#include "platform/domain/sync/Credentials.h"

#include "platform/domain/sync/Wire.h"
#include "test/testing.h"

#include <optional>
#include <string>
#include <vector>

// What envelope/credentials.json does not pin about §9.1 Credentials: how a header line is read as received (the bytes
// after its colon, whitespace included), how a Cookie piece and an Authorization value are read at their edges, that
// two of one kind are refused before any token is resolved, that every token is held as its digest from the parse on,
// which credentials fail, and which session a credential that resolves is served through.

using namespace wm;
using namespace wm::sync;

namespace {

// The credentials `occurrences` send, one per line: the kind, then the token or `-` for none. Each is held as the token
// itself, so a line reads the token as it was sent.
std::string sentText(const HeaderOccurrences& occurrences) {
  std::string text;
  const SentCredentials sent = SentCredentials::fromOccurrences(occurrences, [](const std::string& token) { return token; });
  for (const SentCredential& credential : sent.each()) {
    text += credential.kind == SentCredential::Kind::authorization ? "authorization " : "cookie ";
    text += credential.digest.value_or("-") + "\n";
  }
  return text;
}

}

TEST(a_header_line_is_read_as_received_with_space_and_tab_trimmed_around_its_value_and_nothing_else) {
  CHECK_EQ(sentText({{"Cookie", " \t wm_session=a \t "}, {"Authorization", "  Bearer b\t"}}), std::string("cookie a\nauthorization b\n"));
  CHECK_EQ(sentText({{"Authorization", "Bearer b\r"}}), std::string("authorization b\r\n"));
  CHECK_EQ(sentText({{"Authorization", "\x0B" "Bearer b"}}), std::string("authorization -\n"));
  CHECK_EQ(sentText({{"Cookie", "wm_session=a\x0C"}}), std::string("cookie a\x0C\n"));
}

TEST(a_header_name_folds_ascii_letters_alone_and_is_read_as_sent) {
  CHECK_EQ(sentText({{"COOKIE", "wm_session=a"}, {"aUtHoRiZaTiOn", "Bearer b"}}), std::string("cookie a\nauthorization b\n"));
  CHECK_EQ(sentText({{"Coo\xE2\x84\xAAie", "wm_session=a"}, {"Cookie ", "wm_session=b"}, {" Authorization", "Bearer c"}}), std::string());
  CHECK_EQ(sentText({{"X-Cookie", "wm_session=a"}, {"Authorizations", "Bearer b"}}), std::string());
}

TEST(a_cookie_piece_is_named_after_trimming_and_its_token_is_everything_after_the_first_equals_sign_trimmed) {
  CHECK_EQ(sentText({{"Cookie", "theme=dark;wm_session=a=b;  wm_session =c ;\twm_session=\t d"}}),
           std::string("cookie a=b\ncookie c\ncookie d\n"));
  CHECK_EQ(sentText({{"Cookie", "wm_session_old=a; WM_SESSION=b; xwm_session=c; wm_session"}}), std::string("cookie -\n"));
  CHECK_EQ(sentText({{"Cookie", ";;wm_session=;"}}), std::string("cookie -\n"));
  CHECK_EQ(sentText({{"Cookie", "wm_session= \t "}}), std::string("cookie -\n"));
}

TEST(only_space_and_tab_are_whitespace_a_no_break_space_is_part_of_the_name_or_the_token) {
  CHECK_EQ(sentText({{"Cookie", "wm_session=\xC2\xA0" "a"}}), std::string("cookie \xC2\xA0" "a\n"));
  CHECK_EQ(sentText({{"Cookie", "wm_session=\xA0" "a\xA0"}}), std::string("cookie \xA0" "a\xA0\n"));
  CHECK_EQ(sentText({{"Cookie", "\xA0" "wm_session=a"}, {"Cookie", "\xC2\xA0" "wm_session=b"}}), std::string());
  CHECK_EQ(sentText({{"Authorization", "Bearer a\xA0" "b"}}), std::string("authorization a\xA0" "b\n"));
}

TEST(an_authorization_value_carries_a_token_only_as_bearer_one_space_and_no_space_or_tab_after) {
  CHECK_EQ(sentText({{"Authorization", "bEaReR t-1"}}), std::string("authorization t-1\n"));
  CHECK_EQ(sentText({{"Authorization", "Bearer  t-1"}}), std::string("authorization -\n"));
  CHECK_EQ(sentText({{"Authorization", "Bearer t 1"}}), std::string("authorization -\n"));
  CHECK_EQ(sentText({{"Authorization", "Bearer t\t1"}}), std::string("authorization -\n"));
  CHECK_EQ(sentText({{"Authorization", "Bearer\tt-1"}}), std::string("authorization -\n"));
  CHECK_EQ(sentText({{"Authorization", "Bearert-1"}}), std::string("authorization -\n"));
  CHECK_EQ(sentText({{"Authorization", "Bearer "}}), std::string("authorization -\n"));
  CHECK_EQ(sentText({{"Authorization", ""}}), std::string("authorization -\n"));
  CHECK_EQ(sentText({{"Authorization", "Bearer \"t-1\""}}), std::string("authorization \"t-1\"\n"));
}

TEST(two_credentials_of_one_kind_are_refused_before_any_token_is_resolved) {
  std::vector<std::string> resolved;
  const ResolveDigest resolve = [&resolved](const std::string& digest) -> std::optional<UserId> {
    resolved.push_back(digest);
    return UserId{"A"};
  };
  const DigestOf digestOf = [](const std::string& token) { return "digest-" + token; };
  const Credential twoCookies = SentCredentials::fromOccurrences({{"Cookie", "wm_session=a; wm_session=b"}}, digestOf).resolve(resolve);
  const Credential twoHeaders =
      SentCredentials::fromOccurrences({{"Authorization", "Bearer a"}, {"Authorization", "Basic b"}}, digestOf).resolve(resolve);
  CHECK(twoCookies.fails());
  CHECK(twoHeaders.fails());
  CHECK(resolved.empty());

  const Credential both = SentCredentials::fromOccurrences({{"Authorization", "Bearer a"}, {"Cookie", "wm_session=b"}}, digestOf).resolve(resolve);
  CHECK_FALSE(both.fails());
  CHECK(both.servedAs() == UserId{"A"});
  CHECK_EQ(resolved, (std::vector<std::string>{"digest-a", "digest-b"}));
}

TEST(every_token_is_held_as_its_digest_from_the_parse_on_and_each_credential_keeps_its_place) {
  std::vector<std::string> digested;
  const SentCredentials sent = SentCredentials::fromOccurrences({{"Cookie", "wm_session=a; wm_session"}, {"Authorization", "Bearer b"}},
                                                                [&digested](const std::string& token) {
                                                                  digested.push_back(token);
                                                                  return "digest-" + token;
                                                                });
  CHECK(sent == SentCredentials({{SentCredential::Kind::cookie, "digest-a"},
                                 {SentCredential::Kind::cookie, std::nullopt},
                                 {SentCredential::Kind::authorization, "digest-b"}}));
  CHECK_EQ(digested, (std::vector<std::string>{"a", "b"}));
}

TEST(a_credential_fails_only_when_sent_and_resolving_to_no_account_or_to_one_outside_the_form) {
  CHECK_FALSE(Credential::none().fails());
  CHECK(Credential::none().servedAs() == std::nullopt);
  CHECK_FALSE(Credential::sent(UserId{"A"}).fails());
  CHECK(Credential::sent(UserId{"A"}).servedAs() == UserId{"A"});
  CHECK(Credential::sent(std::nullopt).fails());
  CHECK(Credential::sent(UserId{std::string(kAccountIdBytes + 1, 'a')}).fails());
  CHECK(Credential::sent(UserId{"A\"B"}).fails());
}

TEST(a_credential_is_served_through_the_digest_of_the_cookie_s_session_when_one_is_sent_else_the_authorization_s) {
  const ResolveDigest resolve = [](const std::string& digest) -> std::optional<UserId> {
    if (digest == "digest-gone") return std::nullopt;
    return UserId{"A"};
  };
  const auto sessionOf = [&resolve](const HeaderOccurrences& occurrences) {
    return SentCredentials::fromOccurrences(occurrences, [](const std::string& token) { return "digest-" + token; }).resolve(resolve).session();
  };
  CHECK(sessionOf({{"Authorization", "Bearer a"}}) == std::optional<std::string>("digest-a"));
  CHECK(sessionOf({{"Authorization", "bearer a"}}) == std::optional<std::string>("digest-a"));
  CHECK(sessionOf({{"Cookie", "wm_session=b"}}) == std::optional<std::string>("digest-b"));
  CHECK(sessionOf({{"Authorization", "Bearer a"}, {"Cookie", "wm_session=b"}}) == std::optional<std::string>("digest-b"));
  CHECK(sessionOf({{"Cookie", "wm_session=b"}, {"Authorization", "Bearer a"}}) == std::optional<std::string>("digest-b"));
  CHECK(sessionOf({{"Cookie", "wm_session=gone"}, {"Authorization", "Bearer a"}}) == std::nullopt);
  CHECK(sessionOf({}) == std::nullopt);
  CHECK(Credential::sent(UserId{"A"}).session() == std::nullopt);
}

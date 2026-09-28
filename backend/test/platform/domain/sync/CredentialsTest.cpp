#include "platform/domain/sync/Credentials.h"

#include "platform/domain/sync/Wire.h"
#include "test/testing.h"

#include <map>
#include <optional>
#include <string>
#include <vector>

// What envelope/credentials.json does not pin about §9.1 Credentials: how a Cookie piece and an Authorization value are
// read at their edges, that two of one kind are refused before any token is resolved, and which credentials fail.

using namespace wm;
using namespace wm::sync;

namespace {

// The credentials `headers` send, one per line: the kind, then the token or `-` for none.
std::string sentText(const HeaderFields& headers) {
  std::string text;
  for (const SentCredential& credential : sentCredentialsOf(headers)) {
    text += credential.kind == SentCredential::Kind::authorization ? "authorization " : "cookie ";
    text += credential.token.value_or("-") + "\n";
  }
  return text;
}

}

TEST(a_cookie_piece_is_named_after_trimming_and_its_token_is_everything_after_the_first_equals_sign) {
  CHECK_EQ(sentText({{"Cookie", "theme=dark;wm_session=a=b;  wm_session =c ;\twm_session=\t d"}}),
           std::string("cookie a=b\ncookie c\ncookie \t d\n"));
  CHECK_EQ(sentText({{"Cookie", "wm_session_old=a; WM_SESSION=b; xwm_session=c; wm_session"}}), std::string("cookie -\n"));
  CHECK_EQ(sentText({{"Cookie", ";;wm_session=;"}}), std::string("cookie -\n"));
  CHECK_EQ(sentText({{"COOKIE", "wm_session=a"}, {"X-Cookie", "wm_session=b"}}), std::string("cookie a\n"));
}

TEST(a_no_break_space_is_whitespace_as_the_reference_reads_a_latin_1_header) {
  CHECK_EQ(sentText({{"Cookie", "theme=dark;\xA0" "wm_session=a\xA0"}}), std::string("cookie a\n"));
  CHECK_EQ(sentText({{"Cookie", "wm_session\xA0"}}), std::string("cookie -\n"));
  CHECK_EQ(sentText({{"Cookie", "\xC2\xA0" "wm_session=a"}}), std::string());
  CHECK_EQ(sentText({{"Authorization", "Bearer a\xA0" "b"}}), std::string("authorization -\n"));
  CHECK_EQ(sentText({{"Authorization", "Bearer \x0B"}}), std::string("authorization -\n"));
}

TEST(an_authorization_value_carries_a_token_only_as_bearer_one_space_and_no_whitespace_after) {
  CHECK_EQ(sentText({{"Authorization", "bEaReR t-1"}}), std::string("authorization t-1\n"));
  CHECK_EQ(sentText({{"Authorization", "Bearer  t-1"}}), std::string("authorization -\n"));
  CHECK_EQ(sentText({{"Authorization", "Bearer t 1"}}), std::string("authorization -\n"));
  CHECK_EQ(sentText({{"Authorization", "Bearer\tt-1"}}), std::string("authorization -\n"));
  CHECK_EQ(sentText({{"Authorization", "Bearert-1"}}), std::string("authorization -\n"));
  CHECK_EQ(sentText({{"Authorization", "Bearer "}}), std::string("authorization -\n"));
  CHECK_EQ(sentText({{"Authorization", ""}}), std::string("authorization -\n"));
  CHECK_EQ(sentText({{"Authorization", "Bearer \"t-1\""}}), std::string("authorization \"t-1\"\n"));
}

TEST(two_credentials_of_one_kind_are_refused_before_any_token_is_resolved) {
  std::vector<std::string> resolved;
  const ResolveToken resolve = [&resolved](const std::string& token) -> std::optional<UserId> {
    resolved.push_back(token);
    return UserId{"A"};
  };
  const Credential twoCookies = credentialOf(sentCredentialsOf({{"Cookie", "wm_session=a; wm_session=b"}}), resolve);
  const Credential twoHeaders = credentialOf(sentCredentialsOf({{"Authorization", "Bearer a"}, {"Authorization", "Basic b"}}), resolve);
  CHECK(twoCookies.fails());
  CHECK(twoHeaders.fails());
  CHECK(resolved.empty());

  const Credential both = credentialOf(sentCredentialsOf({{"Authorization", "Bearer a"}, {"Cookie", "wm_session=b"}}), resolve);
  CHECK_FALSE(both.fails());
  CHECK(both.servedAs() == UserId{"A"});
  CHECK_EQ(resolved, (std::vector<std::string>{"a", "b"}));
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

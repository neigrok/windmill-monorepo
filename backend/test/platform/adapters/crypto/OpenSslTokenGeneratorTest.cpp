#include "platform/adapters/crypto/OpenSslTokenGenerator.h"

#include "platform/domain/Auth.h"
#include "test/testing.h"

#include <string>

using namespace wm;

TEST(mint_code_is_always_exactly_six_decimal_digits) {
  OpenSslTokenGenerator tokens;
  for (int i = 0; i < 2000; ++i) {
    const std::string code = tokens.mintCode();
    REQUIRE_EQ(code.size(), static_cast<std::size_t>(AuthPolicy::codeLength));
    for (char c : code) CHECK(c >= '0' && c <= '9');
  }
}

TEST(mint_code_favours_no_digit) {
  // 256 % 10 != 0, so a plain byte % 10 would over-produce 0-5. The sampler rejects 250-255 and resamples; over 24000 digits each is expected 2400 times, and the 1800 floor sits ~13 sigma below.
  OpenSslTokenGenerator tokens;
  int seen[10] = {0};
  for (int i = 0; i < 4000; ++i)
    for (char c : tokens.mintCode()) ++seen[c - '0'];
  for (int digit = 0; digit < 10; ++digit) CHECK(seen[digit] > 1800);
}

TEST(a_minted_code_digests_like_any_other_secret) {
  // The row stores digestOf(code) beside the link's digest — same hash, same 64-hex shape.
  OpenSslTokenGenerator tokens;
  const std::string digest = tokens.digestOf(tokens.mintCode());
  CHECK_EQ(digest.size(), std::size_t{64});
  for (char c : digest) CHECK((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'));
}

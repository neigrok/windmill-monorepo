#include "platform/domain/sync/Wire.h"

#include "test/testing.h"

#include <optional>
#include <string>

// What the golden corpus does not pin about §9.1's account id form: the byte bound counted in UTF-8 rather than in
// characters, each character jcs escapes, and a text that is not UTF-8.

using namespace wm;
using namespace wm::sync;

TEST(an_account_id_is_at_most_account_id_bytes_of_utf8_holding_no_character_jcs_escapes) {
  CHECK(isAccountId("00000000-0000-4000-8000-000000000041"));
  CHECK(isAccountId(std::string(kAccountIdBytes, 'a')));
  CHECK_FALSE(isAccountId(std::string(kAccountIdBytes + 1, 'a')));
  std::string accented;
  for (std::size_t i = 0; i < kAccountIdBytes / 2; ++i) accented += "\xC3\xA9";
  CHECK(isAccountId(accented));
  CHECK_FALSE(isAccountId(accented + "\xC3\xA9"));
  CHECK(isAccountId("del\x7F" "and space"));
  CHECK_FALSE(isAccountId("quote\""));
  CHECK_FALSE(isAccountId("back\\slash"));
  CHECK_FALSE(isAccountId("new\nline"));
  CHECK_FALSE(isAccountId(std::string("nul\0", 4)));
  CHECK_FALSE(isAccountId("\xC3"));
  CHECK_FALSE(isAccountId("\xED\xA0\x80"));
}


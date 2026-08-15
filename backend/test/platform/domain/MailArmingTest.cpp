#include "platform/domain/MailArming.h"
#include "test/testing.h"

#include <string>

using namespace wm;

// The dark-launch truth table, once. Two products used to carry a copy each — roadmap's
// ReminderArming and journal's NudgeArming — and the copies had drifted into opposite answers on
// the empty list and on id casing before anyone read them side by side. Every case both files had
// is here, and there is exactly one struct for it to be true of.

TEST(arming_defaults_to_nobody) {
  const MailArming dark;

  CHECK_FALSE(dark.enabled);
  CHECK_EQ(dark.allowlist.size(), std::size_t{0});
  CHECK_FALSE(dark.allows(UserId{"u1"}));
}

TEST(the_allowlist_alone_arms_nobody_while_the_engine_is_dark) {
  const MailArming dark(false, "u1,u2");

  CHECK_EQ(dark.allowlist.size(), std::size_t{2});
  CHECK_FALSE(dark.allows(UserId{"u1"}));
  CHECK_FALSE(dark.allows(UserId{"u2"}));
  CHECK_FALSE(dark.allows(UserId{"stranger"}));
}

// THE DECISION, pinned: an empty allowlist reaches NOBODY. The flag alone arms no one, so the two
// variables are order-independent and forgetting the list cannot launch the feature to the fleet.
TEST(an_empty_allowlist_arms_nobody_even_when_the_engine_is_enabled) {
  const MailArming armed(true, "");

  CHECK(armed.enabled);
  CHECK_EQ(armed.allowlist.size(), std::size_t{0});
  CHECK_FALSE(armed.allows(UserId{"u1"}));
  CHECK_FALSE(armed.allows(UserId{"anyone-at-all"}));
}

// The same answer for the shape an operator actually mistypes: a list of separators and spacing
// parses to no ids at all, and no ids means no one. It must not fall through to "everybody".
TEST(an_allowlist_of_only_separators_and_spacing_reaches_nobody) {
  const MailArming armed(true, " , ,\t\n");

  CHECK_EQ(armed.allowlist.size(), std::size_t{0});
  CHECK_FALSE(armed.allows(UserId{"u1"}));
  CHECK_FALSE(armed.allows(UserId{"anyone-at-all"}));
}

TEST(arming_on_with_a_list_reaches_only_the_named) {
  const MailArming armed(true, "u1, u3");   // the stray space is trimmed on parse

  CHECK(armed.allows(UserId{"u1"}));
  CHECK(armed.allows(UserId{"u3"}));
  CHECK_FALSE(armed.allows(UserId{"u2"}));
}

TEST(the_allowlist_forgives_the_shapes_a_pasted_uuid_arrives_in) {
  const MailArming armed(true, " 3F2A-ONE , u2,, u3 ,");

  CHECK_EQ(armed.allowlist.size(), std::size_t{3});
  CHECK(armed.allows(UserId{"3f2a-one"}));
  CHECK(armed.allows(UserId{"3F2A-ONE"}));
  CHECK(armed.allows(UserId{"u2"}));
  CHECK(armed.allows(UserId{"u3"}));
  CHECK_FALSE(armed.allows(UserId{"u4"}));
  CHECK_FALSE(armed.allows(UserId{""}));
}

// The casing rule. A uuid pasted from a console or a dashboard often arrives upper- or mixed-case;
// the id it is compared against is always lowercase. A parser that trimmed but did not lowercase
// let an operator name an account, read it back on the list, and reach nobody.
TEST(an_uppercase_id_on_the_allowlist_reaches_the_lowercase_account) {
  const MailArming armed(true, "A1B2C3D4-0000-4000-8000-00000000FFFF");

  CHECK_EQ(armed.allowlist.count("a1b2c3d4-0000-4000-8000-00000000ffff"), std::size_t{1});
  CHECK(armed.allows(UserId{"a1b2c3d4-0000-4000-8000-00000000ffff"}));
  CHECK_FALSE(armed.allows(UserId{"a1b2c3d4-0000-4000-8000-00000000fffe"}));
}

// And the other direction, so the gate is casing-blind rather than merely lowercase-tolerant on
// one side: a mixed-case caller id is folded before the lookup too.
TEST(a_mixed_case_account_is_matched_against_the_lowercased_allowlist) {
  const MailArming armed(true, "u1, MiXeD-Case-Id");

  CHECK(armed.allows(UserId{"MIXED-CASE-ID"}));
  CHECK(armed.allows(UserId{"mixed-case-id"}));
  CHECK(armed.allows(UserId{"U1"}));
  CHECK_FALSE(armed.allows(UserId{"u2"}));
}

#include "platform/domain/ToolScope.h"

#include "test/testing.h"

#include <set>
#include <string>
#include <vector>

using namespace wm;

namespace {
ToolScope of(std::vector<ToolScope::Grant> grants) {
  return ToolScope(std::set<ToolScope::Grant>(grants.begin(), grants.end()));
}
}

TEST(tool_scope_parses_the_wire_spelling_into_product_level_pairs) {
  const ToolScope scope = parseToolScope("roadmap:read gym:read gym:write");
  CHECK(scope.allows("roadmap", Access::read));
  CHECK(scope.allows("gym", Access::read));
  CHECK(scope.allows("gym", Access::write));
  CHECK_FALSE(scope.allows("roadmap", Access::write));
  CHECK_FALSE(scope.allows("journal", Access::read));
}

// The gate itself: three levels, and holding one is never holding another.
TEST(tool_scope_never_implies_delete_from_write) {
  const ToolScope scope = parseToolScope("gym:read gym:write");
  CHECK(scope.allows("gym", Access::write));
  CHECK_FALSE(scope.allows("gym", Access::del));
}

TEST(tool_scope_never_implies_read_from_write_either) {
  const ToolScope scope = parseToolScope("gym:write");
  CHECK(scope.allows("gym", Access::write));
  CHECK_FALSE(scope.allows("gym", Access::read));
  CHECK_FALSE(scope.allows("gym", Access::del));
}

TEST(tool_scope_fails_closed_on_anything_it_cannot_read) {
  const ToolScope scope = parseToolScope("roadmap:read gym:admin journal roadmap: :write ROADMAP:READ");
  CHECK(scope.allows("roadmap", Access::read));  // the one legible token survives
  CHECK_FALSE(scope.allows("gym", Access::read));
  CHECK_FALSE(scope.allows("gym", Access::write));
  CHECK_FALSE(scope.allows("gym", Access::del));
  CHECK_FALSE(scope.allows("journal", Access::read));
  CHECK_FALSE(scope.allows("roadmap", Access::write));
  CHECK_FALSE(scope.allows("ROADMAP", Access::read));  // case-sensitive, like every other vocabulary
}

TEST(tool_scope_grants_nothing_when_every_token_is_unreadable) {
  const ToolScope scope = parseToolScope("nonsense also-nonsense");
  CHECK_FALSE(scope.allows("roadmap", Access::read));
  CHECK_EQ(scope.toString(), std::string(""));
  CHECK_FALSE(scope == ToolScope::everything());  // "" here is an empty SET, not the legacy grant
}

// The one deliberate exception, and the reason it cannot be "fixed": every code and token at rest
// carries scope ''. Narrowing this disconnects every tool anyone has connected, on deploy.
TEST(tool_scope_reads_an_empty_string_as_the_legacy_account_wide_grant) {
  for (const char* stored : {"", "   ", "\t"}) {
    const ToolScope scope = parseToolScope(stored);
    CHECK(scope == ToolScope::everything());
    CHECK(scope.allows("roadmap", Access::del));
    CHECK(scope.allows("gym", Access::write));
    CHECK(scope.allows("a-product-invented-next-year", Access::read));
  }
}

TEST(tool_scope_default_constructs_to_nothing_not_to_everything) {
  const ToolScope scope;
  CHECK_FALSE(scope.allows("roadmap", Access::read));
  CHECK_FALSE(scope == ToolScope::everything());
}

// Canonical order is by product, then by level in ladder order (read, write, delete) — the enum's
// own order, which is also the order a consent screen reads them out in.
TEST(tool_scope_round_trips_through_its_canonical_spelling) {
  const ToolScope scope = parseToolScope("gym:delete roadmap:read gym:read");
  CHECK_EQ(scope.toString(), std::string("gym:read gym:delete roadmap:read"));
  CHECK(parseToolScope(scope.toString()) == scope);
  CHECK_EQ(ToolScope::everything().toString(), std::string(""));
  CHECK(parseToolScope(ToolScope::everything().toString()) == ToolScope::everything());
}

TEST(tool_scope_levels_spell_delete_in_full_on_the_wire) {
  CHECK_EQ(toString(Access::read), std::string("read"));
  CHECK_EQ(toString(Access::write), std::string("write"));
  CHECK_EQ(toString(Access::del), std::string("delete"));
  CHECK(parseAccess("delete") == std::optional<Access>(Access::del));
  CHECK_FALSE(parseAccess("del").has_value());
}

TEST(supported_scopes_publishes_three_levels_per_connected_product) {
  CHECK_EQ(supportedScopes({"roadmap", "gym"}),
           (std::vector<std::string>{"roadmap:read", "roadmap:write", "roadmap:delete", "gym:read",
                                     "gym:write", "gym:delete"}));
  CHECK_EQ(supportedScopes({}), std::vector<std::string>{});
}

TEST(tool_scope_of_an_explicit_set_matches_the_parsed_one) {
  CHECK(of({{"gym", Access::del}}) == parseToolScope("gym:delete"));
  CHECK_FALSE(of({{"gym", Access::del}}) == parseToolScope("gym:write"));
}

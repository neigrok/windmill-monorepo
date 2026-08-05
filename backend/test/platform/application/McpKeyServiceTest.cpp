#include "platform/application/McpKeyService.h"

#include "test/platform/Fakes.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::fake;

TEST(mint_returns_a_one_time_token_and_a_distinct_id_per_key) {
  FakeMcpKeyRepository repo;
  FakeTokens tokens;
  FakeClock clock;
  McpKeyService svc(repo, tokens, clock);

  MintedKey first = svc.mint(UserId{"u1"}, "Laptop");
  CHECK_EQ(first.token, std::string("s1"));  // the first mint's secret
  CHECK_EQ(first.name, std::string("Laptop"));
  CHECK_EQ(first.id, std::string("key1"));
  CHECK_EQ(first.createdMs, static_cast<long long>(clock.now));

  MintedKey second = svc.mint(UserId{"u1"}, "Desktop");
  CHECK_EQ(second.token, std::string("s2"));
  CHECK_EQ(second.id, std::string("key2"));
  CHECK(first.token != second.token);
  CHECK(first.id != second.id);
}

TEST(mint_defaults_a_blank_name_and_caps_a_long_one) {
  FakeMcpKeyRepository repo;
  FakeTokens tokens;
  FakeClock clock;
  McpKeyService svc(repo, tokens, clock);

  CHECK_EQ(svc.mint(UserId{"u1"}, "").name, std::string("MCP key"));
  CHECK_EQ(svc.mint(UserId{"u1"}, "   ").name, std::string("MCP key"));  // whitespace-only is blank too

  const std::string tooLong(80, 'x');
  MintedKey capped = svc.mint(UserId{"u1"}, tooLong);
  CHECK_EQ(capped.name, std::string(60, 'x'));  // capped to 60 characters

  // The stored name is the capped one too: list reads it back capped, and never with the token.
  bool found = false;
  for (const McpKeyView& view : svc.list(UserId{"u1"})) {
    if (view.id != capped.id) continue;
    found = true;
    CHECK_EQ(view.name, std::string(60, 'x'));
  }
  CHECK(found);
}

TEST(resolve_key_returns_the_owner_and_refuses_garbage_and_revoked_keys) {
  FakeMcpKeyRepository repo;
  FakeTokens tokens;
  FakeClock clock;
  McpKeyService svc(repo, tokens, clock);

  MintedKey key = svc.mint(UserId{"u1"}, "Laptop");  // token s1 / digest d1
  std::optional<UserId> owner = svc.resolveKey(key.token);
  REQUIRE(owner.has_value());
  CHECK_EQ(*owner, UserId{"u1"});

  // An unknown or empty secret resolves to nobody.
  CHECK_FALSE(svc.resolveKey("garbage").has_value());
  CHECK_FALSE(svc.resolveKey("").has_value());

  // After revoke the key is inert.
  CHECK(svc.revoke(UserId{"u1"}, key.id));
  CHECK_FALSE(svc.resolveKey(key.token).has_value());
}

TEST(list_returns_keys_newest_first_without_the_token_and_reflects_a_touch) {
  FakeMcpKeyRepository repo;
  FakeTokens tokens;
  FakeClock clock;
  McpKeyService svc(repo, tokens, clock);

  MintedKey older = svc.mint(UserId{"u1"}, "Older");
  clock.now += 1000;
  MintedKey newer = svc.mint(UserId{"u1"}, "Newer");

  std::vector<McpKeyView> keys = svc.list(UserId{"u1"});
  CHECK_EQ(keys.size(), 2u);
  CHECK_EQ(keys[0].id, newer.id);  // newest first
  CHECK_EQ(keys[0].name, std::string("Newer"));
  CHECK_EQ(keys[1].id, older.id);
  CHECK_FALSE(keys[0].lastUsedMs.has_value());  // never used yet
  CHECK_FALSE(keys[1].lastUsedMs.has_value());

  // A resolve stamps last-used; the list reflects it, only for the key that acted.
  clock.now += 1000;
  const long long usedAt = static_cast<long long>(clock.now);
  CHECK(svc.resolveKey(newer.token).has_value());

  std::vector<McpKeyView> after = svc.list(UserId{"u1"});
  CHECK_EQ(after.size(), 2u);
  CHECK_EQ(after[0].id, newer.id);
  REQUIRE(after[0].lastUsedMs.has_value());
  CHECK_EQ(*after[0].lastUsedMs, usedAt);
  CHECK_FALSE(after[1].lastUsedMs.has_value());  // the untouched key stays null
}

TEST(revoke_is_scoped_to_the_owner_and_stops_resolution) {
  FakeMcpKeyRepository repo;
  FakeTokens tokens;
  FakeClock clock;
  McpKeyService svc(repo, tokens, clock);

  MintedKey key = svc.mint(UserId{"u1"}, "Laptop");

  // Another user cannot revoke it, and an unknown id is a clean false — the key stays live.
  CHECK_FALSE(svc.revoke(UserId{"u2"}, key.id));
  CHECK_FALSE(svc.revoke(UserId{"u1"}, "key-nope"));
  CHECK(svc.resolveKey(key.token).has_value());

  // The owner revokes it: true once, then it no longer resolves and is gone from the list.
  CHECK(svc.revoke(UserId{"u1"}, key.id));
  CHECK_FALSE(svc.resolveKey(key.token).has_value());
  CHECK_EQ(svc.list(UserId{"u1"}).size(), 0u);
}

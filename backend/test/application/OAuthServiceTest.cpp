#include "platform/application/OAuthService.h"

#include "test/application/AuthFakes.h"
#include "test/testing.h"

using namespace wm;
using wm::fake::FakeOAuthRepository;

namespace {
const std::string kResource = "https://mcp.example.com/mcp";
const std::string kRedirect = "https://app.example/cb";
}

TEST(oauth_full_authorization_code_flow_with_pkce) {
  FakeOAuthRepository repo;
  fake::FakeTokens tokens;
  fake::FakeClock clock;
  OAuthService svc(repo, tokens, clock);

  const std::string verifier = "the-code-verifier";
  const std::string challenge = tokens.s256Challenge(verifier);

  std::optional<OAuthClient> client = svc.registerClient({kRedirect}, "Claude");
  CHECK(client.has_value());
  CHECK(svc.checkAuthorize(client->clientId, kRedirect, challenge, "S256").error == OAuthService::AuthorizeError::ok);

  std::string code = svc.issueCode(client->clientId, kRedirect, challenge, kResource, "", UserId{"u1"});
  OAuthService::TokenResult granted = svc.exchangeCode(code, client->clientId, kRedirect, verifier, kResource);
  CHECK(granted.error == OAuthService::GrantError::ok);
  CHECK(granted.tokens.has_value());

  std::optional<UserId> user = svc.resolveAccessToken(granted.tokens->accessToken, "https://mcp.example.com");
  CHECK(user.has_value());
  CHECK_EQ(*user, UserId{"u1"});

  // The code is single-use.
  CHECK(svc.exchangeCode(code, client->clientId, kRedirect, verifier, kResource).error ==
        OAuthService::GrantError::invalidGrant);

  // Refresh rotates into a fresh, working access token; the spent refresh token is dead.
  OAuthService::TokenResult rotated = svc.refresh(granted.tokens->refreshToken, client->clientId);
  CHECK(rotated.error == OAuthService::GrantError::ok);
  CHECK(svc.resolveAccessToken(rotated.tokens->accessToken, kResource).has_value());
  CHECK(svc.refresh(granted.tokens->refreshToken, client->clientId).error == OAuthService::GrantError::invalidGrant);
}

TEST(oauth_token_exchange_rejects_wrong_pkce_verifier) {
  FakeOAuthRepository repo;
  fake::FakeTokens tokens;
  fake::FakeClock clock;
  OAuthService svc(repo, tokens, clock);

  std::optional<OAuthClient> client = svc.registerClient({kRedirect}, "Claude");
  std::string code = svc.issueCode(client->clientId, kRedirect, tokens.s256Challenge("right"), kResource, "", UserId{"u1"});
  CHECK(svc.exchangeCode(code, client->clientId, kRedirect, "wrong", kResource).error ==
        OAuthService::GrantError::pkceMismatch);
}

TEST(oauth_rejects_audience_and_redirect_mismatch) {
  FakeOAuthRepository repo;
  fake::FakeTokens tokens;
  fake::FakeClock clock;
  OAuthService svc(repo, tokens, clock);

  std::optional<OAuthClient> client = svc.registerClient({kRedirect}, "Claude");
  const std::string verifier = "v";
  const std::string challenge = tokens.s256Challenge(verifier);

  std::string code1 = svc.issueCode(client->clientId, kRedirect, challenge, kResource, "", UserId{"u1"});
  CHECK(svc.exchangeCode(code1, client->clientId, kRedirect, verifier, "https://evil.example").error ==
        OAuthService::GrantError::badResource);

  std::string code2 = svc.issueCode(client->clientId, kRedirect, challenge, kResource, "", UserId{"u1"});
  CHECK(svc.exchangeCode(code2, client->clientId, "https://app.example/other", verifier, kResource).error ==
        OAuthService::GrantError::badRedirect);
}

TEST(oauth_registration_and_authorize_guards) {
  FakeOAuthRepository repo;
  fake::FakeTokens tokens;
  fake::FakeClock clock;
  OAuthService svc(repo, tokens, clock);

  CHECK_FALSE(svc.registerClient({"http://evil.example/cb"}, "x").has_value());  // non-loopback http
  CHECK_FALSE(svc.registerClient({}, "x").has_value());                          // no redirect uris

  std::optional<OAuthClient> client = svc.registerClient({kRedirect}, "ok");
  CHECK(client.has_value());
  CHECK(svc.checkAuthorize("nope", kRedirect, "c", "S256").error == OAuthService::AuthorizeError::unknownClient);
  CHECK(svc.checkAuthorize(client->clientId, "https://other/cb", "c", "S256").error == OAuthService::AuthorizeError::badRedirect);
  CHECK(svc.checkAuthorize(client->clientId, kRedirect, "c", "plain").error == OAuthService::AuthorizeError::unsupportedChallenge);
}

TEST(oauth_grant_is_recorded_on_exchange_and_listed_with_the_client_name) {
  FakeOAuthRepository repo;
  fake::FakeTokens tokens;
  fake::FakeClock clock;
  OAuthService svc(repo, tokens, clock);

  const std::string verifier = "v";
  const std::string challenge = tokens.s256Challenge(verifier);
  std::optional<OAuthClient> client = svc.registerClient({kRedirect}, "Claude");

  const UnixMs grantedAt = clock.now;
  std::string code = svc.issueCode(client->clientId, kRedirect, challenge, kResource, "", UserId{"u1"});
  CHECK(svc.exchangeCode(code, client->clientId, kRedirect, verifier, kResource).error == OAuthService::GrantError::ok);

  std::vector<GrantView> grants = svc.listGrants(UserId{"u1"});
  CHECK_EQ(grants.size(), 1u);
  CHECK_EQ(grants[0].clientId, client->clientId);
  CHECK_EQ(grants[0].clientName, std::string("Claude"));
  CHECK_EQ(grants[0].grantedMs, grantedAt);
  CHECK_EQ(grants[0].lastUsedMs, grantedAt);

  // Grants are per-user: another account sees none of this one's.
  CHECK_EQ(svc.listGrants(UserId{"u2"}).size(), 0u);
}

TEST(oauth_grant_date_is_stable_across_refresh_rotation_and_last_used_advances) {
  FakeOAuthRepository repo;
  fake::FakeTokens tokens;
  fake::FakeClock clock;
  OAuthService svc(repo, tokens, clock);

  const std::string verifier = "v";
  const std::string challenge = tokens.s256Challenge(verifier);
  std::optional<OAuthClient> client = svc.registerClient({kRedirect}, "Claude");

  const UnixMs grantedAt = clock.now;
  std::string code = svc.issueCode(client->clientId, kRedirect, challenge, kResource, "", UserId{"u1"});
  OAuthService::TokenResult granted = svc.exchangeCode(code, client->clientId, kRedirect, verifier, kResource);

  // A resolve inside the throttle window leaves last-used exactly where the grant set it.
  CHECK(svc.resolveAccessToken(granted.tokens->accessToken, kResource).has_value());
  CHECK_EQ(svc.listGrants(UserId{"u1"})[0].lastUsedMs, grantedAt);

  // Time passes and the client rotates its token — granted stays put, no second grant row.
  clock.now += OAuthPolicy::grantTouchThrottleMs + 1;
  const UnixMs usedAt = clock.now;
  OAuthService::TokenResult rotated = svc.refresh(granted.tokens->refreshToken, client->clientId);
  CHECK(rotated.error == OAuthService::GrantError::ok);

  // The rotated token now acts: last-used advances past the throttle; granted is unchanged.
  CHECK(svc.resolveAccessToken(rotated.tokens->accessToken, kResource).has_value());
  std::vector<GrantView> grants = svc.listGrants(UserId{"u1"});
  CHECK_EQ(grants.size(), 1u);
  CHECK_EQ(grants[0].grantedMs, grantedAt);
  CHECK_EQ(grants[0].lastUsedMs, usedAt);
}

TEST(oauth_disconnect_drops_the_grant_and_kills_the_token) {
  FakeOAuthRepository repo;
  fake::FakeTokens tokens;
  fake::FakeClock clock;
  OAuthService svc(repo, tokens, clock);

  const std::string verifier = "v";
  const std::string challenge = tokens.s256Challenge(verifier);
  std::optional<OAuthClient> client = svc.registerClient({kRedirect}, "Claude");
  std::string code = svc.issueCode(client->clientId, kRedirect, challenge, kResource, "", UserId{"u1"});
  OAuthService::TokenResult granted = svc.exchangeCode(code, client->clientId, kRedirect, verifier, kResource);
  CHECK(svc.resolveAccessToken(granted.tokens->accessToken, kResource).has_value());
  CHECK_EQ(svc.listGrants(UserId{"u1"}).size(), 1u);

  svc.disconnect(UserId{"u1"}, client->clientId);

  // The grant is gone, and the next call with the tool's token is refused (a 401 at the edge).
  CHECK_EQ(svc.listGrants(UserId{"u1"}).size(), 0u);
  CHECK_FALSE(svc.resolveAccessToken(granted.tokens->accessToken, kResource).has_value());
  // Its refresh token is dead too, so it cannot mint a fresh one.
  CHECK(svc.refresh(granted.tokens->refreshToken, client->clientId).error == OAuthService::GrantError::invalidGrant);
}

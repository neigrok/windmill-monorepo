#include "platform/application/OAuthService.h"

#include "test/platform/Fakes.h"
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

  std::optional<OAuthClient> client = svc.registerClient({kRedirect}, "Claude").client;
  REQUIRE(client.has_value());
  CHECK(svc.checkAuthorize(client->clientId, kRedirect, challenge, "S256").error == OAuthService::AuthorizeError::ok);

  std::string code = svc.issueCode(client->clientId, kRedirect, challenge, kResource, "", UserId{"u1"});
  OAuthService::TokenResult granted = svc.exchangeCode(code, client->clientId, kRedirect, verifier, kResource);
  CHECK(granted.error == OAuthService::GrantError::ok);
  REQUIRE(granted.tokens.has_value());

  std::optional<ToolCaller> caller = svc.resolveAccessToken(granted.tokens->accessToken, "https://mcp.example.com");
  REQUIRE(caller.has_value());
  CHECK_EQ(caller->user, UserId{"u1"});
  // The connection is the client the token was minted for, under the name it registered.
  CHECK((caller->connection == ToolConnection{client->clientId, "Claude"}));

  // The code is single-use.
  CHECK(svc.exchangeCode(code, client->clientId, kRedirect, verifier, kResource).error ==
        OAuthService::GrantError::invalidGrant);

  // Refresh rotates into a fresh, working access token; the spent refresh token is dead.
  OAuthService::TokenResult rotated = svc.refresh(granted.tokens->refreshToken, client->clientId);
  CHECK(rotated.error == OAuthService::GrantError::ok);
  CHECK(svc.resolveAccessToken(rotated.tokens->accessToken, kResource).has_value());
  CHECK(svc.refresh(granted.tokens->refreshToken, client->clientId).error == OAuthService::GrantError::invalidGrant);
}

// A client row that is gone costs the connection its name and nothing else: the token still resolves,
// still says which client id it belongs to, and a tool storing that connection stores an honest empty
// name rather than refusing the call.
TEST(oauth_a_token_whose_client_row_is_gone_still_resolves_with_an_empty_connection_name) {
  FakeOAuthRepository repo;
  fake::FakeTokens tokens;
  fake::FakeClock clock;
  OAuthService svc(repo, tokens, clock);
  const std::string verifier = "the-code-verifier";
  std::optional<OAuthClient> client = svc.registerClient({kRedirect}, "Claude").client;
  REQUIRE(client.has_value());
  std::string code = svc.issueCode(client->clientId, kRedirect, tokens.s256Challenge(verifier), kResource,
                                   "", UserId{"u1"});
  OAuthService::TokenResult granted = svc.exchangeCode(code, client->clientId, kRedirect, verifier, kResource);
  REQUIRE(granted.tokens.has_value());

  repo.clients.erase(client->clientId);
  std::optional<ToolCaller> caller = svc.resolveAccessToken(granted.tokens->accessToken, kResource);

  REQUIRE(caller.has_value());
  CHECK_EQ(caller->user, UserId{"u1"});
  CHECK((caller->connection == ToolConnection{client->clientId, ""}));
}

TEST(oauth_token_exchange_rejects_wrong_pkce_verifier) {
  FakeOAuthRepository repo;
  fake::FakeTokens tokens;
  fake::FakeClock clock;
  OAuthService svc(repo, tokens, clock);

  std::optional<OAuthClient> client = svc.registerClient({kRedirect}, "Claude").client;
  std::string code = svc.issueCode(client->clientId, kRedirect, tokens.s256Challenge("right"), kResource, "", UserId{"u1"});
  CHECK(svc.exchangeCode(code, client->clientId, kRedirect, "wrong", kResource).error ==
        OAuthService::GrantError::pkceMismatch);
}

TEST(oauth_rejects_audience_and_redirect_mismatch) {
  FakeOAuthRepository repo;
  fake::FakeTokens tokens;
  fake::FakeClock clock;
  OAuthService svc(repo, tokens, clock);

  std::optional<OAuthClient> client = svc.registerClient({kRedirect}, "Claude").client;
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

  CHECK_FALSE(svc.registerClient({"http://evil.example/cb"}, "x").client.has_value());  // non-loopback http
  CHECK_FALSE(svc.registerClient({}, "x").client.has_value());                          // no redirect uris

  std::optional<OAuthClient> client = svc.registerClient({kRedirect}, "ok").client;
  REQUIRE(client.has_value());
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
  std::optional<OAuthClient> client = svc.registerClient({kRedirect}, "Claude").client;

  const UnixMs grantedAt = clock.now;
  std::string code = svc.issueCode(client->clientId, kRedirect, challenge, kResource, "", UserId{"u1"});
  CHECK(svc.exchangeCode(code, client->clientId, kRedirect, verifier, kResource).error == OAuthService::GrantError::ok);

  std::vector<GrantView> grants = svc.listGrants(UserId{"u1"});
  REQUIRE_EQ(grants.size(), 1u);
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
  std::optional<OAuthClient> client = svc.registerClient({kRedirect}, "Claude").client;

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
  REQUIRE_EQ(grants.size(), 1u);
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
  std::optional<OAuthClient> client = svc.registerClient({kRedirect}, "Claude").client;
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

// OAUTH-2. A refresh token presented after it has already been rotated means two parties hold it,
// and there is no way to tell which is the thief — so the grant goes, and the family the thief (or
// the victim) rotated into goes with it. Before this, reuse answered invalid_grant and left the
// live family standing, which hands whoever won the race a working token and tells nobody.
TEST(oauth_replaying_a_rotated_refresh_token_revokes_the_whole_grant) {
  FakeOAuthRepository repo;
  fake::FakeTokens tokens;
  fake::FakeClock clock;
  OAuthService svc(repo, tokens, clock);

  const std::string verifier = "the-code-verifier";
  std::optional<OAuthClient> client = svc.registerClient({kRedirect}, "Claude").client;
  REQUIRE(client.has_value());
  std::string code = svc.issueCode(client->clientId, kRedirect, tokens.s256Challenge(verifier), kResource,
                                   "roadmap:write", UserId{"u1"});
  OAuthService::TokenResult first = svc.exchangeCode(code, client->clientId, kRedirect, verifier, kResource);
  REQUIRE(first.tokens.has_value());
  OAuthService::TokenResult second = svc.refresh(first.tokens->refreshToken, client->clientId);
  REQUIRE(second.tokens.has_value());
  CHECK(svc.resolveAccessToken(second.tokens->accessToken, kResource).has_value());

  // The stolen copy, well after the victim's own rotation — outside the retry grace, so the only
  // reading left is that two parties hold this token.
  clock.now += OAuthPolicy::refreshReplayGraceMs + 1;
  OAuthService::TokenResult replayed = svc.refresh(first.tokens->refreshToken, client->clientId);
  CHECK(replayed.error == OAuthService::GrantError::invalidGrant);
  CHECK_FALSE(replayed.tokens.has_value());

  // Everything the grant carried is gone: the live access token, the live refresh token, the row
  // settings §2 lists it by.
  CHECK_FALSE(svc.resolveAccessToken(second.tokens->accessToken, kResource).has_value());
  CHECK(svc.refresh(second.tokens->refreshToken, client->clientId).error ==
        OAuthService::GrantError::invalidGrant);
  CHECK_EQ(svc.listGrants(UserId{"u1"}).size(), static_cast<std::size_t>(0));
}

// A string that was never a refresh token here is not a breach signal, and must not cost anyone
// their grant — otherwise anyone who can reach /oauth/token could revoke by guessing.
TEST(oauth_a_refresh_token_nobody_ever_issued_leaves_the_live_grant_alone) {
  FakeOAuthRepository repo;
  fake::FakeTokens tokens;
  fake::FakeClock clock;
  OAuthService svc(repo, tokens, clock);

  const std::string verifier = "the-code-verifier";
  std::optional<OAuthClient> client = svc.registerClient({kRedirect}, "Claude").client;
  REQUIRE(client.has_value());
  std::string code = svc.issueCode(client->clientId, kRedirect, tokens.s256Challenge(verifier), kResource,
                                   "", UserId{"u1"});
  OAuthService::TokenResult granted = svc.exchangeCode(code, client->clientId, kRedirect, verifier, kResource);
  REQUIRE(granted.tokens.has_value());

  CHECK(svc.refresh("s999999", client->clientId).error == OAuthService::GrantError::invalidGrant);

  CHECK(svc.resolveAccessToken(granted.tokens->accessToken, kResource).has_value());
  CHECK_EQ(svc.listGrants(UserId{"u1"}).size(), static_cast<std::size_t>(1));
  CHECK(svc.refresh(granted.tokens->refreshToken, client->clientId).error == OAuthService::GrantError::ok);
}

// OAUTH-3. Registration is open by design (RFC 7591) — an MCP client nobody has met has to be able
// to introduce itself — so what is bounded is the SIZE and the COUNT. One 8 MB body used to persist
// 8 MB of redirect URIs, and a script could plant rows until the disk said no.
TEST(oauth_registration_is_bounded_in_size_and_in_count) {
  FakeOAuthRepository repo;
  fake::FakeTokens tokens;
  fake::FakeClock clock;
  OAuthService svc(repo, tokens, clock);

  std::vector<std::string> tooMany;
  for (std::size_t i = 0; i <= OAuthPolicy::maxRedirectUris; ++i)
    tooMany.push_back("https://app.example/cb" + std::to_string(i));
  CHECK_FALSE(svc.registerClient(tooMany, "x").client.has_value());
  tooMany.pop_back();
  CHECK(svc.registerClient(tooMany, "x").client.has_value());

  const std::string tooLong = "https://app.example/" + std::string(OAuthPolicy::maxRedirectUriChars, 'a');
  CHECK_FALSE(svc.registerClient({tooLong}, "x").client.has_value());

  // The ceiling counts clients that never completed an authorization — the only kind an abuser
  // makes. A client that HAS a grant is not junk and never stands between a real person and a tool.
  repo.registeredAt = clock.now;
  for (int i = 0; i < OAuthPolicy::maxUnattachedClients; ++i)
    repo.clients["filler" + std::to_string(i)] = OAuthClient{"filler" + std::to_string(i), {kRedirect}, ""};
  const OAuthService::Registration refused = svc.registerClient({kRedirect}, "one too many");
  CHECK_FALSE(refused.client.has_value());
  // And it says WHICH refusal it is: an operator told "invalid_redirect_uri" here would spend the
  // outage looking at a redirect URI that was never wrong.
  CHECK(refused.error == OAuthService::RegisterError::atCapacity);
  CHECK_EQ(refused.unattachedInWindow, OAuthPolicy::maxUnattachedClients);
  CHECK(svc.registerClient({"http://evil.example/cb"}, "x").error ==
        OAuthService::RegisterError::invalidMetadata);

  // A client someone actually connected is not junk and never counts toward the burst.
  repo.grants[{"u1", "filler0"}] = FakeOAuthRepository::GrantRow{1, 1, ""};
  CHECK(svc.registerClient({kRedirect}, "room again").client.has_value());
}

// The ceiling is a rolling WINDOW, not a table count, and that is the difference between a brake
// and an outage: a five-second burst of registrations used to shut the door on everyone for the
// thirty days it took the TTL to drain, because nothing aged out of the count. An hour later the
// same burst is not in the count at all and honest clients register again.
TEST(oauth_the_registration_ceiling_ages_out_so_a_burst_is_not_a_thirty_day_outage) {
  FakeOAuthRepository repo;
  fake::FakeTokens tokens;
  fake::FakeClock clock;
  OAuthService svc(repo, tokens, clock);

  repo.registeredAt = clock.now;
  for (int i = 0; i < OAuthPolicy::maxUnattachedClients; ++i) {
    const std::string id = "burst" + std::to_string(i);
    repo.clients[id] = OAuthClient{id, {kRedirect}, ""};
    repo.registeredMs[id] = clock.now;
  }
  CHECK(svc.registerClient({kRedirect}, "shut out").error == OAuthService::RegisterError::atCapacity);

  clock.now += OAuthPolicy::unattachedClientWindowMs + 1;
  repo.registeredAt = clock.now;
  const OAuthService::Registration after = svc.registerClient({kRedirect}, "an hour later");
  CHECK(after.error == OAuthService::RegisterError::ok);
  CHECK(after.client.has_value());
  CHECK_EQ(after.unattachedInWindow, 0);
}

// The other half of OAUTH-2, and the one that decides whether the fix is safe to ship: rotation is
// not atomic across a network. A client whose refresh reply was lost retries with the same token,
// and two threads that both saw a 401 refresh in parallel — both present a token that is already
// spent, milliseconds after it was spent, by the same client. Calling that theft revoked the
// WINNER's brand-new tokens and disconnected an honest person from their tools with nothing
// anywhere saying why. Inside the grace it is a plain invalid_grant and the live family stands.
TEST(oauth_an_honest_clients_immediate_retry_of_a_spent_refresh_token_keeps_the_grant) {
  FakeOAuthRepository repo;
  fake::FakeTokens tokens;
  fake::FakeClock clock;
  OAuthService svc(repo, tokens, clock);

  const std::string verifier = "the-code-verifier";
  std::optional<OAuthClient> client = svc.registerClient({kRedirect}, "Claude").client;
  REQUIRE(client.has_value());
  std::string code = svc.issueCode(client->clientId, kRedirect, tokens.s256Challenge(verifier), kResource,
                                   "roadmap:write", UserId{"u1"});
  OAuthService::TokenResult first = svc.exchangeCode(code, client->clientId, kRedirect, verifier, kResource);
  REQUIRE(first.tokens.has_value());
  OAuthService::TokenResult won = svc.refresh(first.tokens->refreshToken, client->clientId);
  REQUIRE(won.tokens.has_value());

  // The lost-reply retry, one second later.
  clock.now += 1000;
  OAuthService::TokenResult retried = svc.refresh(first.tokens->refreshToken, client->clientId);
  CHECK(retried.error == OAuthService::GrantError::invalidGrant);
  CHECK_FALSE(retried.tokens.has_value());

  // Everything the winner was issued still works, and the person is still connected.
  CHECK(svc.resolveAccessToken(won.tokens->accessToken, kResource).has_value());
  CHECK_EQ(svc.listGrants(UserId{"u1"}).size(), static_cast<std::size_t>(1));
  OAuthService::TokenResult next = svc.refresh(won.tokens->refreshToken, client->clientId);
  CHECK(next.error == OAuthService::GrantError::ok);
  CHECK(next.tokens.has_value());

  // A DIFFERENT client presenting the same spent token is not a retry at any distance — that is
  // someone else holding a copy, which is the whole signal.
  OAuthService::Registration thief = svc.registerClient({kRedirect}, "Someone else");
  REQUIRE(thief.client.has_value());
  CHECK(svc.refresh(first.tokens->refreshToken, thief.client->clientId).error ==
        OAuthService::GrantError::invalidGrant);
  CHECK_EQ(svc.listGrants(UserId{"u1"}).size(), static_cast<std::size_t>(0));
}

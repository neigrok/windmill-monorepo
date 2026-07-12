#include "application/OAuthService.h"

#include "test/application/AuthFakes.h"
#include "test/testing.h"

#include <map>

using namespace wm;

namespace {

struct FakeOAuthRepo : OAuthRepository {
  std::map<std::string, OAuthClient> clients;
  std::map<std::string, StoredCode> codes;
  std::map<std::string, StoredToken> access;
  struct Refresh { StoredToken grant; UnixMs expiresAt; };
  std::map<std::string, Refresh> refresh;

  void registerClient(const OAuthClient& client) override { clients[client.clientId] = client; }
  std::optional<OAuthClient> findClient(const std::string& id) override {
    auto it = clients.find(id);
    if (it == clients.end()) return std::nullopt;
    return it->second;
  }
  void insertCode(const std::string& digest, const StoredCode& code) override { codes[digest] = code; }
  std::optional<StoredCode> takeCode(const std::string& digest) override {
    auto it = codes.find(digest);
    if (it == codes.end()) return std::nullopt;
    StoredCode code = it->second;
    codes.erase(it);
    return code;
  }
  void insertToken(const std::string& accessDigest, const std::string& refreshDigest,
                   const StoredToken& token, UnixMs refreshExpiresAt) override {
    access[accessDigest] = token;
    refresh[refreshDigest] = Refresh{token, refreshExpiresAt};
  }
  std::optional<StoredToken> findAccessToken(const std::string& digest) override {
    auto it = access.find(digest);
    if (it == access.end()) return std::nullopt;
    return it->second;
  }
  std::optional<StoredToken> takeRefreshToken(const std::string& digest, UnixMs now) override {
    auto it = refresh.find(digest);
    if (it == refresh.end() || it->second.expiresAt <= now) return std::nullopt;
    StoredToken grant = it->second.grant;
    refresh.erase(it);
    return grant;
  }
};

const std::string kResource = "https://mcp.example.com/mcp";
const std::string kRedirect = "https://app.example/cb";

}

TEST(oauth_full_authorization_code_flow_with_pkce) {
  FakeOAuthRepo repo;
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
  FakeOAuthRepo repo;
  fake::FakeTokens tokens;
  fake::FakeClock clock;
  OAuthService svc(repo, tokens, clock);

  std::optional<OAuthClient> client = svc.registerClient({kRedirect}, "Claude");
  std::string code = svc.issueCode(client->clientId, kRedirect, tokens.s256Challenge("right"), kResource, "", UserId{"u1"});
  CHECK(svc.exchangeCode(code, client->clientId, kRedirect, "wrong", kResource).error ==
        OAuthService::GrantError::pkceMismatch);
}

TEST(oauth_rejects_audience_and_redirect_mismatch) {
  FakeOAuthRepo repo;
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
  FakeOAuthRepo repo;
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

#pragma once

#include "platform/application/AuthService.h"
#include "platform/ports/AppleIdentityVerifier.h"
#include "test/platform/Fakes.h"

namespace wm::fake {
struct FakeAppleIdentityVerifier : AppleIdentityVerifier {
  bool enabled = true;
  std::optional<ProviderIdentity> identity = ProviderIdentity{
      Provider::apple, "apple-linking-subject", Email{"relay@privaterelay.appleid.com"}, "", true, true};
  bool configured() const override { return enabled; }
  void verify(const std::string&, const std::string&, Completion done) override { done(identity); }
};

struct AppleLinkingFixture {
  FakeAuthRepository repo;
  FakeEmail email;
  FakeTokens tokens;
  FakeClock clock;
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, clock};
  FakeAccountFootprint footprint;
  FakeSessionRevocations revocations;
  std::shared_ptr<AuthService> auth = std::make_shared<AuthService>(
      repo, email, tokens, clock, oauth, footprint, revocations, "https://windmill.works");
  std::shared_ptr<FakeAppleIdentityVerifier> verifier = std::make_shared<FakeAppleIdentityVerifier>();

  ProviderIdentity identity() const { return *verifier->identity; }
  User user(const std::string& address = "sam@example.com") { return repo.createUser(Email{address}, "Sam"); }
  std::string ticket() { return auth->beginApple(identity()).ticket; }
  std::string code(const std::string& address = "sam@example.com") {
    auth->requestLink(address, "", std::nullopt, "app", [](auto) {});
    return email.sent.back().code;
  }
  void session(const User& user, const std::string& secret) {
    repo.insertSession(tokens.digestOf(secret), user.id, sessionExpiry(clock.now), "", "", clock.now);
  }
};
}

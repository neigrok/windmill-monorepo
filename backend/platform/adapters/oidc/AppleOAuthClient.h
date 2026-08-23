#pragma once

#include "platform/domain/Auth.h"

#include <trantor/net/EventLoopThread.h>

#include <functional>
#include <optional>
#include <string>

namespace wm {

// Windmill as an OAuth client to Apple, NATIVE flow: the app posts an authorization code, this
// client redeems it at Apple's token endpoint and reads the identity out of the id_token.
// Apple's client_secret is a short-lived ES256 JWT signed with the team's .p8 key, minted per
// exchange here. Unconfigured (any of client id / team / key id / key missing) → configured() is false.
// The email may be a Hide My Email relay — verified, stable for this app, and unable to name the
// human elsewhere (domain/Auth.h's AddressTrust). The NAME never appears in the id_token: Apple
// hands it to the app once, on the very first authorization, so it reaches us through the body or not at all.
class AppleOAuthClient {
public:
  AppleOAuthClient(std::string clientId, std::string teamId, std::string keyId, std::string privateKeyPem);

  bool configured() const {
    return !clientId_.empty() && !teamId_.empty() && !keyId_.empty() && !privateKeyPem_.empty();
  }
  void exchangeCode(const std::string& code, std::function<void(std::optional<ProviderIdentity>)> done);

private:
  // The per-exchange ES256 client secret, or empty if the .p8 key won't load or sign.
  std::string clientSecret() const;

  std::string clientId_;  // the app's bundle identifier for the native flow
  std::string teamId_;
  std::string keyId_;
  std::string privateKeyPem_;
  trantor::EventLoopThread loop_;
};

}

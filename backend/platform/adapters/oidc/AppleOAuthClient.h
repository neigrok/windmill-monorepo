#pragma once

#include "platform/domain/Auth.h"

#include <trantor/net/EventLoopThread.h>

#include <functional>
#include <optional>
#include <string>

namespace wm {

// Windmill as an OAuth client to Apple, for the NATIVE flow: the iOS app runs
// ASAuthorizationController, gets an authorization code, and posts it here — this client redeems
// it at Apple's token endpoint and reads the identity out of the id_token that comes back.
//
// The redemption is server-side on purpose. The app is also handed an identityToken it could send
// us directly, but a token that arrives from a client carries no proof of origin and would have to
// be verified against Apple's rotating JWKS. Exchanging the code ourselves means the id_token
// arrives on a TLS connection this process opened to appleid.apple.com, which is the same trust
// model the Google door already runs on, with no key set to fetch, cache or rotate.
//
// Apple's client_secret is not a constant: it is a short-lived ES256 JWT signed with the team's .p8
// key, minted per exchange here. Unconfigured (any of client id / team / key id / key missing) →
// configured() is false and the route stays shut, exactly as Google's does.
//
// Two Apple-only facts the caller depends on. The email may be a Hide My Email relay — verified,
// stable for this app, and unable to name the human anywhere else (domain/Auth.h's AddressTrust).
// And the human's NAME never appears in the id_token at all: Apple hands it to the app once, on the
// very first authorization ever, so it reaches us through the request body or not at all.
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

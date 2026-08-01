#pragma once

#include "platform/domain/Auth.h"

#include <trantor/net/EventLoopThread.h>

#include <functional>
#include <optional>
#include <string>

namespace wm {

// Windmill as an OAuth CLIENT to Google (Authorization Code flow): builds the consent redirect and
// exchanges the returned code for an id_token, decoding the verified identity from its payload.
// The id_token arrives straight from Google's token endpoint over the TLS connection this client
// opened, so its payload is trusted without a JWKS signature check (Google's documented allowance
// for the server-side code flow); aud + iss + email_verified are still checked as defense in depth.
// Unconfigured (no client id/secret) → configured() is false and the sign-in routes stay shut.
class GoogleOAuthClient {
public:
  GoogleOAuthClient(std::string clientId, std::string clientSecret, std::string redirectUri);

  bool configured() const { return !clientId_.empty() && !clientSecret_.empty(); }
  std::string authorizeUrl(const std::string& state) const;
  void exchangeCode(const std::string& code, std::function<void(std::optional<ProviderIdentity>)> done);

private:
  std::string clientId_;
  std::string clientSecret_;
  std::string redirectUri_;
  trantor::EventLoopThread loop_;
};

}

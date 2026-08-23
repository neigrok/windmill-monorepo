#pragma once

#include "platform/domain/Auth.h"

#include <trantor/net/EventLoopThread.h>

#include <functional>
#include <optional>
#include <string>

namespace wm {

// Windmill as an OAuth client to Google (Authorization Code flow): builds the consent redirect and
// exchanges the returned code for an id_token. The id_token arrives over the TLS connection this
// client opened to Google's token endpoint, so its payload is trusted without a JWKS signature
// check; aud + iss + email_verified are still checked. No client id/secret → configured() is false
// and the sign-in routes stay shut.
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

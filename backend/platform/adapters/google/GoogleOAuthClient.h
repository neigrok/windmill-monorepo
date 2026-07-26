#pragma once

#include "platform/domain/Auth.h"

#include <trantor/net/EventLoopThread.h>

#include <functional>
#include <optional>
#include <string>

namespace wm {

// Google's verified profile from a completed OAuth code exchange. emailVerified MUST be true before
// this identity is trusted to resolve an account — an unverified Google email must never link to an
// existing magic-link account.
struct GoogleIdentity {
  Email email;
  std::string name;
  bool emailVerified = false;
};

// Windmill as an OAuth CLIENT to Google (Authorization Code flow): builds the consent redirect and
// exchanges the returned code for an id_token, decoding the verified {email, name} from its payload.
// The id_token arrives straight from Google's token endpoint over the TLS connection this client
// opened, so its payload is trusted without a JWKS signature check (Google's documented allowance
// for the server-side code flow); aud + iss + email_verified are still checked as defense in depth.
// Unconfigured (no client id/secret) → configured() is false and the sign-in routes stay shut.
class GoogleOAuthClient {
public:
  GoogleOAuthClient(std::string clientId, std::string clientSecret, std::string redirectUri);

  bool configured() const { return !clientId_.empty() && !clientSecret_.empty(); }
  std::string authorizeUrl(const std::string& state) const;
  void exchangeCode(const std::string& code, std::function<void(std::optional<GoogleIdentity>)> done);

private:
  std::string clientId_;
  std::string clientSecret_;
  std::string redirectUri_;
  trantor::EventLoopThread loop_;
};

}

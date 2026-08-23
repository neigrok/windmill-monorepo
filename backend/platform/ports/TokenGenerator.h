#pragma once

#include <string>

namespace wm {

// `secret` is what travels (magic-link URL, session cookie); only `digest` is ever stored.
struct MintedToken {
  std::string secret;
  std::string digest;
};

struct TokenGenerator {
  virtual ~TokenGenerator() = default;
  virtual MintedToken mint() = 0;
  // Six decimal digits, uniform; only its digestOf is stored.
  virtual std::string mintCode() = 0;
  virtual std::string digestOf(const std::string& secret) = 0;
  // PKCE S256: base64url(sha256(verifier)), unpadded.
  virtual std::string s256Challenge(const std::string& verifier) = 0;
};

}

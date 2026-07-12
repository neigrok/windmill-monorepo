#pragma once

#include "ports/TokenGenerator.h"

namespace wm {

// Secrets are 32 bytes of OpenSSL randomness, URL-safe base64 (the string that rides in a
// link or cookie); the digest is their SHA-256 as lowercase hex. Both come from OpenSSL,
// already linked transitively through Drogon.
class OpenSslTokenGenerator : public TokenGenerator {
public:
  MintedToken mint() override;
  std::string digestOf(const std::string& secret) override;
  std::string s256Challenge(const std::string& verifier) override;
};

}

#pragma once

#include <string>

namespace wm {

// A freshly minted secret and its digest. The `secret` is what travels — in a magic-link
// URL or a session cookie; only the `digest` is ever stored, so a database leak can neither
// resurrect a live link nor impersonate a session.
struct MintedToken {
  std::string secret;
  std::string digest;
};

// Mints unguessable secrets and digests presented ones for lookup. The randomness and the
// hash live at the edge (OpenSSL) — the domain only ever compares digests.
struct TokenGenerator {
  virtual ~TokenGenerator() = default;
  virtual MintedToken mint() = 0;
  virtual std::string digestOf(const std::string& secret) = 0;
};

}

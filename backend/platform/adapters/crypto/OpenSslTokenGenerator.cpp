#include "platform/adapters/crypto/OpenSslTokenGenerator.h"

#include "platform/domain/Auth.h"  // AuthPolicy::codeLength

#include <array>
#include <stdexcept>

#include <drogon/utils/Utilities.h>
#include <openssl/rand.h>
#include <openssl/sha.h>

namespace wm {

// Draws 32 bytes of OpenSSL entropy, encodes them URL-safe unpadded, and digests the result.
MintedToken OpenSslTokenGenerator::mint() {
  std::array<unsigned char, 32> bytes{};
  if (RAND_bytes(bytes.data(), static_cast<int>(bytes.size())) != 1)
    throw std::runtime_error("token entropy unavailable");
  std::string secret = drogon::utils::base64Encode(bytes.data(), bytes.size(), true, false);
  return MintedToken{secret, digestOf(secret)};
}

// The 6-digit sign-in code: one uniform decimal digit per accepted byte. A byte is accepted only
// below 250 — the largest multiple of 10 a byte reaches — so `% 10` is exact; without the
// rejection, 256 % 10 != 0 would quietly over-produce the digits 0-5.
std::string OpenSslTokenGenerator::mintCode() {
  const std::size_t length = static_cast<std::size_t>(AuthPolicy::codeLength);
  std::string code;
  code.reserve(length);
  while (code.size() < length) {
    std::array<unsigned char, 16> bytes{};
    if (RAND_bytes(bytes.data(), static_cast<int>(bytes.size())) != 1)
      throw std::runtime_error("token entropy unavailable");
    for (unsigned char byte : bytes) {
      if (byte >= 250) continue;  // resample rather than bias the low digits
      code.push_back(static_cast<char>('0' + byte % 10));
      if (code.size() == length) break;
    }
  }
  return code;
}

// SHA-256 of the secret's bytes, lowercase hex (64 chars).
std::string OpenSslTokenGenerator::digestOf(const std::string& secret) {
  std::array<unsigned char, SHA256_DIGEST_LENGTH> hash{};
  SHA256(reinterpret_cast<const unsigned char*>(secret.data()), secret.size(), hash.data());
  static constexpr char digits[] = "0123456789abcdef";
  std::string hex(hash.size() * 2, '0');
  for (std::size_t i = 0; i < hash.size(); ++i) {
    hex[2 * i] = digits[hash[i] >> 4];
    hex[2 * i + 1] = digits[hash[i] & 0x0F];
  }
  return hex;
}

// PKCE S256: base64url, unpadded, of the verifier's SHA-256 — the RFC 7636 challenge form.
std::string OpenSslTokenGenerator::s256Challenge(const std::string& verifier) {
  std::array<unsigned char, SHA256_DIGEST_LENGTH> hash{};
  SHA256(reinterpret_cast<const unsigned char*>(verifier.data()), verifier.size(), hash.data());
  return drogon::utils::base64Encode(hash.data(), hash.size(), true, false);
}

}

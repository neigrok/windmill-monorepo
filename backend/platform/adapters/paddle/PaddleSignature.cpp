#include "platform/adapters/paddle/PaddleSignature.h"

#include "platform/adapters/http/WebhookFreshness.h"

#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>

#include <vector>

namespace wm {

namespace {
std::string hexOf(const unsigned char* bytes, unsigned int length) {
  static const char* digits = "0123456789abcdef";
  std::string out;
  out.reserve(length * 2);
  for (unsigned int i = 0; i < length; ++i) {
    out.push_back(digits[bytes[i] >> 4]);
    out.push_back(digits[bytes[i] & 0x0F]);
  }
  return out;
}
}

bool verifyPaddleSignature(const std::string& body, const std::string& signatureHeader,
                           const std::string& secret, std::int64_t nowMs, std::int64_t toleranceMs) {
  if (body.empty() || signatureHeader.empty() || secret.empty()) return false;

  // "ts=<unix seconds>;h1=<hex>" — take the timestamp and every h1 offered.
  std::string timestamp;
  std::vector<std::string> offered;
  std::size_t at = 0;
  while (true) {
    const std::size_t end = signatureHeader.find(';', at);
    const std::string part =
        signatureHeader.substr(at, end == std::string::npos ? std::string::npos : end - at);
    const std::size_t equals = part.find('=');
    if (equals != std::string::npos) {
      const std::string key = part.substr(0, equals);
      if (key == "ts") timestamp = part.substr(equals + 1);
      else if (key == "h1") offered.push_back(part.substr(equals + 1));
    }
    if (end == std::string::npos) break;
    at = end + 1;
  }
  if (offered.empty()) return false;
  // Refuse a stale signature, so a delivery captured off the wire can't be replayed later — one
  // window, shared with the Svix verifier (adapters/http/WebhookFreshness.h).
  if (!signedWithinWindow(timestamp, nowMs, toleranceMs)) return false;

  const std::string signedPayload = timestamp + ":" + body;
  unsigned char mac[EVP_MAX_MD_SIZE];
  unsigned int macLength = 0;
  if (HMAC(EVP_sha256(), secret.data(), static_cast<int>(secret.size()),
           reinterpret_cast<const unsigned char*>(signedPayload.data()), signedPayload.size(), mac,
           &macLength) == nullptr)
    return false;
  const std::string expected = hexOf(mac, macLength);

  // Constant-time compare: a byte-by-byte early exit would leak how much of the digest matched.
  for (const std::string& candidate : offered)
    if (candidate.size() == expected.size() &&
        CRYPTO_memcmp(candidate.data(), expected.data(), expected.size()) == 0)
      return true;
  return false;
}

}

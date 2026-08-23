#include "platform/adapters/email/ResendSignature.h"

#include "platform/adapters/http/WebhookFreshness.h"

#include <drogon/utils/Utilities.h>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>

#include <cstddef>

namespace wm {

namespace {
// Trim whitespace and both quote characters off the secret: a LEADING one pushes `whsec_` off the
// front, the prefix test misses, and those six characters are fed to the decoder as key material.
// Safe because a configured value is `whsec_<base64>` end to end and neither quote is in that alphabet.
std::string configuredSecret(const std::string& raw) {
  constexpr const char* kEdgeNoise = " \t\r\n\"'";
  const std::size_t begin = raw.find_first_not_of(kEdgeNoise);
  if (begin == std::string::npos) return "";
  return raw.substr(begin, raw.find_last_not_of(kEdgeNoise) - begin + 1);
}
}

bool verifyResendSignature(const std::string& body, const std::string& messageId,
                           const std::string& timestamp, const std::string& signatureHeader,
                           const std::string& secret, std::int64_t nowMs,
                           std::int64_t toleranceMs) {
  const std::string configured = configuredSecret(secret);
  if (body.empty() || messageId.empty() || signatureHeader.empty() || configured.empty()) return false;
  // Refuse a stale signature, so a captured delivery can't be replayed (adapters/http/WebhookFreshness.h).
  if (!signedWithinWindow(timestamp, nowMs, toleranceMs)) return false;

  // `whsec_` names the encoding, not the key: Svix signs with the BYTES the base64 tail decodes to.
  // drogon's decoder is LENIENT, so a non-base64 secret decodes to the wrong bytes and fails closed.
  const std::string encoded = configured.rfind("whsec_", 0) == 0 ? configured.substr(6) : configured;
  const std::string key = drogon::utils::base64Decode(encoded);
  if (key.empty()) return false;

  const std::string signedPayload = messageId + "." + timestamp + "." + body;
  unsigned char mac[EVP_MAX_MD_SIZE];
  unsigned int macLength = 0;
  if (HMAC(EVP_sha256(), key.data(), static_cast<int>(key.size()),
           reinterpret_cast<const unsigned char*>(signedPayload.data()), signedPayload.size(), mac,
           &macLength) == nullptr)
    return false;
  const std::string expected = drogon::utils::base64Encode(mac, macLength);

  // "v1,<base64> v1,<base64>" — space-separated, more than one while a secret rotates, so matching
  // any one is enough. An entry of another version is a scheme this function cannot check.
  std::size_t at = 0;
  while (at <= signatureHeader.size()) {
    const std::size_t end = signatureHeader.find(' ', at);
    const std::string entry =
        signatureHeader.substr(at, end == std::string::npos ? std::string::npos : end - at);
    if (entry.rfind("v1,", 0) == 0) {
      const std::string offered = entry.substr(3);
      // Constant-time compare: a byte-by-byte early exit would leak how much of the digest matched.
      if (offered.size() == expected.size() &&
          CRYPTO_memcmp(offered.data(), expected.data(), expected.size()) == 0)
        return true;
    }
    if (end == std::string::npos) break;
    at = end + 1;
  }
  return false;
}

}

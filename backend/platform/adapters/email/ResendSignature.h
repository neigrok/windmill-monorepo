#pragma once

#include <cstdint>
#include <string>

namespace wm {

// Verify a Resend webhook's Svix headers against the EXACT bytes received — reserializing parsed
// JSON changes them. The signed payload is `{svix-id}.{svix-timestamp}.{raw body}`, the key is the
// base64 body of the `whsec_…` secret, the digest is base64, and offered signatures arrive
// space-separated as `v1,<digest>`. A stale timestamp is refused (adapters/http/WebhookFreshness.h);
// toleranceMs 0 skips that check. The secret is trimmed of surrounding whitespace and quotes; an
// empty secret refuses everything.
bool verifyResendSignature(const std::string& body, const std::string& messageId,
                           const std::string& timestamp, const std::string& signatureHeader,
                           const std::string& secret, std::int64_t nowMs,
                           std::int64_t toleranceMs = 300000);

}

#pragma once

#include <cstdint>
#include <string>

namespace wm {

// Verify a Resend webhook's Svix headers against the raw request body. The signed payload is
// `{svix-id}.{svix-timestamp}.{raw body}`, the key is the base64 BODY of the `whsec_…` secret, the
// digest is base64, and the offered signatures arrive space-separated as `v1,<digest>`.
//
// The body must be the exact bytes received — reserializing parsed JSON changes them. A stale
// timestamp is refused so a captured delivery can't be replayed (adapters/http/WebhookFreshness.h);
// pass toleranceMs 0 to skip that check (tests only). The secret is trimmed of the whitespace and
// quotes an env file leaves around a value. An empty secret refuses everything.
bool verifyResendSignature(const std::string& body, const std::string& messageId,
                           const std::string& timestamp, const std::string& signatureHeader,
                           const std::string& secret, std::int64_t nowMs,
                           std::int64_t toleranceMs = 300000);

}

#pragma once

#include <cstdint>
#include <string>

namespace wm {

// Verify a Resend webhook's Svix headers against the raw request body.
//
// Resend delivers through Svix, whose scheme is NOT Paddle's (adapters/paddle/PaddleSignature.h)
// and cannot borrow its verifier: the signed payload is `{svix-id}.{svix-timestamp}.{raw body}`
// rather than `<ts>:<body>`, the key is the base64 BODY of the `whsec_…` secret rather than the
// printed string, the digest is base64 rather than hex, and the offered signatures arrive
// space-separated as `v1,<digest>` in their own header rather than semicolon-separated beside the
// timestamp. Four differences in four fields — one function trying to be both would be a
// configuration flag away from checking the wrong scheme, so they are siblings that share a shape,
// an OpenSSL HMAC-SHA256 and a constant-time compare, and nothing else.
//
// The body must be the exact bytes received: reserializing parsed JSON changes them and the digest
// will not match. A stale timestamp is refused so a captured delivery can't be replayed (the window
// is shared with Paddle's verifier — adapters/http/WebhookFreshness.h); pass toleranceMs 0 to skip
// that check (tests only). The secret is trimmed of the whitespace and quotes an env file leaves
// around a value, because a leading one silently costs the `whsec_` prefix and takes the endpoint
// dark. An empty secret refuses everything, which is the only safe reading of an unconfigured
// verifier.
bool verifyResendSignature(const std::string& body, const std::string& messageId,
                           const std::string& timestamp, const std::string& signatureHeader,
                           const std::string& secret, std::int64_t nowMs,
                           std::int64_t toleranceMs = 300000);

}

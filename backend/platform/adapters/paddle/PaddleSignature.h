#pragma once

#include <cstdint>
#include <string>

namespace wm {

// Verify a Paddle webhook's `Paddle-Signature` header against the raw request body.
//
// Paddle signs `<ts>:<raw body>` with HMAC-SHA256 under the notification destination's endpoint
// secret, and sends `ts=<unix seconds>;h1=<hex digest>` — more than one h1 while a secret rotates.
// The body must be the exact bytes received: reserializing parsed JSON changes them and the digest
// will not match. A stale timestamp is refused so a captured delivery can't be replayed; pass
// toleranceMs 0 to skip that check (tests only).
bool verifyPaddleSignature(const std::string& body, const std::string& signatureHeader,
                           const std::string& secret, std::int64_t nowMs,
                           std::int64_t toleranceMs = 300000);

}

#pragma once

#include <cstdint>
#include <string>

namespace wm {

// Verify a Paddle webhook's `Paddle-Signature` header against the EXACT bytes received —
// reserializing parsed JSON changes them. Paddle signs `<ts>:<raw body>` with HMAC-SHA256 under the
// notification destination's endpoint secret and sends `ts=<unix seconds>;h1=<hex digest>`, with
// more than one h1 while a secret rotates. A stale timestamp is refused; toleranceMs 0 skips that
// check.
bool verifyPaddleSignature(const std::string& body, const std::string& signatureHeader,
                           const std::string& secret, std::int64_t nowMs,
                           std::int64_t toleranceMs = 300000);

}

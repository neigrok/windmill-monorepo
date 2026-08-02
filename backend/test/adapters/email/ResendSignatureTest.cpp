#include "platform/adapters/email/ResendSignature.h"
#include "test/testing.h"

#include <cstdint>
#include <string>

using namespace wm;

namespace {
// A known-good vector computed independently (python hmac-sha256 over "{id}.{ts}.{body}", keyed by
// the base64-DECODED tail of the secret, digest base64-encoded), so these assert the Svix scheme
// itself rather than mirroring the implementation back at itself.
const std::string kSecret = "whsec_d2luZG1pbGwtcmVzZW5kLXRlc3Qtc2VjcmV0LWtleSE=";
const std::string kMessageId = "msg_2gTQ4hK1nZpV9wXcLm3Rd7Yb";
const std::string kTimestamp = "1700000000";
const std::string kBody =
    R"({"type":"email.bounced","data":{"to":["sam@example.com"],"bounce":{"type":"Permanent","subType":"General"}}})";
const std::string kDigest = "fNLJEV/UPBJFGVq7glfW0abPqLqEKexY9Rcc8kmiM0w=";
const std::int64_t kSignedAtMs = 1700000000LL * 1000;

std::string header(const std::string& digest) { return "v1," + digest; }
}

TEST(resend_signature_accepts_a_genuine_delivery) {
  CHECK(verifyResendSignature(kBody, kMessageId, kTimestamp, header(kDigest), kSecret, kSignedAtMs));
}

// The secret is printed with a whsec_ prefix and signs with the BYTES its base64 tail decodes to.
// A verifier that keyed on the printed string would refuse every genuine delivery, so both the
// prefixed and the bare form must key identically.
TEST(resend_signature_keys_on_the_decoded_secret_not_the_printed_one) {
  const std::string bare = "d2luZG1pbGwtcmVzZW5kLXRlc3Qtc2VjcmV0LWtleSE=";
  CHECK(verifyResendSignature(kBody, kMessageId, kTimestamp, header(kDigest), bare, kSignedAtMs));
  // The printed string used verbatim as the key is a different key, and must not verify.
  CHECK_FALSE(verifyResendSignature(kBody, kMessageId, kTimestamp, header(kDigest),
                                    "windmill-resend-test-secret-key!", kSignedAtMs));
}

TEST(resend_signature_refuses_a_tampered_body) {
  const std::string tampered =
      R"({"type":"email.bounced","data":{"to":["mallory@example.com"],"bounce":{"type":"Permanent","subType":"General"}}})";
  CHECK_FALSE(
      verifyResendSignature(tampered, kMessageId, kTimestamp, header(kDigest), kSecret, kSignedAtMs));
}

TEST(resend_signature_refuses_a_foreign_secret) {
  const std::string foreign = "whsec_YS1jb21wbGV0ZWx5LWRpZmZlcmVudC1zaWduaW5nLWtleQ==";
  CHECK_FALSE(
      verifyResendSignature(kBody, kMessageId, kTimestamp, header(kDigest), foreign, kSignedAtMs));
  // ...and the digest that secret WOULD have produced does not pass under ours either.
  CHECK_FALSE(verifyResendSignature(kBody, kMessageId, kTimestamp,
                                    header("f/EGc/bFv7+/b35MLvPAMZzo3mQRhp1AgZ9js/llLyw="), kSecret,
                                    kSignedAtMs));
}

// Both the id and the timestamp are inside the signed payload, so neither can be swapped for
// another value: a captured delivery cannot be re-labelled or refreshed into the tolerance window.
TEST(resend_signature_refuses_a_swapped_id_or_timestamp) {
  CHECK_FALSE(verifyResendSignature(kBody, "msg_someone_elses", kTimestamp, header(kDigest), kSecret,
                                    kSignedAtMs));
  CHECK_FALSE(verifyResendSignature(kBody, kMessageId, "1700000001", header(kDigest), kSecret,
                                    1700000001LL * 1000));
}

TEST(resend_signature_refuses_a_stale_delivery_outside_the_tolerance) {
  const std::int64_t muchLater = kSignedAtMs + 600000;  // ten minutes past a five-minute tolerance
  CHECK_FALSE(
      verifyResendSignature(kBody, kMessageId, kTimestamp, header(kDigest), kSecret, muchLater));
  // A delivery from the future is refused by the same window — a clock that stepped is not a reason
  // to accept a signature minted hours ahead of now.
  CHECK_FALSE(verifyResendSignature(kBody, kMessageId, kTimestamp, header(kDigest), kSecret,
                                    kSignedAtMs - 600000));
  // ...and it is accepted again once the tolerance is wide enough to cover the drift.
  CHECK(verifyResendSignature(kBody, kMessageId, kTimestamp, header(kDigest), kSecret, muchLater,
                              900000));
}

// A destination mid-rotation signs with both secrets and sends a v1 entry for each, space separated;
// matching either is enough, so a rotation never drops a delivery.
TEST(resend_signature_accepts_one_matching_digest_among_several) {
  const std::string rotating = "v1,f/EGc/bFv7+/b35MLvPAMZzo3mQRhp1AgZ9js/llLyw= v1," + kDigest;
  CHECK(verifyResendSignature(kBody, kMessageId, kTimestamp, rotating, kSecret, kSignedAtMs));
}

// A version this function cannot check must never be mistaken for one it can: an unversioned or
// v2-labelled entry carrying our digest is not a v1 signature.
TEST(resend_signature_only_ever_checks_a_v1_entry) {
  CHECK_FALSE(verifyResendSignature(kBody, kMessageId, kTimestamp, kDigest, kSecret, kSignedAtMs));
  CHECK_FALSE(
      verifyResendSignature(kBody, kMessageId, kTimestamp, "v2," + kDigest, kSecret, kSignedAtMs));
}

TEST(resend_signature_refuses_malformed_or_empty_input) {
  CHECK_FALSE(verifyResendSignature(kBody, kMessageId, kTimestamp, "", kSecret, kSignedAtMs));
  CHECK_FALSE(verifyResendSignature("", kMessageId, kTimestamp, header(kDigest), kSecret, kSignedAtMs));
  CHECK_FALSE(verifyResendSignature(kBody, "", kTimestamp, header(kDigest), kSecret, kSignedAtMs));
  CHECK_FALSE(verifyResendSignature(kBody, kMessageId, "", header(kDigest), kSecret, kSignedAtMs));
  // An unconfigured secret refuses everything — the whole point of an unarmed verifier.
  CHECK_FALSE(verifyResendSignature(kBody, kMessageId, kTimestamp, header(kDigest), "", kSignedAtMs));
  CHECK_FALSE(
      verifyResendSignature(kBody, kMessageId, kTimestamp, header(kDigest), "whsec_", kSignedAtMs));
  CHECK_FALSE(verifyResendSignature(kBody, kMessageId, "notanumber", header(kDigest), kSecret,
                                    kSignedAtMs));
  CHECK_FALSE(verifyResendSignature(kBody, kMessageId, kTimestamp, "garbage", kSecret, kSignedAtMs));
  // A truncated digest must not pass on a prefix match.
  CHECK_FALSE(verifyResendSignature(kBody, kMessageId, kTimestamp, header(kDigest.substr(0, 20)),
                                    kSecret, kSignedAtMs));
}

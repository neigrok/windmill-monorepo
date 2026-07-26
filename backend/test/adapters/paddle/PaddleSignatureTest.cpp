#include "platform/adapters/paddle/PaddleSignature.h"
#include "test/testing.h"

using namespace wm;

namespace {
// A known-good vector computed independently (python hmac-sha256 over "<ts>:<body>"), so these
// assert the Paddle scheme itself rather than mirroring the implementation back at itself.
const std::string kSecret = "pdl_ntfset_test_secret";
const std::string kTimestamp = "1700000000";
const std::string kBody = R"({"event_type":"subscription.created","data":{"id":"sub_1"}})";
const std::string kDigest = "9b265505f2a7ccaa74d1d525067b8141f08f387b5fed5e1471db1788ff1e537e";
const std::int64_t kSignedAtMs = 1700000000LL * 1000;

std::string header(const std::string& timestamp, const std::string& digest) {
  return "ts=" + timestamp + ";h1=" + digest;
}
}

TEST(paddle_signature_accepts_a_genuine_delivery) {
  CHECK(verifyPaddleSignature(kBody, header(kTimestamp, kDigest), kSecret, kSignedAtMs));
}

TEST(paddle_signature_refuses_a_tampered_body) {
  const std::string tampered = R"({"event_type":"subscription.created","data":{"id":"sub_2"}})";
  CHECK_FALSE(verifyPaddleSignature(tampered, header(kTimestamp, kDigest), kSecret, kSignedAtMs));
}

TEST(paddle_signature_refuses_a_foreign_secret) {
  CHECK_FALSE(verifyPaddleSignature(kBody, header(kTimestamp, kDigest), "pdl_ntfset_other", kSignedAtMs));
}

// The timestamp is inside the signed payload, so moving it invalidates the digest — a replay can't
// be refreshed into the tolerance window.
TEST(paddle_signature_refuses_a_swapped_timestamp) {
  CHECK_FALSE(verifyPaddleSignature(kBody, header("1700000001", kDigest), kSecret, kSignedAtMs));
}

TEST(paddle_signature_refuses_a_stale_delivery_outside_the_tolerance) {
  const std::int64_t muchLater = kSignedAtMs + 600000;  // ten minutes past a five-minute tolerance
  CHECK_FALSE(verifyPaddleSignature(kBody, header(kTimestamp, kDigest), kSecret, muchLater));
  // ...and is accepted again once the tolerance is wide enough to cover the drift.
  CHECK(verifyPaddleSignature(kBody, header(kTimestamp, kDigest), kSecret, muchLater, 900000));
}

// A destination mid-rotation signs with both secrets and sends an h1 for each; matching either is
// enough, so a rotation never drops a delivery.
TEST(paddle_signature_accepts_one_matching_digest_among_several) {
  const std::string rotating = "ts=" + kTimestamp + ";h1=" + std::string(64, 'a') + ";h1=" + kDigest;
  CHECK(verifyPaddleSignature(kBody, rotating, kSecret, kSignedAtMs));
}

TEST(paddle_signature_refuses_malformed_or_empty_input) {
  CHECK_FALSE(verifyPaddleSignature(kBody, "", kSecret, kSignedAtMs));                    // no header
  CHECK_FALSE(verifyPaddleSignature("", header(kTimestamp, kDigest), kSecret, kSignedAtMs));  // no body
  CHECK_FALSE(verifyPaddleSignature(kBody, header(kTimestamp, kDigest), "", kSignedAtMs));    // no secret
  CHECK_FALSE(verifyPaddleSignature(kBody, "h1=" + kDigest, kSecret, kSignedAtMs));       // no ts
  CHECK_FALSE(verifyPaddleSignature(kBody, "ts=" + kTimestamp, kSecret, kSignedAtMs));    // no h1
  CHECK_FALSE(verifyPaddleSignature(kBody, "ts=notanumber;h1=" + kDigest, kSecret, kSignedAtMs));
  CHECK_FALSE(verifyPaddleSignature(kBody, "garbage", kSecret, kSignedAtMs));
  // A truncated digest must not pass on a prefix match.
  CHECK_FALSE(verifyPaddleSignature(kBody, header(kTimestamp, kDigest.substr(0, 32)), kSecret, kSignedAtMs));
}

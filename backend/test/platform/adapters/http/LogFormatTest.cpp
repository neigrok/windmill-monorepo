#include "platform/adapters/http/LogFormat.h"
#include "test/testing.h"

using namespace wm;

TEST(log_privacy_discards_vendor_and_framework_request_details_including_secret_queries) {
  const std::string secret = "GET /v1/auth/google/callback?code=PRIVATE_TOKEN&email=PRIVATE_EMAIL\n"
      "cookie: wm_session=PRIVATE_COOKIE\nexception: PRIVATE_JOURNAL_TEXT";
  for (const char* source : {"HttpAppFrameworkImpl.cc:97", "HttpClientImpl.cc:201", "HttpServer.cc:30", ""})
    CHECK_EQ(privacySafeLogBody(secret, source), std::string("framework diagnostic suppressed"));
  CHECK_EQ(privacySafeLogBody(secret, "/vendor/path/HttpAppFrameworkImpl.cc:97"),
           std::string("framework diagnostic suppressed"));
}

TEST(log_privacy_source_contains_only_a_bounded_filename_and_line) {
  CHECK_EQ(privacySafeLogSource("/private/user-directory/HttpAppFrameworkImpl.cc:97"),
           std::string("HttpAppFrameworkImpl.cc:97"));
  CHECK_EQ(privacySafeLogSource("../source/WriteObservation.cpp:115"), std::string("WriteObservation.cpp:115"));
  CHECK_EQ(privacySafeLogSource("secret query?token=PRIVATE:12"), std::string());
  CHECK_EQ(privacySafeLogSource("missing-line.cpp:"), std::string());
  CHECK_EQ(privacySafeLogSource("body.cpp:not-a-line"), std::string());
  CHECK_EQ(privacySafeLogSource(std::string(97, 'a') + ".cpp:12"), std::string());
}

TEST(log_privacy_keeps_audited_write_vendor_and_database_completion_lines) {
  const std::string completion = "write {\"operation\":\"gym.write\",\"outcome\":\"ok\"}";
  CHECK_EQ(privacySafeLogBody(completion, "WriteObservation.cpp:115"), completion);
  CHECK_EQ(privacySafeLogBody("vendor openai transcribe 200 10.5ms", "VendorCall.cpp:91"),
           std::string("vendor openai transcribe 200 10.5ms"));
  CHECK_EQ(privacySafeLogBody(completion, "PgAiUsageRepository.cpp:61"), completion);
}

TEST(log_privacy_redacts_capabilities_and_secret_query_strings_in_full) {
  CHECK_EQ(redactedPath("/v1/gym/shared/PRIVATE_TOKEN?email=PRIVATE_EMAIL"), std::string("/v1/gym/shared/{token}"));
  CHECK_EQ(redactedPath("/v1/gym/shared-logs/PRIVATE_TOKEN?secret=PRIVATE_SECRET"),
           std::string("/v1/gym/shared-logs/{token}"));
  CHECK_EQ(redactedPath("/v1/auth/google/callback?code=PRIVATE_TOKEN&state=PRIVATE_STATE"),
           std::string("/v1/auth/google/callback"));
  CHECK_EQ(redactedPath("/v1/auth/google/callback#PRIVATE_TOKEN"), std::string("/v1/auth/google/callback"));
}

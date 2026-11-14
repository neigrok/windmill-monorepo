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
  CHECK_EQ(privacySafeLogBody("roadmap_ws_subscriber_dropped door=websocket rule=behind queued=under-64m idle_ms=0", "WsPresenceBus.cpp:20"),
           std::string("roadmap_ws_subscriber_dropped door=websocket rule=behind queued=under-64m idle_ms=0"));
  CHECK_EQ(privacySafeLogBody("closed accounts: erased 2 past their grace", "ClosedAccountSweep.h:29"),
           std::string("closed accounts: erased 2 past their grace"));
  CHECK_EQ(privacySafeLogBody("subscription follow: the cursor has stalled (cause=behind behind=20)", "FeedFollower.cpp:137"),
           std::string("subscription follow: the cursor has stalled (cause=behind behind=20)"));
  const std::string admission = "ai_output_admission input_nanos=60000000 output_token_nanos=25000 "
      "min_tokens=1024 max_tokens=2000 selected_tokens=1200 code=ok";
  CHECK_EQ(privacySafeLogBody(admission, "AiCallBudget.cpp:200"), admission);
  const std::string follows = "roadmap_gallery_follows followed=3 timed_out=1 failed=0 cooling_off=2 past_cap=0";
  CHECK_EQ(privacySafeLogBody(follows, "GalleryApi.cpp:54"), follows);
  const std::string recovered = "roadmap_progress_follow_recovered door=rest degraded_replies=7";
  CHECK_EQ(privacySafeLogBody(recovered, "OwnerProgress.cpp:114"), recovered);
  const std::string cascade = "roadmap_tree_remove_cascade door=rest trees=4 steps=3 edges=1 marks=1 removed=2 unsaved=1 "
      "incomplete=1 duration_ms=1203 request_id=0123456789abcdef0123456789abcdef";
  CHECK_EQ(privacySafeLogBody(cascade, "TreeRegistry.cpp:161"), cascade);
  const std::string fork = "roadmap_tree_fork trees=100 duration_ms=179 request_id=0123456789abcdef0123456789abcdef";
  CHECK_EQ(privacySafeLogBody(fork, "ForkService.cpp:83"), fork);
  const std::string lateLanding = "roadmap_late_landing door=websocket registers=2";
  CHECK_EQ(privacySafeLogBody(lateLanding, "TreeRoom.cpp:121"), lateLanding);
  const std::string lateEntries = "roadmap_subscribe_late_entries entries=3";
  CHECK_EQ(privacySafeLogBody(lateEntries, "Collab.cpp:243"), lateEntries);
}

TEST(log_privacy_redacts_capabilities_and_secret_query_strings_in_full) {
  CHECK_EQ(redactedPath("/v1/gym/shared/PRIVATE_TOKEN?email=PRIVATE_EMAIL"), std::string("/v1/gym/shared/{token}"));
  CHECK_EQ(redactedPath("/v1/gym/shared-logs/PRIVATE_TOKEN?secret=PRIVATE_SECRET"),
           std::string("/v1/gym/shared-logs/{token}"));
  CHECK_EQ(redactedPath("/v1/auth/google/callback?code=PRIVATE_TOKEN&state=PRIVATE_STATE"),
           std::string("/v1/auth/google/callback"));
  CHECK_EQ(redactedPath("/v1/auth/google/callback#PRIVATE_TOKEN"), std::string("/v1/auth/google/callback"));
}

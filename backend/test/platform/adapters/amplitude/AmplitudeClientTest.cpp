#include "platform/adapters/amplitude/AmplitudeClient.h"

#include "platform/adapters/json/JsonText.h"
#include "test/testing.h"

using namespace wm;

TEST(amplitude_native_events_keep_the_platform_identity_outcome_and_stable_dedupe_key) {
  const std::vector<FunnelEvent> events{
      {"gym_ask_started", 1000, R"({"platform":"android"})"},
      {"gym_ask_outcome", 2000,
       R"({"failure_kind":"timeout","outcome":"failed","platform":"android"})"}};

  const Json::Value payload = amplitudeEvents("session-123", UserId{"user-123"}, events);

  CHECK_EQ(dump(payload), std::string(
      R"([{"device_id":"session-123","event_properties":{"platform":"android"},)"
      R"("event_type":"gym_ask_started","insert_id":"session-123::1000:gym_ask_started:0",)"
      R"("platform":"Android","time":1000,"user_id":"user-123"},)"
      R"({"device_id":"session-123","event_properties":{"failure_kind":"timeout",)"
      R"("outcome":"failed","platform":"android"},"event_type":"gym_ask_outcome",)"
      R"("insert_id":"session-123::2000:gym_ask_outcome:1","platform":"Android",)"
      R"("time":2000,"user_id":"user-123"}])"));
  CHECK_EQ(amplitudeEvents("session-123", UserId{"user-123"}, events), payload);
}

TEST(amplitude_server_spend_does_not_acquire_a_client_platform) {
  const Json::Value payload = amplitudeEvents(
      "server", UserId{"user-123"}, {{"ai_spend", 1000, R"({"product":"gym"})"}}, "ask-1/0");

  CHECK_EQ(dump(payload), std::string(
      R"([{"device_id":"server","event_properties":{"product":"gym"},"event_type":"ai_spend",)"
      R"("insert_id":"server:ask-1/0:1000:ai_spend:0","time":1000,"user_id":"user-123"}])"));
}

TEST(amplitude_event_ids_survive_a_retry_in_a_different_batch) {
  const FunnelEvent first{"gym_ask_started", 1000, R"({"platform":"android"})", "event-1"};
  const FunnelEvent second{"gym_ask_outcome", 1000, R"({"platform":"android"})", "event-2"};

  const Json::Value together = amplitudeEvents("session-123", std::nullopt, {first, second});
  const Json::Value retry = amplitudeEvents("session-123", std::nullopt, {second});

  CHECK_EQ(together[1], retry[0]);
  CHECK_EQ(dump(retry), std::string(
      R"([{"device_id":"session-123","event_properties":{"platform":"android"},)"
      R"("event_type":"gym_ask_outcome","insert_id":"session-123:event-2",)"
      R"("platform":"Android","time":1000}])"));
}

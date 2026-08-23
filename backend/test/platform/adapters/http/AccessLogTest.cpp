#include "platform/adapters/http/AccessLog.h"

#include "test/testing.h"

#include <string>

using namespace wm;

TEST(access_log_levels_split_our_failures_from_refusals_from_traffic) {
  CHECK(severityForStatus(200) == Severity::info);
  CHECK(severityForStatus(201) == Severity::info);
  CHECK(severityForStatus(304) == Severity::info);
  CHECK(severityForStatus(399) == Severity::info);
  CHECK(severityForStatus(400) == Severity::warn);
  CHECK(severityForStatus(401) == Severity::warn);
  CHECK(severityForStatus(409) == Severity::warn);
  CHECK(severityForStatus(499) == Severity::warn);
  CHECK(severityForStatus(500) == Severity::error);
  CHECK(severityForStatus(503) == Severity::error);
}

TEST(access_log_line_carries_the_verb_route_status_cost_and_caller) {
  CHECK_EQ(accessLine("POST", "/v1/gym/sessions", 200, 12'300, "u_8f3"),
           std::string("http POST /v1/gym/sessions 200 12.3ms caller=u_8f3"));
}

TEST(access_log_says_anon_rather_than_dropping_the_caller_field) {
  CHECK_EQ(accessLine("GET", "/v1/trees", 200, 900, ""),
           std::string("http GET /v1/trees 200 0.9ms caller=anon"));
}

TEST(access_log_keeps_one_decimal_so_fast_and_free_stay_different) {
  CHECK_EQ(accessLine("GET", "/v1/me", 200, 40, ""), std::string("http GET /v1/me 200 0.0ms caller=anon"));
  CHECK_EQ(accessLine("GET", "/v1/me", 200, 450, ""), std::string("http GET /v1/me 200 0.4ms caller=anon"));
  CHECK_EQ(accessLine("GET", "/v1/me", 200, 1'000'000, ""),
           std::string("http GET /v1/me 200 1000.0ms caller=anon"));
}

TEST(access_log_admits_an_unmeasured_request_instead_of_inventing_a_duration) {
  CHECK_EQ(accessLine("GET", "/v1/me", 200, -1, ""), std::string("http GET /v1/me 200 ?ms caller=anon"));
}

// The token in `/v1/gym/shared/{token}` is a live capability, so the line keeps enough to tie two reads of one link together and no more.
TEST(access_log_cuts_a_capability_token_out_of_the_path_it_rides_in) {
  CHECK_EQ(accessLine("GET", "/v1/gym/shared/9hvKmReOUhBljovMD9kFkralo4JNiL9DjEnNIjWWkF8", 200,
                      2'300, ""),
           std::string("http GET /v1/gym/shared/9hvKmReO~redacted 200 2.3ms caller=anon"));
  CHECK_EQ(redactedPath("/v1/gym/shared/9hvKmReOUhBljovMD9kFkralo4JNiL9DjEnNIjWWkF8"),
           std::string("/v1/gym/shared/9hvKmReO~redacted"));

  CHECK_EQ(redactedPath("/v1/gym/sessions/s_8f3/sets"), std::string("/v1/gym/sessions/s_8f3/sets"));
  CHECK_EQ(redactedPath("/v1/gym/shared/"), std::string("/v1/gym/shared/"));
  CHECK_EQ(redactedPath("/v1/gym/shared"), std::string("/v1/gym/shared"));
}

// Drogon URL-DECODES the path, so `%0a` arrives as a real newline. Percent-encoding puts it back on one line.
TEST(access_log_cannot_be_split_into_a_second_forged_line_by_a_control_character) {
  const std::string forged =
      "/v1/sessions/abc\n20260816 99:99:99.000000 UTC 1 ERROR auth: account closed "
      "user=INJECTED - AuthService.cpp:269";
  const std::string line = accessLine("DELETE", forged, 401, 40, "");

  CHECK_EQ(line.find('\n'), std::string::npos);
  CHECK_EQ(line,
           std::string("http DELETE /v1/sessions/abc%0A20260816 99:99:99.000000 UTC 1 ERROR auth: "
                       "account closed user=INJECTED - AuthService.cpp:269 401 0.0ms caller=anon"));

  CHECK_EQ(accessLine("GE\rT", "/v1/me", 200, 40, "u_1\nfake"),
           std::string("http GE%0DT /v1/me 200 0.0ms caller=u_1%0Afake"));
  CHECK_EQ(loggableField("plain/path-1_2.3"), std::string("plain/path-1_2.3"));
}

// Drogon ROUTES case-insensitively and `path()` preserves what the caller typed, so the redaction table must be case-insensitive.
TEST(access_log_redacts_a_capability_token_however_the_caller_cased_the_route) {
  const std::string token = "9hvKmReOUhBljovMD9kFkralo4JNiL9DjEnNIjWWkF8";

  CHECK_EQ(redactedPath("/V1/GYM/SHARED/" + token),
           std::string("/V1/GYM/SHARED/9hvKmReO~redacted"));
  CHECK_EQ(redactedPath("/v1/Gym/Shared/" + token), std::string("/v1/Gym/Shared/9hvKmReO~redacted"));
  // The kept prefix is spliced out of the ORIGINAL, so the token's own casing is never altered.
  CHECK_EQ(redactedPath("/V1/gym/SHARED/AbCdEfGhIjKl"), std::string("/V1/gym/SHARED/AbCdEfGh~redacted"));
}

TEST(access_log_caps_a_field_a_stranger_can_make_as_long_as_they_like) {
  const std::string huge = "/v1/me/" + std::string(60'000, 'a');
  const std::string line = accessLine("GET", huge, 404, 900, "");

  // "http GET " + 1024 kept bytes + "~truncated" + " 404 0.9ms caller=anon"; the cut is said out loud.
  CHECK_EQ(line.size(), std::size_t{9 + 1'024 + 10 + 22});
  CHECK(line.find("aaa~truncated 404 0.9ms caller=anon") != std::string::npos);

  // The cap is measured on what is WRITTEN: control bytes triple on the way through, so 341 encoded newlines carry it past 1024.
  CHECK_EQ(loggableField(std::string(2'000, '\n')).size(), std::size_t{1'026 + 10});
  CHECK_EQ(loggableField(std::string(1'024, 'a')), std::string(1'024, 'a'));   // exactly at the cap
}

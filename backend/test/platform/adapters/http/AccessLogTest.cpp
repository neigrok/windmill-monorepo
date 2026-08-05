#include "platform/adapters/http/AccessLog.h"

#include "test/testing.h"

#include <string>

using namespace wm;

// The mapping an alert is built on: level alone has to separate "we broke" from "they were refused"
// from "traffic". Widening any of these silently is how a 500 stops paging anyone.
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

// A write with no answer to "who did this" is the shape of a bug. Omitting the field would read as
// a logger that forgot; naming it reads as a caller that had no session, which is the truth.
TEST(access_log_says_anon_rather_than_dropping_the_caller_field) {
  CHECK_EQ(accessLine("GET", "/v1/trees", 200, 900, ""),
           std::string("http GET /v1/trees 200 0.9ms caller=anon"));
}

// Sub-millisecond work is most of a local handler's life; rounding it to 0ms would erase the
// difference between fast and free, which is where a regression shows first.
TEST(access_log_keeps_one_decimal_so_fast_and_free_stay_different) {
  CHECK_EQ(accessLine("GET", "/v1/me", 200, 40, ""), std::string("http GET /v1/me 200 0.0ms caller=anon"));
  CHECK_EQ(accessLine("GET", "/v1/me", 200, 450, ""), std::string("http GET /v1/me 200 0.4ms caller=anon"));
  CHECK_EQ(accessLine("GET", "/v1/me", 200, 1'000'000, ""),
           std::string("http GET /v1/me 200 1000.0ms caller=anon"));
}

// An un-stamped request must admit the gap rather than print a plausible 0.0ms — an invented
// number in a latency log is worse than an obvious hole in one.
TEST(access_log_admits_an_unmeasured_request_instead_of_inventing_a_duration) {
  CHECK_EQ(accessLine("GET", "/v1/me", 200, -1, ""), std::string("http GET /v1/me 200 ?ms caller=anon"));
}

#include "test/products/gym/adapters/http/GymApiFixture.h"

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

using namespace wm;
using namespace wm::fake;
using namespace wm::gym;
using namespace wm::gym::fake;
using namespace wm::gym::apitest;

// BodyweightApi over the fake store: the wire every client codes against, byte for byte.

namespace {

// A weigh-in as the store holds it: kilograms to two decimals, which the entity rounds to.
void weighed(Harness& h, const UserId& lifter, const std::string& day, double weightKg,
             std::uint64_t recordedAt = 1'786'000'000'000ull) {
  h.repo.db.bodyweightRows.push_back(Bodyweight{lifter, day, weightKg, recordedAt});
}

// The window rides as query parameters, set on the request as Drogon would parse them.
drogon::HttpResponsePtr list(Harness& h, const std::string& from = "", const std::string& to = "",
                             const std::string& cookie = "s-live") {
  drogon::HttpRequestPtr request = getRequest("/v1/gym/bodyweight", cookie);
  if (!from.empty()) request->setParameter("from", from);
  if (!to.empty()) request->setParameter("to", to);
  return send(h.bodyweight, &BodyweightApi::listEntries, request);
}

}  // namespace

TEST(gym_bodyweight_lists_nothing_then_the_days_ascending_with_the_newest_as_latest) {
  Harness h;
  const UserId me = h.signIn("s-live");

  CHECK_EQ(dump(bodyOf(list(h))), std::string(R"({"entries":[],"latest":null})"));

  weighed(h, me, "2026-08-25", 82.5);
  weighed(h, me, "2026-08-01", 83.0, 1'784'000'000'000ull);

  // Day ascending, and `latest` is the newest DAY, not the last write.
  CHECK_EQ(dump(bodyOf(list(h))),
           std::string(R"({"entries":[)"
                       R"({"dateLocal":"2026-08-01","recordedAt":1784000000000,"weightKg":83.0},)"
                       R"({"dateLocal":"2026-08-25","recordedAt":1786000000000,"weightKg":82.5}],)"
                       R"("latest":{"dateLocal":"2026-08-25","recordedAt":1786000000000,)"
                       R"("weightKg":82.5}})"));
}

// B3: `weightKg` crosses the wire as the two decimals the lifter wrote — the reply's own bytes, as
// Drogon writes them, read `82.4` and never `82.400000000000006`. A set's load already did (82.5
// is an exact double); a weigh-in's two decimals rarely are, so the bytes are pinned here.
TEST(gym_bodyweight_writes_two_decimals_of_kilograms_on_the_wire) {
  Harness h;
  const UserId me = h.signIn("s-live");
  weighed(h, me, "2026-08-25", 82.4);
  weighed(h, me, "2026-08-24", 81.95);
  weighed(h, me, "2026-08-23", 82.456);

  const drogon::HttpResponsePtr listed = list(h);

  const std::string listedBytes(listed->getBody());
  CHECK_EQ(listedBytes,
           std::string(R"({"entries":[)"
                       R"({"dateLocal":"2026-08-23","recordedAt":1786000000000,"weightKg":82.46},)"
                       R"({"dateLocal":"2026-08-24","recordedAt":1786000000000,"weightKg":81.95},)"
                       R"({"dateLocal":"2026-08-25","recordedAt":1786000000000,"weightKg":82.4}],)"
                       R"("latest":{"dateLocal":"2026-08-25","recordedAt":1786000000000,)"
                       R"("weightKg":82.4}})"));
  // `dump` — what the MCP text and every pin in this file are written with — agrees byte for byte.
  CHECK_EQ(dump(bodyOf(listed)), listedBytes);
}

// The window: both bounds inclusive, either omitted; `latest` stays the account's newest day so
// one windowed read draws the chart and the reading at the head of the log.
TEST(gym_bodyweight_window_is_inclusive_and_latest_ignores_it) {
  Harness h;
  const UserId me = h.signIn("s-live");
  weighed(h, me, "2026-07-04", 84.0, 1'783'000'000'000ull);
  weighed(h, me, "2026-08-01", 83.2, 1'784'000'000'000ull);
  weighed(h, me, "2026-08-03", 83.0, 1'785'000'000'000ull);
  weighed(h, me, "2026-08-25", 82.4, 1'786'000'000'000ull);

  const Json::Value windowed = bodyOf(list(h, "2026-08-01", "2026-08-03"));
  REQUIRE_EQ(windowed["entries"].size(), 2u);
  CHECK_EQ(windowed["entries"][0]["dateLocal"].asString(), std::string("2026-08-01"));
  CHECK_EQ(windowed["entries"][1]["dateLocal"].asString(), std::string("2026-08-03"));
  CHECK_EQ(windowed["latest"]["dateLocal"].asString(), std::string("2026-08-25"));
  CHECK_EQ(bodyOf(list(h, "2026-08-02"))["entries"].size(), 2u);
  CHECK_EQ(bodyOf(list(h, "", "2026-08-01"))["entries"].size(), 2u);
  const Json::Value empty = bodyOf(list(h, "2026-08-04", "2026-08-24"));
  CHECK_EQ(empty["entries"].size(), 0u);
  CHECK_EQ(empty["latest"]["dateLocal"].asString(), std::string("2026-08-25"));

  for (const auto& [from, to] : std::vector<std::pair<std::string, std::string>>{
           {"2026-02-30", ""}, {"", "2026-8-1"}, {"2026-08-01", "today"}, {"1786000000000", ""}}) {
    const drogon::HttpResponsePtr refused = list(h, from, to);
    CHECK_EQ(refused->getStatusCode(), drogon::k400BadRequest);
    CHECK_EQ(dump(bodyOf(refused)), std::string(R"({"error":"could not read that date"})"));
  }
}

TEST(gym_bodyweight_list_is_owner_scoped_and_401s_signed_out) {
  Harness h;
  const UserId me = h.signIn("s-live");
  weighed(h, me, "2026-08-25", 82.4);

  CHECK_EQ(list(h, "", "", "")->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(dump(bodyOf(list(h, "", "", ""))),
           std::string(R"({"error":"sign in to open your training log"})"));
  // Another account sees none of it, and its own day beside it is never this lifter's.
  const UserId other = h.signIn("s-other");
  CHECK_EQ(dump(bodyOf(list(h, "", "", "s-other"))), std::string(R"({"entries":[],"latest":null})"));
  weighed(h, other, "2026-08-25", 70.0);
  CHECK_EQ(bodyOf(list(h))["latest"]["weightKg"].asDouble(), 82.4);
}

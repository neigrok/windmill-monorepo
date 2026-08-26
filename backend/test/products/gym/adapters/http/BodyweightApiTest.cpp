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

// The shared fixture's clock reads 2023 and every day below is in 2026, and the door refuses a day
// more than one past UTC today — so each case first sets the log's now to noon UTC on 2026-08-27,
// which makes 2026-08-28 the last day the door takes.
constexpr std::uint64_t kNoonUtc27Aug2026 = 1'787'832'000'000ull;

struct Weighing : Harness {
  Weighing() { clock.now = kNoonUtc27Aug2026; }
};

Json::Value weighIn(double weightKg, std::uint64_t recordedAt = 1'786'000'000'000ull) {
  Json::Value json(Json::objectValue);
  json["weightKg"] = weightKg;
  json["recordedAt"] = Json::Value::UInt64(recordedAt);
  return json;
}

drogon::HttpResponsePtr save(Harness& h, const std::string& day, const Json::Value& body,
                             const std::string& cookie = "s-live") {
  return send(h.bodyweight, &BodyweightApi::saveEntry,
              putRequest("/v1/gym/bodyweight/" + day, body, cookie), day);
}

// The window rides as query parameters, set on the request as Drogon would parse them.
drogon::HttpResponsePtr list(Harness& h, const std::string& from = "", const std::string& to = "",
                             const std::string& cookie = "s-live") {
  drogon::HttpRequestPtr request = getRequest("/v1/gym/bodyweight", cookie);
  if (!from.empty()) request->setParameter("from", from);
  if (!to.empty()) request->setParameter("to", to);
  return send(h.bodyweight, &BodyweightApi::listEntries, request);
}

drogon::HttpResponsePtr remove(Harness& h, const std::string& day,
                               const std::string& cookie = "s-live") {
  return send(h.bodyweight, &BodyweightApi::deleteEntry,
              deleteRequest("/v1/gym/bodyweight/" + day, cookie), day);
}

}  // namespace

TEST(gym_bodyweight_lists_nothing_then_the_days_ascending_with_the_newest_as_latest) {
  Weighing h;
  h.signIn("s-live");

  CHECK_EQ(dump(bodyOf(list(h))), std::string(R"({"entries":[],"latest":null})"));

  const drogon::HttpResponsePtr first = save(h, "2026-08-25", weighIn(82.5));
  const drogon::HttpResponsePtr earlier = save(h, "2026-08-01", weighIn(83.0, 1'784'000'000'000ull));

  CHECK_EQ(first->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(first)),
           std::string(R"({"entry":{"dateLocal":"2026-08-25","recordedAt":1786000000000,)"
                       R"("weightKg":82.5}})"));
  CHECK_EQ(dump(bodyOf(earlier)),
           std::string(R"({"entry":{"dateLocal":"2026-08-01","recordedAt":1784000000000,)"
                       R"("weightKg":83.0}})"));
  // Day ascending, and `latest` is the newest DAY, not the last write.
  CHECK_EQ(dump(bodyOf(list(h))),
           std::string(R"({"entries":[)"
                       R"({"dateLocal":"2026-08-01","recordedAt":1784000000000,"weightKg":83.0},)"
                       R"({"dateLocal":"2026-08-25","recordedAt":1786000000000,"weightKg":82.5}],)"
                       R"("latest":{"dateLocal":"2026-08-25","recordedAt":1786000000000,)"
                       R"("weightKg":82.5}})"));
  // A weight with no exact double crosses as the number the lifter wrote; nothing re-rounds.
  CHECK_EQ(bodyOf(save(h, "2026-08-26", weighIn(82.4)))["entry"]["weightKg"].asDouble(), 82.4);
}

// B3: `weightKg` crosses the wire as the two decimals the lifter wrote — the reply's own bytes, as
// Drogon writes them, read `82.4` and never `82.400000000000006`. A set's load already did (82.5
// is an exact double); a weigh-in's two decimals rarely are, so the bytes are pinned here.
TEST(gym_bodyweight_writes_two_decimals_of_kilograms_on_the_wire) {
  Weighing h;
  h.signIn("s-live");

  const drogon::HttpResponsePtr saved = save(h, "2026-08-25", weighIn(82.4));
  save(h, "2026-08-24", weighIn(81.95));
  save(h, "2026-08-23", weighIn(82.456));

  const std::string savedBytes(saved->getBody());
  CHECK_EQ(savedBytes,
           std::string(R"({"entry":{"dateLocal":"2026-08-25","recordedAt":1786000000000,)"
                       R"("weightKg":82.4}})"));
  const std::string listedBytes(list(h)->getBody());
  CHECK_EQ(listedBytes,
           std::string(R"({"entries":[)"
                       R"({"dateLocal":"2026-08-23","recordedAt":1786000000000,"weightKg":82.46},)"
                       R"({"dateLocal":"2026-08-24","recordedAt":1786000000000,"weightKg":81.95},)"
                       R"({"dateLocal":"2026-08-25","recordedAt":1786000000000,"weightKg":82.4}],)"
                       R"("latest":{"dateLocal":"2026-08-25","recordedAt":1786000000000,)"
                       R"("weightKg":82.4}})"));
  // `dump` — what the MCP text and every pin in this file are written with — agrees byte for byte.
  CHECK_EQ(dump(bodyOf(saved)), savedBytes);
}

// B2, the server's half: a weigh-in is never a forecast. The phones refuse a day past the device's
// local today at the field; a local calendar can run a day ahead of UTC and no further, so the
// door takes UTC tomorrow whatever the hour and refuses the day after it — after the day is a day,
// before the body is read, so a forecast with no readable body still earns this sentence.
TEST(gym_bodyweight_refuses_a_day_more_than_one_past_utc_today) {
  Weighing h;
  h.signIn("s-live");
  const std::string forecast = "A weigh-in is not a forecast — today or earlier.";
  const auto refusal = [&](const drogon::HttpResponsePtr& response) {
    CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
    CHECK_EQ(bodyOf(response).size(), 1u);   // the sentence and nothing beside it: no code
    return bodyOf(response)["error"].asString();
  };

  constexpr std::uint64_t kFirstMsOf27Aug2026 = 1'787'788'800'000ull;
  constexpr std::uint64_t kLastMsOf27Aug2026 = 1'787'875'199'999ull;
  for (const std::uint64_t now : {kFirstMsOf27Aug2026, kLastMsOf27Aug2026}) {
    h.clock.now = now;
    CHECK_EQ(save(h, "2026-08-27", weighIn(82.4))->getStatusCode(), drogon::k200OK);   // today
    CHECK_EQ(save(h, "2026-08-28", weighIn(82.4))->getStatusCode(), drogon::k200OK);   // today + 1
    CHECK_EQ(refusal(save(h, "2026-08-29", weighIn(82.4))), forecast);                 // today + 2
    CHECK_EQ(refusal(save(h, "2027-01-01", weighIn(82.4))), forecast);
  }
  // Decided after the day and before the body: a day that is not a day keeps its own sentence, and
  // a forecast with a body nobody could read is still a forecast.
  CHECK_EQ(refusal(save(h, "2026-02-30", weighIn(82.4))), std::string("could not read that date"));
  CHECK_EQ(refusal(save(h, "2026-08-29", weighIn(500))), forecast);
  CHECK_EQ(refusal(save(h, "2026-08-29", Json::Value(Json::arrayValue))), forecast);
  auto raw = drogon::HttpRequest::newHttpRequest();
  raw->setMethod(drogon::Put);
  raw->setPath("/v1/gym/bodyweight/2026-08-29");
  raw->setContentTypeCode(drogon::CT_TEXT_PLAIN);
  raw->setBody("82.4");
  raw->addCookie("wm_session", "s-live");
  CHECK_EQ(refusal(send(h.bodyweight, &BodyweightApi::saveEntry, raw, std::string("2026-08-29"))),
           forecast);
  CHECK_EQ(h.repo.db.bodyweightRows.size(), std::size_t{2});
  CHECK_EQ(bodyOf(list(h))["latest"]["dateLocal"].asString(), std::string("2026-08-28"));
}

// The identity is the day: a second write to it is a correction, and the later `recordedAt` wins
// whichever order the writes arrive in. A stale write is a 200 that answers with the row standing.
TEST(gym_bodyweight_a_day_is_written_once_and_the_later_recorded_at_wins) {
  Weighing h;
  h.signIn("s-live");
  save(h, "2026-08-25", weighIn(82.4, 1'786'000'000'000ull));

  const drogon::HttpResponsePtr corrected = save(h, "2026-08-25", weighIn(82.75, 1'786'000'060'000ull));
  const drogon::HttpResponsePtr stale = save(h, "2026-08-25", weighIn(82.4, 1'786'000'000'000ull));
  const drogon::HttpResponsePtr replay = save(h, "2026-08-25", weighIn(82.75, 1'786'000'060'000ull));

  CHECK_EQ(corrected->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(corrected)),
           std::string(R"({"entry":{"dateLocal":"2026-08-25","recordedAt":1786000060000,)"
                       R"("weightKg":82.75}})"));
  CHECK_EQ(stale->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(stale)), dump(bodyOf(corrected)));   // unchanged, and said so by the bytes
  CHECK_EQ(dump(bodyOf(replay)), dump(bodyOf(corrected)));
  CHECK_EQ(h.repo.db.bodyweightRows.size(), std::size_t{1});
  CHECK_EQ(bodyOf(list(h))["entries"].size(), 1u);
}

// Kilograms only, rounded to two decimals as the column stores them; the third decimal never
// reaches a client.
TEST(gym_bodyweight_stores_two_decimals_of_kilograms) {
  Weighing h;
  h.signIn("s-live");

  CHECK_EQ(bodyOf(save(h, "2026-08-25", weighIn(82.456)))["entry"]["weightKg"].asDouble(), 82.46);
  CHECK_EQ(bodyOf(save(h, "2026-08-24", weighIn(82.454)))["entry"]["weightKg"].asDouble(), 82.45);
  CHECK_EQ(bodyOf(save(h, "2026-08-23", weighIn(82.255)))["entry"]["weightKg"].asDouble(), 82.26);
  CHECK_EQ(dump(bodyOf(save(h, "2026-08-26", weighIn(20)))["entry"]["weightKg"]), std::string("20.0"));
  CHECK_EQ(dump(bodyOf(save(h, "2026-08-27", weighIn(400)))["entry"]["weightKg"]), std::string("400.0"));
}

// The window: both bounds inclusive, either omitted; `latest` stays the account's newest day so
// one windowed read draws the chart and the reading at the head of the log.
TEST(gym_bodyweight_window_is_inclusive_and_latest_ignores_it) {
  Weighing h;
  h.signIn("s-live");
  save(h, "2026-07-04", weighIn(84.0, 1'783'000'000'000ull));
  save(h, "2026-08-01", weighIn(83.2, 1'784'000'000'000ull));
  save(h, "2026-08-03", weighIn(83.0, 1'785'000'000'000ull));
  save(h, "2026-08-25", weighIn(82.4, 1'786'000'000'000ull));

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

// The sentences in the order the door decides them: the day, then the body, then the number and
// the instant (the forecast, between the day and the body, has its own case above). None carries
// a code.
TEST(gym_bodyweight_refuses_with_the_three_sentences_in_order) {
  Weighing h;
  h.signIn("s-live");

  const auto refused = [&](const std::string& day, const Json::Value& body) {
    const drogon::HttpResponsePtr response = save(h, day, body);
    CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
    CHECK_FALSE(bodyOf(response).isMember("code"));
    return bodyOf(response)["error"].asString();
  };
  const std::string badDate = "could not read that date";
  const std::string band = "Between 20 and 400 kg — check the number.";
  const std::string unreadable = "could not read that weigh-in";

  CHECK_EQ(refused("2026-02-30", weighIn(82.4)), badDate);
  CHECK_EQ(refused("2026-8-25", weighIn(82.4)), badDate);
  CHECK_EQ(refused("today", weighIn(82.4)), badDate);
  CHECK_EQ(refused("2026-08-25T00:00:00Z", weighIn(82.4)), badDate);
  CHECK_EQ(refused("2026-02-30", weighIn(500)), badDate);   // the day first
  CHECK_EQ(refused("2026-08-25", weighIn(19.99)), band);
  CHECK_EQ(refused("2026-08-25", weighIn(400.01)), band);
  CHECK_EQ(refused("2026-08-25", weighIn(0)), band);
  CHECK_EQ(refused("2026-08-25", weighIn(-82.4)), band);
  CHECK_EQ(refused("2026-08-25", weighIn(182.0, 0)), unreadable);   // a legal number, a zero clock
  Json::Value stringWeight(Json::objectValue);
  stringWeight["weightKg"] = "82.4";
  stringWeight["recordedAt"] = Json::Value::UInt64(1'786'000'000'000ull);
  CHECK_EQ(refused("2026-08-25", stringWeight), unreadable);
  Json::Value fractionalInstant(Json::objectValue);
  fractionalInstant["weightKg"] = 82.4;
  fractionalInstant["recordedAt"] = 1786000000000.5;
  CHECK_EQ(refused("2026-08-25", fractionalInstant), unreadable);
  Json::Value stringInstant(Json::objectValue);
  stringInstant["weightKg"] = 82.4;
  stringInstant["recordedAt"] = "2026-08-25T07:00:00Z";
  CHECK_EQ(refused("2026-08-25", stringInstant), unreadable);
  Json::Value noInstant(Json::objectValue);
  noInstant["weightKg"] = 82.4;
  CHECK_EQ(refused("2026-08-25", noInstant), unreadable);
  Json::Value negativeInstant(Json::objectValue);
  negativeInstant["weightKg"] = 82.4;
  negativeInstant["recordedAt"] = -1;
  CHECK_EQ(refused("2026-08-25", negativeInstant), unreadable);
  CHECK_EQ(refused("2026-08-25", Json::Value(Json::arrayValue)), unreadable);
  Json::Value pastTheEnd(Json::objectValue);
  pastTheEnd["weightKg"] = 82.4;
  pastTheEnd["recordedAt"] = Json::Value::UInt64(kMaxInstantMs + 1);
  CHECK_EQ(refused("2026-08-25", pastTheEnd), unreadable);
  // A body that is not json at all.
  auto raw = drogon::HttpRequest::newHttpRequest();
  raw->setMethod(drogon::Put);
  raw->setPath("/v1/gym/bodyweight/2026-08-25");
  raw->setContentTypeCode(drogon::CT_TEXT_PLAIN);
  raw->setBody("82.4");
  raw->addCookie("wm_session", "s-live");
  const drogon::HttpResponsePtr unparsed =
      send(h.bodyweight, &BodyweightApi::saveEntry, raw, std::string("2026-08-25"));
  CHECK_EQ(unparsed->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(unparsed)), std::string(R"({"error":"could not read that weigh-in"})"));
  CHECK_EQ(h.repo.db.bodyweightRows.size(), std::size_t{0});
}

// 204 always for this account: absent, already gone, another account's day, and a day that is not
// a day are one answer. Nothing but the caller's own row moves.
TEST(gym_bodyweight_delete_is_204_always_and_owner_scoped) {
  Weighing h;
  h.signIn("s-live");
  save(h, "2026-08-25", weighIn(82.4));
  h.repo.db.bodyweightRows.push_back(
      Bodyweight{UserId{"stranger"}, "2026-08-24", 70.0, 1'786'000'000'000ull});

  const drogon::HttpResponsePtr removed = remove(h, "2026-08-25");
  const drogon::HttpResponsePtr again = remove(h, "2026-08-25");
  const drogon::HttpResponsePtr theirs = remove(h, "2026-08-24");
  const drogon::HttpResponsePtr notADay = remove(h, "2026-02-30");

  for (const drogon::HttpResponsePtr& response : {removed, again, theirs, notADay}) {
    CHECK_EQ(response->getStatusCode(), drogon::k204NoContent);
    CHECK(response->getBody().empty());
  }
  CHECK_EQ(dump(bodyOf(list(h))), std::string(R"({"entries":[],"latest":null})"));
  REQUIRE_EQ(h.repo.db.bodyweightRows.size(), std::size_t{1});
  CHECK_EQ(h.repo.db.bodyweightRows[0].user, UserId{"stranger"});
}

TEST(gym_bodyweight_every_route_is_owner_scoped_and_401s_signed_out) {
  Weighing h;
  h.signIn("s-live");
  save(h, "2026-08-25", weighIn(82.4));

  CHECK_EQ(list(h, "", "", "")->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(dump(bodyOf(list(h, "", "", ""))),
           std::string(R"({"error":"sign in to open your training log"})"));
  CHECK_EQ(save(h, "2026-08-26", weighIn(82.4), "")->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(remove(h, "2026-08-25", "")->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(send(h.bodyweight, &BodyweightApi::exportEntries,
                getRequest("/v1/gym/export/bodyweight"))
               ->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(h.repo.db.bodyweightRows.size(), std::size_t{1});
  // Another account sees none of it and writes its own day beside it.
  h.signIn("s-other");
  CHECK_EQ(dump(bodyOf(list(h, "", "", "s-other"))), std::string(R"({"entries":[],"latest":null})"));
  CHECK_EQ(save(h, "2026-08-25", weighIn(70.0), "s-other")->getStatusCode(), drogon::k200OK);
  CHECK_EQ(h.repo.db.bodyweightRows.size(), std::size_t{2});
  CHECK_EQ(bodyOf(list(h))["latest"]["weightKg"].asDouble(), 82.4);
}

TEST(gym_bodyweight_export_is_a_csv_attachment_day_ascending) {
  Weighing h;
  h.signIn("s-live");
  save(h, "2026-08-25", weighIn(82.4, 1'700'000'000'000ull));
  save(h, "2026-08-01", weighIn(83.0, 1'700'000'060'000ull));
  h.repo.db.bodyweightRows.push_back(
      Bodyweight{UserId{"stranger"}, "2026-08-24", 70.0, 1'786'000'000'000ull});

  const drogon::HttpResponsePtr response =
      send(h.bodyweight, &BodyweightApi::exportEntries,
           getRequest("/v1/gym/export/bodyweight", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(response->getHeader("Content-Disposition"),
           std::string(R"(attachment; filename="windmill-gym-bodyweight.csv")"));
  CHECK_EQ(std::string(response->getBody()),
           std::string("date,weight_kg,recorded_at\r\n"
                       "2026-08-01,83.00,2023-11-14T22:14:20Z\r\n"
                       "2026-08-25,82.40,2023-11-14T22:13:20Z\r\n"));
}

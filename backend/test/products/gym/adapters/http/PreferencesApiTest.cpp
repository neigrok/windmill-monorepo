#include "test/products/gym/adapters/http/GymApiFixture.h"

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <utility>

using namespace wm;
using namespace wm::fake;
using namespace wm::gym;
using namespace wm::gym::fake;
using namespace wm::gym::apitest;

// PreferencesApi over the fake store: §I's settings document, read and written whole, and the
// proof that units are a display transform that reaches no write and no read.

// ---- §I · the settings section -----------------------------------------------------------------

// The read that cannot 404. A lifter who has never opened this screen holds no row, and what comes
// back is the DEFAULTS — kg, no rest target at all, confirmation on — because every client needs
// those values before it can draw its first frame, and an absence there would put a copy of the
// defaults in each of them.
TEST(gym_settings_answer_the_defaults_for_a_lifter_with_no_row) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response =
      send(h.preferences, &PreferencesApi::preferences, getRequest("/v1/gym/preferences", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"confirmHaptic":true,"confirmSound":false,"restSound":true,)"
                       R"("units":"kg"})"));
  // And nothing was written on the way out: reading settings does not give a lifter a row.
  CHECK_EQ(h.repo.db.preferenceRows.size(), std::size_t{0});
}

// The write is the whole document and it answers with the stored one, so the screen redraws from
// what the store now holds rather than from what it hoped it sent.
TEST(gym_settings_write_the_whole_document_and_answer_with_the_stored_one) {
  Harness h;
  h.signIn("s-live");

  Json::Value body(Json::objectValue);
  body["units"] = "lb";
  body["restSeconds"] = 90;
  body["restSound"] = false;
  body["confirmHaptic"] = false;
  body["confirmSound"] = true;
  drogon::HttpResponsePtr saved =
      send(h.preferences, &PreferencesApi::savePreferences, putRequest("/v1/gym/preferences", body, "s-live"));
  drogon::HttpResponsePtr read =
      send(h.preferences, &PreferencesApi::preferences, getRequest("/v1/gym/preferences", "s-live"));

  CHECK_EQ(saved->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(saved)),
           std::string(R"({"confirmHaptic":false,"confirmSound":true,"restSeconds":90,)"
                       R"("restSound":false,"units":"lb"})"));
  CHECK_EQ(dump(bodyOf(read)), dump(bodyOf(saved)));
  CHECK_EQ(h.repo.db.preferenceRows.size(), std::size_t{1});
}

// A whole-document PUT means the document IS the body: a field the sender did not name takes its
// default rather than quietly keeping a value the sender cannot see and cannot clear. `restSeconds`
// is the field that proves it — omitting it is how a lifter turns the timer off.
TEST(gym_settings_omitted_fields_take_their_default_and_no_rest_target_is_the_timer_off) {
  Harness h;
  h.signIn("s-live");

  Json::Value armed(Json::objectValue);
  armed["restSeconds"] = 180;
  send(h.preferences, &PreferencesApi::savePreferences, putRequest("/v1/gym/preferences", armed, "s-live"));
  drogon::HttpResponsePtr cleared = send(h.preferences, &PreferencesApi::savePreferences,
                                         putRequest("/v1/gym/preferences",
                                                    Json::Value(Json::objectValue), "s-live"));

  CHECK_EQ(cleared->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(cleared)),
           std::string(R"({"confirmHaptic":true,"confirmSound":false,"restSound":true,)"
                       R"("units":"kg"})"));
}

// Every refusal this write can make carries a machine word, and they are all different words:
// several independent values arrive at once, so a screen told only "could not read that" could not
// say which of its rows to send the lifter back to. The sentences are pinned beside the codes because they are
// what a lifter reads.
TEST(gym_settings_refusals_each_name_the_row_that_has_to_be_fixed) {
  Harness h;
  h.signIn("s-live");

  const auto refuse = [&](const Json::Value& body) {
    return send(h.preferences, &PreferencesApi::savePreferences, putRequest("/v1/gym/preferences", body, "s-live"));
  };
  Json::Value unknownUnit(Json::objectValue);
  unknownUnit["units"] = "st";
  Json::Value badRest(Json::objectValue);
  badRest["restSeconds"] = 5;
  Json::Value misspelled(Json::objectValue);
  misspelled["restSecond"] = 90;

  // Asserted field by field rather than as one dumped line, because a sentence a lifter reads may
  // hold an em dash and the writer escapes it — the contract is the code and the words, not the
  // encoding of a punctuation mark.
  const auto said = [&](const Json::Value& body) {
    return std::pair(body["code"].asString(), body["error"].asString());
  };
  CHECK_EQ(refuse(unknownUnit)->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(said(bodyOf(refuse(unknownUnit))),
           std::pair(std::string("unknown-unit"), std::string(R"(units are "kg" or "lb")")));
  CHECK_EQ(said(bodyOf(refuse(badRest))),
           std::pair(std::string("rest-target"),
                     std::string("a rest target runs from 15 to 900 seconds — send none for no "
                                 "timer")));
  // A misspelled field is refused rather than ignored, and here that is not pedantry: an ignored
  // `restSecond` would answer 200 while the timer it was aiming at silently switched off.
  CHECK_EQ(said(bodyOf(refuse(misspelled))),
           std::pair(std::string("preferences-unreadable"),
                     std::string(R"(unknown settings field "restSecond". Settings take: units, )"
                                 R"(restSeconds, restSound, confirmHaptic, confirmSound.)")));
  // And nothing landed: a refused document leaves no row behind at all.
  CHECK_EQ(h.repo.db.preferenceRows.size(), std::size_t{0});
}

TEST(gym_settings_are_owner_scoped_on_both_doors) {
  Harness h;
  h.signIn("s-live");

  CHECK_EQ(send(h.preferences, &PreferencesApi::preferences, getRequest("/v1/gym/preferences"))->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(send(h.preferences, &PreferencesApi::savePreferences,
                putRequest("/v1/gym/preferences", Json::Value(Json::objectValue)))
               ->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(h.repo.db.preferenceRows.size(), std::size_t{0});
}

// §I's first row, proved rather than promised: KILOGRAMS ARE THE ONLY THING STORED. The account
// below switches to `lb` before it logs anything, and every number that comes back afterwards — the
// set it wrote, the session read, the log row's tonnage and top set, the CSV cell — is the kilogram
// it sent. Then it switches back, and the log is byte-identical: history does not get rewritten.
TEST(gym_units_are_a_display_transform_and_reach_no_write_or_read) {
  Harness h;
  h.signIn("s-live");

  Json::Value toPounds(Json::objectValue);
  toPounds["units"] = "lb";
  send(h.preferences, &PreferencesApi::savePreferences, putRequest("/v1/gym/preferences", toPounds, "s-live"));
  trainedThrough(h, "s-live", "ses_11111111", 1'700'000'000'000, 2);

  const std::string sessionUnderLb =
      dump(bodyOf(send(h.training, &TrainingApi::getSession,
                       getRequest("/v1/gym/sessions/ses_11111111", "s-live"), "ses_11111111")));
  const std::string logUnderLb =
      dump(bodyOf(send(h.training, &TrainingApi::listSessions, getRequest("/v1/gym/sessions", "s-live"))));
  const std::string csvUnderLb{
      send(h.training, &TrainingApi::exportSets, getRequest("/v1/gym/export", "s-live"))->getBody()};

  // The set the lifter logged is the kilogram they sent, in every reply that carries it.
  CHECK(sessionUnderLb.find(R"("weightKg":82.5)") != std::string::npos);
  CHECK(logUnderLb.find(R"("tonnageKg":1320.0)") != std::string::npos);
  CHECK(logUnderLb.find(R"("topSet":{"reps":8,"weightKg":82.5})") != std::string::npos);
  CHECK(csvUnderLb.find(",82.50,8,working,") != std::string::npos);
  // Nothing anywhere on the wire says lb but the settings document itself.
  CHECK(sessionUnderLb.find("lb") == std::string::npos);
  CHECK(logUnderLb.find("lb") == std::string::npos);
  CHECK(csvUnderLb.find("lb") == std::string::npos);
  // And the stored sets hold plain kilograms — the store never heard about the unit at all.
  CHECK_EQ(h.repo.db.sets.front().weightKg, 82.5);

  Json::Value toKilos(Json::objectValue);
  toKilos["units"] = "kg";
  send(h.preferences, &PreferencesApi::savePreferences, putRequest("/v1/gym/preferences", toKilos, "s-live"));

  // Switching back rewrites nothing: the same three replies, byte for byte.
  CHECK_EQ(dump(bodyOf(send(h.training, &TrainingApi::getSession,
                            getRequest("/v1/gym/sessions/ses_11111111", "s-live"), "ses_11111111"))),
           sessionUnderLb);
  CHECK_EQ(dump(bodyOf(send(h.training, &TrainingApi::listSessions, getRequest("/v1/gym/sessions", "s-live")))),
           logUnderLb);
  CHECK_EQ(std::string{send(h.training, &TrainingApi::exportSets,
                                getRequest("/v1/gym/export", "s-live"))
                           ->getBody()},
           csvUnderLb);
}

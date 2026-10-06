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

// PreferencesApi over the fake store: the settings document, read whole.

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

TEST(gym_settings_answer_the_whole_stored_document) {
  Harness h;
  h.repo.db.preferenceRows.push_back(GymPreferences{h.signIn("s-live"), Unit::lb, 90, false, false, true});

  drogon::HttpResponsePtr read =
      send(h.preferences, &PreferencesApi::preferences, getRequest("/v1/gym/preferences", "s-live"));

  CHECK_EQ(read->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(read)),
           std::string(R"({"confirmHaptic":false,"confirmSound":true,"restSeconds":90,)"
                       R"("restSound":false,"units":"lb"})"));
}

TEST(gym_settings_are_owner_scoped_and_401_signed_out) {
  Harness h;
  h.signIn("s-live");
  h.repo.db.preferenceRows.push_back(GymPreferences{UserId{"stranger"}, Unit::lb, 90, false, false, true});

  drogon::HttpResponsePtr anonymous =
      send(h.preferences, &PreferencesApi::preferences, getRequest("/v1/gym/preferences"));
  drogon::HttpResponsePtr mine =
      send(h.preferences, &PreferencesApi::preferences, getRequest("/v1/gym/preferences", "s-live"));

  CHECK_EQ(anonymous->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(dump(bodyOf(anonymous)), std::string(R"({"error":"sign in to open your training log"})"));
  CHECK_EQ(dump(bodyOf(mine)),
           std::string(R"({"confirmHaptic":true,"confirmSound":false,"restSound":true,)"
                       R"("units":"kg"})"));
}

TEST(gym_units_are_a_display_transform_and_reach_no_write_or_read) {
  Harness h;
  const UserId me = h.signIn("s-live");
  h.repo.db.preferenceRows.push_back(GymPreferences{me, Unit::lb, std::nullopt, true, true, false});
  h.seedWorkout(me, "ses_11111111", 1'700'000'000'000, 2);

  const std::string sessionUnderLb =
      dump(bodyOf(send(h.training, &TrainingApi::getSession,
                       getRequest("/v1/gym/sessions/ses_11111111", "s-live"), "ses_11111111")));
  const std::string logUnderLb =
      dump(bodyOf(send(h.training, &TrainingApi::listSessions, getRequest("/v1/gym/sessions", "s-live"))));

  // The set the lifter logged is the kilogram they sent, in every reply that carries it.
  CHECK(sessionUnderLb.find(R"("weightKg":82.5)") != std::string::npos);
  CHECK(logUnderLb.find(R"("tonnageKg":1320.0)") != std::string::npos);
  CHECK(logUnderLb.find(R"("topSet":{"reps":8,"weightKg":82.5})") != std::string::npos);
  // Nothing anywhere on the wire says lb but the settings document itself.
  CHECK(sessionUnderLb.find("lb") == std::string::npos);
  CHECK(logUnderLb.find("lb") == std::string::npos);

  h.repo.db.preferenceRows[0].units = Unit::kg;

  // Switching back rewrites nothing: the same two replies, byte for byte.
  CHECK_EQ(dump(bodyOf(send(h.training, &TrainingApi::getSession,
                            getRequest("/v1/gym/sessions/ses_11111111", "s-live"), "ses_11111111"))),
           sessionUnderLb);
  CHECK_EQ(dump(bodyOf(send(h.training, &TrainingApi::listSessions, getRequest("/v1/gym/sessions", "s-live")))),
           logUnderLb);
}

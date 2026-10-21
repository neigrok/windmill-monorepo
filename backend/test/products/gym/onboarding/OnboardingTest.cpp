#include "products/gym/onboarding/Onboarding.h"
#include "platform/adapters/json/JsonText.h"
#include "test/testing.h"

#include <limits>

using namespace wm;
using namespace wm::gym;

TEST(gym_onboarding_input_modes_have_exact_fields_and_bounded_text) {
  for (const auto& text : {
       R"({"requestId":"12345678-1234-1234-1234-123456789abc","mode":"goal","goal":"Build strength","daysPerWeek":3,"equipment":"gym"})",
       R"({"requestId":"12345678-1234-1234-1234-123456789abc","mode":"program","program":"Bench press 3x8"})",
       R"({"requestId":"12345678-1234-1234-1234-123456789abc","mode":"photo","image":{"mimeType":"image/png","data":"AAAA"},"note":"Keep the weights"})"}) {
    auto body = parse(text);
    const auto input = readOnboardingIn(body);
    REQUIRE(input);
    CHECK_EQ(onboardingInput(*input), body);
    body["accountId"] = "not-an-account-door";
    CHECK_FALSE(readOnboardingIn(body));
  }
  auto body = parse(R"({"requestId":"12345678-1234-1234-1234-123456789abc","mode":"goal","goal":"Build strength","daysPerWeek":3,"equipment":"gym"})");
  for (const Json::Value& days : std::vector<Json::Value>{0, 7, 2.5, "3", Json::Value()}) {
    body["daysPerWeek"] = days;
    CHECK_FALSE(readOnboardingIn(body));
  }
  body["daysPerWeek"] = 6;
  for (const auto& equipment : {"gym", "dumbbells", "barbell", "bands", "bodyweight", "other"}) {
    body["equipment"] = equipment;
    CHECK(readOnboardingIn(body));
  }
  body["goal"] = std::string(1001, 'x');
  CHECK_FALSE(readOnboardingIn(body));
  body["goal"] = " \r\n";
  CHECK_FALSE(readOnboardingIn(body));
  body["goal"] = "\u00a0\u2003";
  CHECK_FALSE(readOnboardingIn(body));
  body["goal"] = std::string("private\0text", 12);
  CHECK_FALSE(readOnboardingIn(body));
}

TEST(gym_onboarding_photo_base64_is_bounded_and_strict_before_decode) {
  auto body = parse(R"({"requestId":"12345678-1234-1234-1234-123456789abc","mode":"photo","image":{"mimeType":"image/png","data":"AAAA"}})");
  for (const auto& data : {"", "A", "A===", "AA=A", "AA A", "AA-A", "===="}) {
    body["image"]["data"] = data;
    CHECK_FALSE(readOnboardingIn(body));
  }
  body["image"]["data"] = std::string(4 * ((kOnboardingImageBytes + 2) / 3) + 4, 'A');
  CHECK_FALSE(readOnboardingIn(body));
  body["image"]["data"] = "AAAA";
  body["image"]["mimeType"] = "image/svg+xml";
  CHECK_FALSE(readOnboardingIn(body));
}

TEST(gym_onboarding_result_preserves_explicit_targets_and_unknown_values) {
  const OnboardingIn input{.mode="program"};
  const std::vector<Exercise> seeds{{ExerciseId{"bench-press"}, "Bench Press", Pattern::press, Equipment::barbell, 2.5, false}};
  const auto output = parse(R"({"routines":[{"name":"Push","entries":[{"exerciseId":"bench-press","sets":[{"reps":8,"weightKg":82.5},{"reps":null,"weightKg":null}],"restSeconds":120}]}]})");
  const auto routines = readOnboardingRoutines(output, input, seeds);
  REQUIRE(routines);
  CHECK_EQ(*routines, (std::vector<OnboardingRoutine>{{"Push", {RoutineEntry{1, ExerciseId{"bench-press"}, {SetTarget{8,82.5},SetTarget{std::nullopt,std::nullopt}},120}}}}));
  CHECK_EQ(onboardingRoutines(*routines), output);
}

TEST(gym_onboarding_result_rejects_unknown_or_custom_exercises_and_goal_equipment_mismatch) {
  const std::vector<Exercise> seeds{
      {ExerciseId{"bench-press"}, "Bench Press", Pattern::press, Equipment::barbell, 2.5, false},
      {ExerciseId{"private-exercise"}, "Private", Pattern::press, Equipment::barbell, 2.5, true}};
  auto output = parse(R"({"routines":[{"name":"Push","entries":[{"exerciseId":"bench-press","sets":[{"reps":8,"weightKg":null}],"restSeconds":null}]}]})");
  OnboardingIn input{.mode="goal",.daysPerWeek=3,.equipment="gym"};
  CHECK(readOnboardingRoutines(output, input, seeds));
  input.equipment = "bodyweight";
  CHECK_FALSE(readOnboardingRoutines(output, input, seeds));
  for (const auto& equipment : {"bands", "other"}) {
    input.equipment = equipment;
    CHECK_FALSE(readOnboardingRoutines(output, input, seeds));
  }
  input.equipment = "gym";
  for (const auto& id : {"private-exercise", "invented-id"}) {
    output["routines"][0]["entries"][0]["exerciseId"] = id;
    CHECK_FALSE(readOnboardingRoutines(output, input, seeds));
  }
}

TEST(gym_onboarding_result_refuses_all_malformed_bounds_and_unknown_fields) {
  const std::vector<Exercise> seeds{{ExerciseId{"bench-press"}, "Bench Press", Pattern::press, Equipment::barbell, 2.5, false}};
  const auto valid = parse(R"({"routines":[{"name":"Push","entries":[{"exerciseId":"bench-press","sets":[{"reps":8,"weightKg":null}],"restSeconds":120}]}]})");
  const OnboardingIn input{.mode="program"};
  for (const auto& value : std::vector<Json::Value>{0, 101, 1.5, "8", true}) {
    auto output = valid;
    output["routines"][0]["entries"][0]["sets"][0]["reps"] = value;
    CHECK_FALSE(readOnboardingRoutines(output, input, seeds));
  }
  for (const auto& value : std::vector<Json::Value>{-501.0, 501.0, 1.001, "82.5", std::numeric_limits<double>::infinity()}) {
    auto output = valid;
    output["routines"][0]["entries"][0]["sets"][0]["weightKg"] = value;
    CHECK_FALSE(readOnboardingRoutines(output, input, seeds));
  }
  for (const auto& value : std::vector<Json::Value>{0, 14, 601, 90.5, "90"}) {
    auto output = valid;
    output["routines"][0]["entries"][0]["restSeconds"] = value;
    CHECK_FALSE(readOnboardingRoutines(output, input, seeds));
  }
  auto output = valid;
  output["routines"][0]["name"] = "\u00a0\u2003";
  CHECK_FALSE(readOnboardingRoutines(output, input, seeds));
  output = valid;
  output["routines"][0]["entries"].append(output["routines"][0]["entries"][0]);
  CHECK_FALSE(readOnboardingRoutines(output, input, seeds));
  output = valid;
  for (int index=0; index<8; ++index) output["routines"][0]["entries"][0]["sets"].append(parse(R"({"reps":8,"weightKg":null})"));
  CHECK_FALSE(readOnboardingRoutines(output, input, seeds));
  output = valid;
  output["explanation"] = "unbounded content";
  CHECK_FALSE(readOnboardingRoutines(output, input, seeds));
  output = valid;
  output["routines"][0]["entries"][0]["sets"][0]["weightKg"] = 20;
  CHECK_FALSE(readOnboardingRoutines(output, OnboardingIn{.mode="goal",.daysPerWeek=1,.equipment="gym"}, seeds));
}

TEST(gym_onboarding_stale_work_is_terminal_and_expiry_removes_result_content) {
  OnboardingRecord record{.deviceId="device",.requestId="request",.inputHash="digest",.resultId="result",.createdAtMs=100,.leaseUntilMs=200,.expiresAtMs=300};
  CHECK_EQ(expireOnboarding(record,199).state, "pending");
  const auto interrupted = expireOnboarding(record,200);
  CHECK_EQ(interrupted.state, "failed");
  CHECK_EQ(interrupted.errorCode, "interrupted");
  record.state = "completed";
  record.payload = parse(R"({"routines":[{"name":"private program"}]})");
  const auto expired = expireOnboarding(record,300);
  CHECK_EQ(expired.state, "expired");
  CHECK_EQ(expired.errorCode, "result_expired");
  CHECK(expired.payload.isNull());
  CHECK_EQ(expired.inputHash, "digest");
}

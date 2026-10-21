#include "platform/adapters/json/AiBudgetJson.h"
#include "platform/adapters/json/JsonText.h"
#include "test/testing.h"

using namespace wm;

TEST(ai_allowance_json_preserves_lifetime_and_funded_period_snapshots_without_invented_resets) {
  AiBudgetView lifetime{AiBudgetTier::Anonymous, true, 50'000'000, 30'000'000, 20'000'000, 0,
      std::nullopt, AiBudgetCode::SubjectExhausted, AiBudgetWindow::Lifetime};
  CHECK_EQ(dump(aiAllowanceJson(lifetime)), std::string{R"({"budgetResetsAtMs":null,"code":"subject_exhausted","configured":true,"currency":"USD","limit":"0.050000000","period":"lifetime","remaining":"0.000000000","reserved":"0.020000000","resetsAtMs":null,"tier":"anonymous","used":"0.030000000"})"});
  CHECK(aiAllowanceFromJson(aiAllowanceJson(lifetime)) == std::optional<AiBudgetView>{lifetime});
  AiBudgetView funded{AiBudgetTier::WindmillOne, true, 7'000'000'000, 6'000'000'000, 1'000'000'000, 0,
      1'800'123'456'000, AiBudgetCode::SubjectExhausted, AiBudgetWindow::BillingPeriod, 1'800'123'456'000};
  CHECK_EQ(dump(aiAllowanceJson(funded)), std::string{R"({"budgetResetsAtMs":1800123456000,"code":"subject_exhausted","configured":true,"currency":"USD","limit":"7.000000000","period":"billing_period","remaining":"0.000000000","reserved":"1.000000000","resetsAtMs":1800123456000,"tier":"windmill_one","used":"6.000000000"})"});
  CHECK(aiAllowanceFromJson(aiAllowanceJson(funded)) == std::optional<AiBudgetView>{funded});
  auto malformed = aiAllowanceJson(lifetime);
  malformed["resetsAtMs"] = 123;
  CHECK_FALSE(aiAllowanceFromJson(malformed));
  malformed = aiAllowanceJson(funded);
  malformed["period"] = "calendar_month_utc";
  CHECK_FALSE(aiAllowanceFromJson(malformed));
}

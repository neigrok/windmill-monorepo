#include "platform/ai_passes/AiPasses.h"
#include "test/testing.h"
#include <drogon/utils/Utilities.h>
#include <fstream>
#include <sstream>

using namespace wm;

TEST(ai_pass_signer_matches_every_raw_signed_vector) {
  std::ifstream file(std::string(WM_API_CONTRACT_DIR) + "/ai/passes/vectors.json");
  REQUIRE(file.is_open());
  Json::Value vectors;
  file >> vectors;
  REQUIRE(vectors.isObject());
  AiPasses signer(vectors["privateSeed"].asString(), vectors["kid"].asString(), "development", R"({"gym.coach":1})");
  for (const auto& item : vectors["cases"]) {
    if (!item["payload"].isString() || item["name"].asString() == "bad_signature") continue;
    const std::string pass = item["passValue"].asString();
    if (!pass.starts_with("wm-pass.v1.test-rfc8032.")) continue;
    const auto signature = signer.signPayload(item["payload"].asString());
    if (item["expected"].asString() == "pass_signature") continue;
    CHECK_EQ(signature, pass);
  }
}

TEST(ai_pass_claims_are_generated_from_one_principal_without_profile_or_account_content) {
  AiPasses signer("nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A", "test-rfc8032", "development", R"({"gym.coach":2})");
  Json::Value expected;
  std::istringstream(R"({"aud":"ai","env":"development","iat":1800000000000,"exp":1800000600000,"sub":{"account":"account-vector"},"plan":"one","ownerGrant":true,"installation":"installation-vector","client":"web"})") >> expected;
  CHECK(signer.claims({{AiBudgetSubjectKind::Account, "account-vector"}, AiBudgetTier::WindmillOne, true}, "installation-vector", "web", 1'800'000'000'000) == expected);
  expected.removeMember("ownerGrant");
  expected.removeMember("installation");
  expected["plan"] = "none";
  CHECK(signer.claims({{AiBudgetSubjectKind::Account, "account-vector"}, AiBudgetTier::LoggedIn}, std::nullopt, "web", 1'800'000'000'000) == expected);
  expected.removeMember("plan");
  expected["sub"].removeMember("account");
  expected["sub"]["installation"] = "installation-vector";
  CHECK(signer.claims({{AiBudgetSubjectKind::Device, "installation-vector"}, AiBudgetTier::Anonymous}, std::nullopt, "web", 1'800'000'000'000) == expected);
  CHECK_EQ(signer.refusal({"web", "gym.coach", 1}), "client-update-required");
  CHECK_EQ(signer.refusal({"web", "unknown", 2}), "invalid_request");
  CHECK_EQ(signer.refusal({"web", "gym.coach", 2}), "");
}

TEST(the_server_pass_states_the_account_as_background_work_and_nothing_else) {
  AiPasses signer("nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A", "test-rfc8032", "development", R"({"gym.coach":1})");
  const std::string pass = signer.serverPass(UserId{"account-vector"}, 1'800'000'000'000);

  const std::string prefix = "wm-pass.v1.test-rfc8032.";
  REQUIRE(pass.starts_with(prefix));
  const std::string payload = drogon::utils::base64Decode(pass.substr(prefix.size(), pass.rfind('.') - prefix.size()));
  CHECK_EQ(payload, std::string(R"({"aud":"ai","client":"server","env":"development","exp":1800000600000,)"
                                R"("iat":1800000000000,"plan":"none","sub":{"account":"account-vector"}})"));
  CHECK_EQ(pass, signer.signPayload(payload));

  // The pass door reaches no server pass: its request refuses the client, and its claims throw for it.
  CHECK_FALSE(AiPassRequest::parse(R"({"client":"server","use":"gym.coach","version":1})"));
  bool refused = false;
  try { signer.claims({{AiBudgetSubjectKind::Account, "account-vector"}, AiBudgetTier::LoggedIn}, std::nullopt, "server", 1'800'000'000'000); }
  catch (const std::invalid_argument&) { refused = true; }
  CHECK(refused);
}

TEST(ai_pass_request_and_signer_configuration_are_strict) {
  REQUIRE(AiPassRequest::parse(R"({"client":"web","use":"gym.coach","version":1})"));
  REQUIRE(AiPassRequest::parse(R"({"client":"web","use":"vector.coach","version":1})"));
  REQUIRE(AiPassRequest::parse(R"({"client":"w\u0065b","use":"gym.\u0063oach","version":1})"));
  CHECK_FALSE(AiPassRequest::parse(R"({"client":"web","client":"ios","use":"gym.coach","version":1})"));
  CHECK_FALSE(AiPassRequest::parse(R"({"client":"web","use":"gym.coach","version":1.0})"));
  CHECK_FALSE(AiPassRequest::parse(R"({"client":"web","use":"gym.coach","version":true})"));
  CHECK_FALSE(AiPassRequest::parse(R"({"client":"server","use":"gym.coach","version":1})"));
  CHECK_FALSE(AiPassRequest::parse(R"({"client":"web","use":"gym.coach","version":0})"));
  CHECK_FALSE(AiPassRequest::parse(R"({"client":"web","use":"gym.coach","version":1,"extra":0})"));
  CHECK_FALSE(AiPassRequest::parse(R"({"client":"web","use":"gym.coach","version":1} {})"));
  CHECK_FALSE(AiPassRequest::parse(R"({"client":"web","use":"gym.coach","version":1,})"));
  CHECK_FALSE(AiPassRequest::parse(R"({"client":"web","use":"gym.coach","version":1/*comment*/})"));
  CHECK_FALSE(AiPassRequest::parse("{\"client\":\"web\",\"use\":\"gym.coach\",\"version\":1//comment\n}"));
  CHECK_FALSE(AiPassRequest::parse(R"({"client":"web"/*comment*/,"use":"gym.coach","version":1})"));
  CHECK_FALSE(AiPassRequest::parse(R"({/*comment*/"client":"web","use":"gym.coach","version":1})"));
  for (const std::string versions : {"{}", R"({"gym.coach":0})", R"({"gym.coach":1.0})", R"({"gym.coach":1,"gym.coach":2})",
      R"({"gym.coach":1/*comment*/})", "{\"gym.coach\":1//comment\n}"}) {
    bool refused = false;
    try { AiPasses signer("nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A", "test-rfc8032", "development", versions); }
    catch (const std::invalid_argument&) { refused = true; }
    if (!refused) testing::fail(versions.c_str(), __FILE__, __LINE__);
  }
  for (const std::string kid : {"test-rfc8032", "renamed-key"}) {
    bool refused = false;
    try { AiPasses signer("nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A", kid, "production", R"({"gym.coach":1})"); }
    catch (const std::invalid_argument&) { refused = true; }
    CHECK(refused);
  }
}

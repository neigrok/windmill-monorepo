#include "platform/adapters/oidc/IdToken.h"

#include "test/testing.h"

#include <drogon/utils/Utilities.h>

#include <optional>
#include <string>

using namespace wm;

namespace {

// A JWT segment: base64url, unpadded, built by hand rather than borrowed from the decoder.
std::string segment(const std::string& raw) {
  std::string encoded = drogon::utils::base64Encode(
      reinterpret_cast<const unsigned char*>(raw.data()), raw.size());
  std::string url;
  for (char c : encoded) {
    if (c == '=') continue;
    if (c == '+') url.push_back('-');
    else if (c == '/') url.push_back('_');
    else url.push_back(c);
  }
  return url;
}

std::string token(const std::string& payload) {
  return segment(R"({"alg":"RS256"})") + "." + segment(payload) + "." + segment("not-a-signature");
}

const std::string kGoogle =
    R"({"iss":"https://accounts.google.com","aud":"cli","sub":"1078","email":"sam@example.com",)"
    R"("email_verified":true,"name":"Sam Gold"})";

}

TEST(id_token_reads_the_claims_out_of_a_well_formed_token) {
  const std::optional<Json::Value> claims = idTokenClaims(token(kGoogle));
  REQUIRE(claims.has_value());

  CHECK_EQ(stringClaim(*claims, "iss"), std::string("https://accounts.google.com"));
  CHECK_EQ(stringClaim(*claims, "aud"), std::string("cli"));
  CHECK_EQ(stringClaim(*claims, "sub"), std::string("1078"));
  CHECK_EQ(stringClaim(*claims, "email"), std::string("sam@example.com"));
  CHECK_EQ(stringClaim(*claims, "name"), std::string("Sam Gold"));
  CHECK(verifiedClaim(*claims, "email_verified"));
}

// Only the payload is read; the TLS connection this process opened is the proof of origin, so there is nothing to verify here.
TEST(id_token_reads_the_middle_segment_and_ignores_what_flanks_it) {
  const std::string payload = segment(kGoogle);

  REQUIRE(idTokenClaims("anything." + payload + ".anything").has_value());
  CHECK_EQ(stringClaim(*idTokenClaims("anything." + payload + ".anything"), "sub"),
           std::string("1078"));
  CHECK(idTokenClaims("h." + payload + ".!!!!").has_value());
  CHECK(idTokenClaims("h." + payload + ".s.extra").has_value());
}

// A malformed token must be a refusal, never a throw: this runs on the vendor client's event-loop thread.
TEST(id_token_refuses_everything_that_is_not_a_token_rather_than_throwing) {
  const std::string payload = segment(kGoogle);

  CHECK_FALSE(idTokenClaims("").has_value());
  CHECK_FALSE(idTokenClaims("no-dots-at-all").has_value());
  CHECK_FALSE(idTokenClaims("only.one-dot").has_value());          // a header and nothing after it
  CHECK_FALSE(idTokenClaims("h..s").has_value());                  // an empty payload segment
  CHECK_FALSE(idTokenClaims("h." + payload + "!.s").has_value());  // a character base64url has no
  CHECK_FALSE(idTokenClaims("h." + segment(kGoogle) + "=.s").has_value());  // padded, which is not base64url
  CHECK_FALSE(idTokenClaims("h." + segment("not json at all") + ".s").has_value());
  CHECK_FALSE(idTokenClaims("h." + segment("[1,2,3]") + ".s").has_value());  // valid JSON, not an object
  CHECK_FALSE(idTokenClaims("h." + segment("\"a string\"") + ".s").has_value());
  CHECK_FALSE(idTokenClaims("h." + segment("7") + ".s").has_value());
}

// `aud` may legally be an array and jsoncpp's asString() THROWS on one, which is why every claim goes through stringClaim.
TEST(id_token_a_claim_of_a_surprising_type_reads_as_absent_and_never_throws) {
  const std::optional<Json::Value> claims = idTokenClaims(
      token(R"({"aud":["cli","other"],"sub":1078,"email":null,"name":{"given":"Sam"},"nbf":[]})"));
  REQUIRE(claims.has_value());

  CHECK_EQ(stringClaim(*claims, "aud"), std::string(""));    // an array is not the client id
  CHECK_EQ(stringClaim(*claims, "sub"), std::string(""));    // a number is not a subject
  CHECK_EQ(stringClaim(*claims, "email"), std::string(""));
  CHECK_EQ(stringClaim(*claims, "name"), std::string(""));
  CHECK_EQ(stringClaim(*claims, "nbf"), std::string(""));
  CHECK_EQ(stringClaim(*claims, "never_present"), std::string(""));
}

// Apple serializes email_verified as the STRING "true"; Google has sent both.
TEST(id_token_a_verified_address_is_the_bool_or_the_word_and_nothing_else) {
  auto verified = [](const std::string& literal) {
    const std::optional<Json::Value> claims = idTokenClaims(token(R"({"email_verified":)" + literal + "}"));
    return claims && verifiedClaim(*claims, "email_verified");
  };

  CHECK(verified("true"));
  CHECK(verified("\"true\""));

  CHECK_FALSE(verified("false"));
  CHECK_FALSE(verified("\"false\""));
  CHECK_FALSE(verified("\"TRUE\""));   // the provider sends lowercase; anything else is not a yes
  CHECK_FALSE(verified("1"));          // truthy is not verified
  CHECK_FALSE(verified("\"yes\""));
  CHECK_FALSE(verified("null"));
  CHECK_FALSE(verified("{}"));

  const std::optional<Json::Value> absent = idTokenClaims(token(R"({"sub":"1078"})"));
  REQUIRE(absent.has_value());
  CHECK_FALSE(verifiedClaim(*absent, "email_verified"));
}

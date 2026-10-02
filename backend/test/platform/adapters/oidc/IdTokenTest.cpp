#include "platform/adapters/oidc/IdToken.h"
#include "platform/adapters/oidc/AppleOAuthClient.h"
#include "platform/adapters/json/JsonText.h"
#include "platform/adapters/crypto/OpenSslTokenGenerator.h"

#include "test/testing.h"

#include <drogon/utils/Utilities.h>
#include <openssl/evp.h>
#include <openssl/rsa.h>

#include <optional>
#include <memory>
#include <string>
#include <vector>

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

struct SignedAppleToken {
  std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)> key{nullptr, &EVP_PKEY_free};
  Json::Value keys{Json::objectValue};
  Json::Value claims{Json::objectValue};
  const UnixMs now = 1'700'000'000'000;
  const std::string clientId = "works.windmill.app";
  const std::string nonce = "random-nonce-retained-by-native-client";

  SignedAppleToken() {
    const std::unique_ptr<EVP_PKEY_CTX, decltype(&EVP_PKEY_CTX_free)> context(
        EVP_PKEY_CTX_new_id(EVP_PKEY_RSA, nullptr), &EVP_PKEY_CTX_free);
    EVP_PKEY* generated = nullptr;
    if (!context || EVP_PKEY_keygen_init(context.get()) != 1 ||
        EVP_PKEY_CTX_set_rsa_keygen_bits(context.get(), 2048) != 1 ||
        EVP_PKEY_keygen(context.get(), &generated) != 1) return;
    key.reset(generated);
    const std::unique_ptr<RSA, decltype(&RSA_free)> rsa(EVP_PKEY_get1_RSA(key.get()), &RSA_free);
    const BIGNUM* n = nullptr;
    const BIGNUM* e = nullptr;
    RSA_get0_key(rsa.get(), &n, &e, nullptr);
    auto encoded = [](const BIGNUM* number) {
      std::string bytes(BN_num_bytes(number), '\0');
      BN_bn2bin(number, reinterpret_cast<unsigned char*>(bytes.data()));
      return segment(bytes);
    };
    Json::Value publicKey(Json::objectValue);
    publicKey["kid"] = "test-key";
    publicKey["alg"] = "RS256";
    publicKey["kty"] = "RSA";
    publicKey["use"] = "sig";
    publicKey["n"] = encoded(n);
    publicKey["e"] = encoded(e);
    keys["keys"] = Json::Value(Json::arrayValue);
    keys["keys"].append(publicKey);
    claims["iss"] = "https://appleid.apple.com";
    claims["aud"] = clientId;
    claims["sub"] = "stable-apple-subject";
    claims["iat"] = static_cast<Json::UInt64>(now / 1000 - 10);
    claims["exp"] = static_cast<Json::UInt64>(now / 1000 + 600);
    OpenSslTokenGenerator tokens;
    claims["nonce"] = tokens.digestOf(nonce);
    claims["email"] = "sam@example.com";
    claims["email_verified"] = "true";
    claims["is_private_email"] = false;
  }

  std::string signedToken(const Json::Value& payload, const std::string& header =
      R"({"alg":"RS256","kid":"test-key"})") const {
    if (!key) return "";
    const std::string input = segment(header) + "." + segment(dump(payload));
    const std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> context(EVP_MD_CTX_new(), &EVP_MD_CTX_free);
    if (!context || EVP_DigestSignInit(context.get(), nullptr, EVP_sha256(), nullptr, key.get()) != 1) return "";
    std::size_t size = 0;
    if (EVP_DigestSign(context.get(), nullptr, &size,
        reinterpret_cast<const unsigned char*>(input.data()), input.size()) != 1) return "";
    std::string signature(size, '\0');
    if (EVP_DigestSign(context.get(), reinterpret_cast<unsigned char*>(signature.data()), &size,
        reinterpret_cast<const unsigned char*>(input.data()), input.size()) != 1) return "";
    signature.resize(size);
    return input + "." + segment(signature);
  }

  std::optional<ProviderIdentity> verify(const Json::Value& payload) const {
    return AppleIdentityTokenVerifier::verifiedIdentity(signedToken(payload), nonce, clientId, keys, now);
  }
};

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

TEST(native_apple_verifier_requires_enabled_configuration_and_verifies_a_signed_identity) {
  AppleIdentityTokenVerifier disabled(false, "works.windmill.app");
  AppleIdentityTokenVerifier missingClient(true, "");
  CHECK_FALSE(disabled.configured());
  CHECK_FALSE(missingClient.configured());
  bool called = false;
  disabled.verify("t", "n", [&](auto identity) { called = true; CHECK_FALSE(identity.has_value()); });
  CHECK(called);
  SignedAppleToken fixture;
  REQUIRE(fixture.key);
  const auto identity = fixture.verify(fixture.claims);
  REQUIRE(identity.has_value());
  CHECK(identity->provider == Provider::apple);
  CHECK_EQ(identity->subject, std::string("stable-apple-subject"));
  CHECK_EQ(identity->email.value, std::string("sam@example.com"));
  CHECK(identity->emailVerified);
  CHECK_FALSE(identity->relayEmail);
  auto relay = fixture.claims;
  relay["email"] = "sam@privaterelay.appleid.com";
  relay["is_private_email"] = "true";
  REQUIRE(fixture.verify(relay).has_value());
  CHECK(fixture.verify(relay)->relayEmail);
  auto subjectOnly = fixture.claims;
  subjectOnly.removeMember("email");
  subjectOnly.removeMember("email_verified");
  REQUIRE(fixture.verify(subjectOnly).has_value());
  CHECK_EQ(fixture.verify(subjectOnly)->email.value, std::string(""));
}

TEST(native_apple_verifier_refuses_bad_signatures_algorithms_keys_and_token_shapes) {
  SignedAppleToken fixture;
  REQUIRE(fixture.key);
  const auto valid = fixture.signedToken(fixture.claims);
  auto verify = [&](const std::string& token, const Json::Value& keys) {
    return AppleIdentityTokenVerifier::verifiedIdentity(token, fixture.nonce, fixture.clientId, keys, fixture.now);
  };
  std::string tampered = valid;
  tampered[tampered.rfind('.') + 1] = tampered[tampered.rfind('.') + 1] == 'A' ? 'B' : 'A';
  CHECK_FALSE(verify(tampered, fixture.keys).has_value());
  for (const std::string& malformed : {std::string(""), std::string("h.c.s"), valid + ".extra",
      valid + "=", fixture.signedToken(fixture.claims, R"({"alg":"none","kid":"test-key"})"),
      fixture.signedToken(fixture.claims, R"({"alg":"HS256","kid":"test-key"})"),
      fixture.signedToken(fixture.claims, R"({"alg":"RS256","kid":"unknown"})"),
      fixture.signedToken(fixture.claims, R"({"alg":"RS256","kid":"test-key","crit":["unknown"]})"),
      fixture.signedToken(fixture.claims, R"({"alg":"RS256","alg":"RS256","kid":"test-key"})")}) {
    CHECK_FALSE(verify(malformed, fixture.keys).has_value());
  }
  for (const std::string& field : {std::string("alg"), std::string("kty"), std::string("use"),
                                  std::string("n"), std::string("e"), std::string("kid")}) {
    auto bad = fixture.keys;
    bad["keys"][0][field] = "invalid";
    CHECK_FALSE(verify(valid, bad).has_value());
  }
  auto duplicate = fixture.keys;
  duplicate["keys"].append(fixture.keys["keys"][0]);
  CHECK_FALSE(verify(valid, duplicate).has_value());
  CHECK_FALSE(verify(valid, Json::Value(Json::objectValue)).has_value());
}

TEST(native_apple_verifier_refuses_expired_foreign_unverified_or_nonce_mismatched_claims) {
  SignedAppleToken fixture;
  REQUIRE(fixture.key);
  for (const std::string& field : {std::string("iss"), std::string("aud"), std::string("sub"),
       std::string("nonce"), std::string("exp"), std::string("iat"), std::string("email_verified")}) {
    auto missing = fixture.claims;
    missing.removeMember(field);
    CHECK_FALSE(fixture.verify(missing).has_value());
    missing[field] = Json::Value(Json::arrayValue);
    CHECK_FALSE(fixture.verify(missing).has_value());
  }
  for (const auto& [field, value] : std::vector<std::pair<std::string, Json::Value>>{
      {"iss", "https://attacker.example"}, {"aud", "another-app"}, {"sub", ""},
      {"email", "not-an-email"}, {"email_verified", false}, {"nonce", "wrong"},
      {"exp", Json::UInt64(fixture.now / 1000)}, {"iat", Json::UInt64(fixture.now / 1000 + 61)},
      {"nbf", Json::UInt64(fixture.now / 1000 + 1)}, {"exp", "1700000600"}}) {
    auto bad = fixture.claims;
    bad[field] = value;
    CHECK_FALSE(fixture.verify(bad).has_value());
  }
  CHECK_FALSE(AppleIdentityTokenVerifier::verifiedIdentity(fixture.signedToken(fixture.claims),
      "another-nonce", fixture.clientId, fixture.keys, fixture.now).has_value());
}

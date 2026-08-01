#include "platform/adapters/oidc/AppleOAuthClient.h"

#include "platform/adapters/json/JsonText.h"
#include "platform/adapters/oidc/IdToken.h"

#include <drogon/HttpClient.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>
#include <drogon/utils/Utilities.h>

#include <json/json.h>
#include <openssl/bn.h>
#include <openssl/ecdsa.h>
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <trantor/utils/Logger.h>

#include <chrono>
#include <memory>
#include <utility>
#include <vector>

namespace wm {

namespace {
constexpr const char* kIssuer = "https://appleid.apple.com";
constexpr long kSecretLifetimeSeconds = 3600;  // Apple allows six months; an hour is all we need

std::string urlEncode(const std::string& in) {
  static const char* hex = "0123456789ABCDEF";
  std::string out;
  out.reserve(in.size() * 3);
  for (unsigned char c : in) {
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' ||
        c == '_' || c == '.' || c == '~') {
      out.push_back(static_cast<char>(c));
    } else {
      out.push_back('%');
      out.push_back(hex[c >> 4]);
      out.push_back(hex[c & 0x0F]);
    }
  }
  return out;
}

std::string base64Url(const std::string& bytes) {
  return drogon::utils::base64Encode(reinterpret_cast<const unsigned char*>(bytes.data()), bytes.size(),
                                     true, false);
}

// ECDSA P-256 over SHA-256, in the raw r||s form JWS requires — OpenSSL signs to DER, and the two
// halves have to be left-padded to 32 bytes each, which is exactly what a DER encoding drops.
// Empty on any failure: a key that won't load or won't sign is a misconfigured deploy, and the
// exchange that follows refuses rather than sending Apple a secret it will reject.
std::string es256(const std::string& privateKeyPem, const std::string& message) {
  const std::unique_ptr<BIO, decltype(&BIO_free)> bio(
      BIO_new_mem_buf(privateKeyPem.data(), static_cast<int>(privateKeyPem.size())), &BIO_free);
  if (!bio) return {};
  const std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)> key(
      PEM_read_bio_PrivateKey(bio.get(), nullptr, nullptr, nullptr), &EVP_PKEY_free);
  if (!key) return {};

  const std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> ctx(EVP_MD_CTX_new(), &EVP_MD_CTX_free);
  if (!ctx || EVP_DigestSignInit(ctx.get(), nullptr, EVP_sha256(), nullptr, key.get()) != 1) return {};
  if (EVP_DigestSignUpdate(ctx.get(), message.data(), message.size()) != 1) return {};

  std::size_t derLength = 0;
  if (EVP_DigestSignFinal(ctx.get(), nullptr, &derLength) != 1) return {};
  std::vector<unsigned char> der(derLength);
  if (EVP_DigestSignFinal(ctx.get(), der.data(), &derLength) != 1) return {};

  const unsigned char* cursor = der.data();
  const std::unique_ptr<ECDSA_SIG, decltype(&ECDSA_SIG_free)> signature(
      d2i_ECDSA_SIG(nullptr, &cursor, static_cast<long>(derLength)), &ECDSA_SIG_free);
  if (!signature) return {};
  const BIGNUM* r = nullptr;
  const BIGNUM* s = nullptr;
  ECDSA_SIG_get0(signature.get(), &r, &s);

  std::string raw(64, '\0');
  unsigned char* bytes = reinterpret_cast<unsigned char*>(raw.data());
  if (BN_bn2binpad(r, bytes, 32) != 32 || BN_bn2binpad(s, bytes + 32, 32) != 32) return {};
  return raw;
}

// The identity inside an Apple id_token, or nullopt if it's malformed, minted for another client,
// or carries an unverified address. `sub` is Apple's stable per-app key for this human and is the
// only field allowed to resolve an account on its own.
std::optional<ProviderIdentity> identityFromIdToken(const std::string& idToken, const std::string& clientId) {
  const std::optional<Json::Value> claims = idTokenClaims(idToken);
  if (!claims) return std::nullopt;

  if (stringClaim(*claims, "aud") != clientId) return std::nullopt;
  if (stringClaim(*claims, "iss") != kIssuer) return std::nullopt;
  if (!verifiedClaim(*claims, "email_verified")) return std::nullopt;

  const std::string subject = stringClaim(*claims, "sub");
  const std::optional<Email> email = parseEmail(stringClaim(*claims, "email"));
  if (subject.empty() || !email) return std::nullopt;

  ProviderIdentity identity{Provider::apple, subject, *email, "", true, false};
  identity.relayEmail = verifiedClaim(*claims, "is_private_email");
  return identity;
}
}

AppleOAuthClient::AppleOAuthClient(std::string clientId, std::string teamId, std::string keyId,
                                   std::string privateKeyPem)
    : clientId_(std::move(clientId)), teamId_(std::move(teamId)), keyId_(std::move(keyId)),
      privateKeyPem_(std::move(privateKeyPem)) {
  loop_.run();
}

std::string AppleOAuthClient::clientSecret() const {
  const long issuedAt = static_cast<long>(
      std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch())
          .count());

  Json::Value header(Json::objectValue);
  header["alg"] = "ES256";
  header["kid"] = keyId_;
  Json::Value payload(Json::objectValue);
  payload["iss"] = teamId_;
  payload["iat"] = static_cast<Json::Int64>(issuedAt);
  payload["exp"] = static_cast<Json::Int64>(issuedAt + kSecretLifetimeSeconds);
  payload["aud"] = kIssuer;
  payload["sub"] = clientId_;

  const std::string signingInput = base64Url(dump(header)) + "." + base64Url(dump(payload));

  const std::string signature = es256(privateKeyPem_, signingInput);
  if (signature.empty()) return {};
  return signingInput + "." + base64Url(signature);
}

void AppleOAuthClient::exchangeCode(const std::string& code,
                                    std::function<void(std::optional<ProviderIdentity>)> done) {
  if (!configured()) {
    done(std::nullopt);
    return;
  }
  const std::string secret = clientSecret();
  if (secret.empty()) {
    LOG_ERROR << "Apple client secret could not be signed — check APPLE_PRIVATE_KEY";
    done(std::nullopt);
    return;
  }

  // No redirect_uri: the native flow has none, the app having run the authorization itself.
  const std::string form = "grant_type=authorization_code&code=" + urlEncode(code) +
                           "&client_id=" + urlEncode(clientId_) + "&client_secret=" + urlEncode(secret);

  auto client = drogon::HttpClient::newHttpClient(kIssuer, loop_.getLoop());
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Post);
  req->setPath("/auth/token");
  req->setContentTypeString("application/x-www-form-urlencoded");
  req->setBody(form);

  const std::string clientId = clientId_;
  client->sendRequest(
      req,
      [client, clientId, done = std::move(done)](drogon::ReqResult result, const drogon::HttpResponsePtr& resp) {
        const int status = resp ? static_cast<int>(resp->getStatusCode()) : 0;
        if (result != drogon::ReqResult::Ok || status < 200 || status >= 300) {
          LOG_ERROR << "Apple token exchange failed (status " << status << ")";
          done(std::nullopt);
          return;
        }
        std::shared_ptr<Json::Value> body = resp->getJsonObject();
        const std::string idToken = body ? stringClaim(*body, "id_token") : std::string();
        if (idToken.empty()) {
          done(std::nullopt);
          return;
        }
        done(identityFromIdToken(idToken, clientId));
      },
      10.0);
}

}

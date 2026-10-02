#include "platform/adapters/oidc/AppleOAuthClient.h"

#include "platform/adapters/http/VendorCall.h"
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
#include <openssl/rsa.h>
#include <openssl/sha.h>
#include <trantor/utils/Logger.h>

#include <chrono>
#include <array>
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
// halves have to be left-padded to 32 bytes each. Empty on any failure, and the exchange that
// follows refuses rather than sending Apple a secret it will reject.
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
// or carries an unverified address. `sub` is Apple's stable per-app key for this human and the only
// field allowed to resolve an account on its own.
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

std::string decodeSegment(const std::string& encoded) {
  if (encoded.empty() || encoded.size() % 4 == 1) return {};
  if (encoded.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_") !=
      std::string::npos) return {};
  std::string standard = encoded;
  for (char& character : standard) {
    if (character == '-') character = '+';
    else if (character == '_') character = '/';
  }
  standard.append((4 - standard.size() % 4) % 4, '=');
  std::string bytes = drogon::utils::base64Decode(standard);
  return base64Url(bytes) == encoded ? bytes : std::string();
}

std::optional<Json::Value> segmentObject(const std::string& encoded) {
  const std::string bytes = decodeSegment(encoded);
  if (bytes.empty()) return std::nullopt;
  Json::CharReaderBuilder builder;
  builder["rejectDupKeys"] = true;
  builder["failIfExtra"] = true;
  const std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  Json::Value object;
  std::string errors;
  try {
    if (!reader->parse(bytes.data(), bytes.data() + bytes.size(), &object, &errors) || !object.isObject())
      return std::nullopt;
  } catch (const std::exception&) {
    return std::nullopt;
  }
  return object;
}

bool verifiesRs256(const Json::Value& key, const std::string& signingInput, const std::string& signature) {
  const std::string modulus = decodeSegment(stringClaim(key, "n"));
  const std::string exponent = decodeSegment(stringClaim(key, "e"));
  if (modulus.size() < 256 || modulus.size() > 512 || exponent.empty() || exponent.size() > 8) return false;
  std::unique_ptr<BIGNUM, decltype(&BN_free)> n(
      BN_bin2bn(reinterpret_cast<const unsigned char*>(modulus.data()), modulus.size(), nullptr), &BN_free);
  std::unique_ptr<BIGNUM, decltype(&BN_free)> e(
      BN_bin2bn(reinterpret_cast<const unsigned char*>(exponent.data()), exponent.size(), nullptr), &BN_free);
  const std::unique_ptr<RSA, decltype(&RSA_free)> rsa(RSA_new(), &RSA_free);
  if (!n || !e || !rsa || BN_num_bits(n.get()) < 2048 || RSA_set0_key(rsa.get(), n.get(), e.get(), nullptr) != 1)
    return false;
  n.release();
  e.release();
  const std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)> publicKey(EVP_PKEY_new(), &EVP_PKEY_free);
  if (!publicKey || EVP_PKEY_set1_RSA(publicKey.get(), rsa.get()) != 1) return false;
  const std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> context(EVP_MD_CTX_new(), &EVP_MD_CTX_free);
  if (!context || EVP_DigestVerifyInit(context.get(), nullptr, EVP_sha256(), nullptr, publicKey.get()) != 1)
    return false;
  return EVP_DigestVerify(context.get(), reinterpret_cast<const unsigned char*>(signature.data()),
      signature.size(), reinterpret_cast<const unsigned char*>(signingInput.data()), signingInput.size()) == 1;
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
  VendorCall call("apple", "exchange");
  client->sendRequest(
      req,
      [client, clientId, call, done = std::move(done)](drogon::ReqResult result,
                                                       const drogon::HttpResponsePtr& resp) mutable {
        if (!call.succeeded(result, resp)) {
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

AppleIdentityTokenVerifier::AppleIdentityTokenVerifier(bool enabled, std::string clientId)
    : enabled_(enabled), clientId_(std::move(clientId)) {
  if (configured()) loop_.run();
}

std::optional<ProviderIdentity> AppleIdentityTokenVerifier::verifiedIdentity(const std::string& identityToken,
    const std::string& nonce, const std::string& clientId, const Json::Value& keys, UnixMs now) {
  if (clientId.empty() || identityToken.size() > 16384 || nonce.empty() || nonce.size() > 256)
    return std::nullopt;
  const auto firstDot = identityToken.find('.');
  if (firstDot == std::string::npos) return std::nullopt;
  const auto secondDot = identityToken.find('.', firstDot + 1);
  if (secondDot == std::string::npos || identityToken.find('.', secondDot + 1) != std::string::npos)
    return std::nullopt;
  const auto header = segmentObject(identityToken.substr(0, firstDot));
  const auto claims = segmentObject(identityToken.substr(firstDot + 1, secondDot - firstDot - 1));
  const std::string signature = decodeSegment(identityToken.substr(secondDot + 1));
  if (!header || !claims || signature.empty() || stringClaim(*header, "alg") != "RS256" ||
      header->isMember("crit")) return std::nullopt;
  const std::string kid = stringClaim(*header, "kid");
  if (kid.empty() || !keys.isObject() || !keys["keys"].isArray() || keys["keys"].size() > 16)
    return std::nullopt;
  const Json::Value* matched = nullptr;
  for (const auto& key : keys["keys"]) {
    if (!key.isObject() || stringClaim(key, "kid") != kid) continue;
    if (matched || stringClaim(key, "kty") != "RSA" || stringClaim(key, "alg") != "RS256" ||
        stringClaim(key, "use") != "sig") return std::nullopt;
    matched = &key;
  }
  if (!matched || !verifiesRs256(*matched, identityToken.substr(0, secondDot), signature)) return std::nullopt;
  if (stringClaim(*claims, "iss") != kIssuer || stringClaim(*claims, "aud") != clientId ||
      !(*claims)["exp"].isUInt64() || !(*claims)["iat"].isUInt64()) return std::nullopt;
  const auto nowSeconds = now / 1000;
  const auto expires = (*claims)["exp"].asUInt64();
  const auto issued = (*claims)["iat"].asUInt64();
  if (expires <= nowSeconds || issued > nowSeconds + 60 || issued >= expires ||
      (claims->isMember("nbf") && (!(*claims)["nbf"].isUInt64() || (*claims)["nbf"].asUInt64() > nowSeconds)))
    return std::nullopt;
  std::array<unsigned char, SHA256_DIGEST_LENGTH> digest{};
  SHA256(reinterpret_cast<const unsigned char*>(nonce.data()), nonce.size(), digest.data());
  const char* hex = "0123456789abcdef";
  std::string nonceHash;
  for (const auto byte : digest) {
    nonceHash.push_back(hex[byte >> 4]);
    nonceHash.push_back(hex[byte & 15]);
  }
  if (stringClaim(*claims, "nonce") != nonceHash) return std::nullopt;
  const std::string subject = stringClaim(*claims, "sub");
  if (subject.empty() || subject.size() > 255) return std::nullopt;
  ProviderIdentity identity{Provider::apple, subject, Email{""}, "", false, false};
  if (claims->isMember("email")) {
    const auto email = parseEmail(stringClaim(*claims, "email"));
    if (!email || !verifiedClaim(*claims, "email_verified")) return std::nullopt;
    identity.email = *email;
    identity.emailVerified = true;
  }
  identity.relayEmail = verifiedClaim(*claims, "is_private_email");
  return identity;
}

void AppleIdentityTokenVerifier::verify(const std::string& identityToken, const std::string& nonce, Completion done) {
  if (!configured()) {
    done(std::nullopt);
    return;
  }
  auto client = drogon::HttpClient::newHttpClient(kIssuer, loop_.getLoop());
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Get);
  req->setPath("/auth/keys");
  VendorCall call("apple", "keys");
  client->sendRequest(req,
      [client, clientId = clientId_, identityToken, nonce, call, done = std::move(done)](
          drogon::ReqResult result, const drogon::HttpResponsePtr& response) mutable {
        if (!call.succeeded(result, response)) {
          done(std::nullopt);
          return;
        }
        const auto keys = response->getJsonObject();
        const UnixMs now = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
        done(keys ? verifiedIdentity(identityToken, nonce, clientId, *keys, now) : std::nullopt);
      }, 10.0);
}

}

#include "platform/ai_passes/AiPasses.h"

#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <algorithm>
#include <array>
#include <limits>
#include <stdexcept>

namespace wm {
namespace {

std::optional<Json::Value> strictObject(std::string_view text) {
  if (text.empty() || text.size() > 4096) return std::nullopt;
  // JsonCpp 1.9.5 consumes comments after object values even when allowComments is false.
  bool quoted = false;
  bool escaped = false;
  for (const char c : text) {
    if (escaped) { escaped = false; continue; }
    if (quoted && c == '\\') { escaped = true; continue; }
    if (c == '"') quoted = !quoted;
    if (!quoted && c == '/') return std::nullopt;
  }
  Json::CharReaderBuilder builder;
  Json::CharReaderBuilder::strictMode(&builder.settings_);
  builder["rejectDupKeys"] = true;
  builder["failIfExtra"] = true;
  builder["stackLimit"] = 8;
  Json::Value value;
  std::string errors;
  const std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  if (!reader->parse(text.data(), text.data() + text.size(), &value, &errors) || !value.isObject()) return std::nullopt;
  return value;
}

bool validUse(const std::string& use) {
  return !use.empty() && use.size() <= 64 && use.front() >= 'a' && use.front() <= 'z' &&
      std::all_of(use.begin(), use.end(), [](unsigned char c) { return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '.'; });
}

std::string base64url(const unsigned char* bytes, std::size_t size) {
  std::string encoded(4 * ((size + 2) / 3), '\0');
  const int count = EVP_EncodeBlock(reinterpret_cast<unsigned char*>(encoded.data()), bytes, static_cast<int>(size));
  if (count < 0) throw std::runtime_error("ai_pass_encoding_failed");
  encoded.resize(count);
  while (!encoded.empty() && encoded.back() == '=') encoded.pop_back();
  std::replace(encoded.begin(), encoded.end(), '+', '-');
  std::replace(encoded.begin(), encoded.end(), '/', '_');
  return encoded;
}

}

std::optional<AiPassRequest> AiPassRequest::parse(std::string_view text) {
  const auto value = strictObject(text);
  if (!value || value->size() != 3 || !(*value)["client"].isString() || !(*value)["use"].isString() ||
      ((*value)["version"].type() != Json::intValue && (*value)["version"].type() != Json::uintValue) || !(*value)["version"].isInt() || (*value)["version"].asInt() < 1) return std::nullopt;
  const std::string client = (*value)["client"].asString();
  const std::string use = (*value)["use"].asString();
  if ((client != "ios" && client != "android" && client != "web") || !validUse(use)) return std::nullopt;
  return AiPassRequest{client, use, (*value)["version"].asInt()};
}

AiPasses::AiPasses(const std::string& seed, std::string kid, std::string environment, const std::string& minimumVersions)
    : kid_(std::move(kid)), environment_(std::move(environment)) {
  const auto invalid = [] { throw std::invalid_argument("Invalid AI pass configuration"); };
  if (kid_.empty() || kid_.size() > 32 || !std::all_of(kid_.begin(), kid_.end(), [](unsigned char c) {
        return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-';
      }) || (environment_ != "production" && environment_ != "development")) invalid();
  const auto versions = strictObject(minimumVersions);
  if (!versions || versions->empty() || versions->size() > 32) invalid();
  for (const auto& use : versions->getMemberNames()) {
    const auto& version = (*versions)[use];
    if (!validUse(use) || (version.type() != Json::intValue && version.type() != Json::uintValue) || !version.isInt() || version.asInt() < 1) invalid();
    minimumVersions_.emplace(use, version.asInt());
  }
  if (seed.size() != 43 || !std::all_of(seed.begin(), seed.end(), [](unsigned char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
      })) invalid();
  std::string encoded = seed + "=";
  std::replace(encoded.begin(), encoded.end(), '-', '+');
  std::replace(encoded.begin(), encoded.end(), '_', '/');
  std::array<unsigned char, 33> decoded{};
  const int length = EVP_DecodeBlock(decoded.data(), reinterpret_cast<const unsigned char*>(encoded.data()), encoded.size());
  if (length != 33 || base64url(decoded.data(), 32) != seed) { OPENSSL_cleanse(decoded.data(), decoded.size()); invalid(); }
  std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)> key(EVP_PKEY_new_raw_private_key(EVP_PKEY_ED25519, nullptr, decoded.data(), 32), EVP_PKEY_free);
  OPENSSL_cleanse(decoded.data(), decoded.size());
  if (!key) invalid();
  std::array<unsigned char, 32> publicKey{};
  std::size_t size = publicKey.size();
  if (EVP_PKEY_get_raw_public_key(key.get(), publicKey.data(), &size) != 1 || size != publicKey.size()) invalid();
  const bool published = base64url(publicKey.data(), publicKey.size()) == "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
  if ((environment_ == "production" && (published || kid_.starts_with("test-"))) || (published && !kid_.starts_with("test-"))) invalid();
  key_ = key.release();
}

AiPasses::~AiPasses() { EVP_PKEY_free(key_); }

std::string AiPasses::refusal(const AiPassRequest& request) const {
  const auto use = minimumVersions_.find(request.use);
  if (use == minimumVersions_.end()) return "invalid_request";
  if (request.version < use->second) return "client-update-required";
  return {};
}

Json::Value AiPasses::claims(const AiBudgetPrincipal& principal, const std::optional<std::string>& installation,
                            const std::string& client, long long now) const {
  if (!principal.valid() || (client != "ios" && client != "android" && client != "web") || now < 0 ||
      now > std::numeric_limits<long long>::max() - kAiPassLifetimeMs) throw std::invalid_argument("Invalid AI pass claims");
  Json::Value value(Json::objectValue);
  value["aud"] = "ai";
  value["env"] = environment_;
  value["iat"] = Json::Int64(now);
  value["exp"] = Json::Int64(now + kAiPassLifetimeMs);
  const bool account = principal.subject.kind == AiBudgetSubjectKind::Account;
  value["sub"][account ? "account" : "installation"] = principal.subject.id;
  if (account) {
    value["plan"] = principal.tier == AiBudgetTier::WindmillOne ? "one" : "none";
    if (principal.owner) value["ownerGrant"] = true;
    if (installation) value["installation"] = *installation;
  }
  value["client"] = client;
  return value;
}

std::string AiPasses::signPayload(const std::string& payload) const {
  const std::string signedText = "wm-pass.v1." + kid_ + "." + base64url(reinterpret_cast<const unsigned char*>(payload.data()), payload.size());
  if (signedText.size() + 87 > 2048) throw std::invalid_argument("AI pass exceeds length limit");
  std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> context(EVP_MD_CTX_new(), EVP_MD_CTX_free);
  std::array<unsigned char, 64> signature{};
  std::size_t size = signature.size();
  if (!context || EVP_DigestSignInit(context.get(), nullptr, nullptr, nullptr, key_) != 1 ||
      EVP_DigestSign(context.get(), signature.data(), &size, reinterpret_cast<const unsigned char*>(signedText.data()), signedText.size()) != 1 || size != signature.size())
    throw std::runtime_error("ai_pass_sign_failed");
  return signedText + "." + base64url(signature.data(), signature.size());
}

std::string AiPasses::sign(const Json::Value& claims) const {
  Json::StreamWriterBuilder writer;
  writer["indentation"] = "";
  return signPayload(Json::writeString(writer, claims));
}

}

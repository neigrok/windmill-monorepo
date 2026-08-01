#include "platform/adapters/oidc/IdToken.h"

#include <array>

namespace wm {

namespace {
// A JWT segment: base64url, no padding. Empty on any malformed input.
std::string base64UrlDecode(const std::string& in) {
  static std::array<int, 256> table = [] {
    std::array<int, 256> t{};
    t.fill(-1);
    const std::string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    for (int i = 0; i < static_cast<int>(alphabet.size()); ++i) t[static_cast<unsigned char>(alphabet[i])] = i;
    return t;
  }();

  std::string out;
  int bits = 0;
  unsigned int acc = 0;  // unsigned: the running shift must not overflow a signed int (UB)
  for (unsigned char c : in) {
    const int v = table[c];
    if (v < 0) return {};  // any non-alphabet char (including '=') is malformed for base64url
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<char>((acc >> bits) & 0xFF));
    }
  }
  return out;
}
}

std::optional<Json::Value> idTokenClaims(const std::string& idToken) {
  const auto firstDot = idToken.find('.');
  if (firstDot == std::string::npos) return std::nullopt;
  const auto secondDot = idToken.find('.', firstDot + 1);
  if (secondDot == std::string::npos) return std::nullopt;

  const std::string payloadJson = base64UrlDecode(idToken.substr(firstDot + 1, secondDot - firstDot - 1));
  if (payloadJson.empty()) return std::nullopt;

  Json::CharReaderBuilder builder;
  const std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  Json::Value claims;
  std::string errors;
  if (!reader->parse(payloadJson.data(), payloadJson.data() + payloadJson.size(), &claims, &errors) ||
      !claims.isObject())
    return std::nullopt;
  return claims;
}

std::string stringClaim(const Json::Value& claims, const char* name) {
  const Json::Value& value = claims[name];
  return value.isString() ? value.asString() : std::string();
}

bool verifiedClaim(const Json::Value& claims, const char* name) {
  const Json::Value& value = claims[name];
  return (value.isBool() && value.asBool()) || (value.isString() && value.asString() == "true");
}

}

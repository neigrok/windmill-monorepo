#include "adapters/google/GoogleOAuthClient.h"

#include <drogon/HttpClient.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <json/json.h>
#include <trantor/utils/Logger.h>

#include <array>
#include <memory>
#include <utility>

namespace wm {

namespace {
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

// Decode a JWT segment (base64url, no padding). Returns empty on any malformed input.
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

// asString() throws on a non-string node, and a JWT claim like `aud` can legally be a JSON array —
// read every string claim defensively so a surprising payload returns nullopt instead of throwing
// on the loop thread.
std::string asStr(const Json::Value& value) { return value.isString() ? value.asString() : std::string(); }

// The verified profile inside a Google id_token, or nullopt if it's malformed, not for us, or the
// email isn't Google-verified. The signature is not re-checked (see the header); aud/iss/verified
// are the trust gate.
std::optional<GoogleIdentity> identityFromIdToken(const std::string& idToken, const std::string& clientId) {
  const auto firstDot = idToken.find('.');
  const auto secondDot = idToken.find('.', firstDot == std::string::npos ? 0 : firstDot + 1);
  if (firstDot == std::string::npos || secondDot == std::string::npos) return std::nullopt;
  const std::string payloadJson = base64UrlDecode(idToken.substr(firstDot + 1, secondDot - firstDot - 1));
  if (payloadJson.empty()) return std::nullopt;

  Json::CharReaderBuilder builder;
  const std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  Json::Value payload;
  std::string errors;
  if (!reader->parse(payloadJson.data(), payloadJson.data() + payloadJson.size(), &payload, &errors) ||
      !payload.isObject())
    return std::nullopt;

  if (asStr(payload["aud"]) != clientId) return std::nullopt;  // token minted for another client (or multi-aud)
  const std::string iss = asStr(payload["iss"]);
  if (iss != "accounts.google.com" && iss != "https://accounts.google.com") return std::nullopt;

  // email_verified rides as a bool or the string "true" depending on Google's serialization.
  const Json::Value& verified = payload["email_verified"];
  const bool emailVerified = (verified.isBool() && verified.asBool()) ||
                             (verified.isString() && verified.asString() == "true");
  if (!emailVerified) return std::nullopt;

  const std::optional<Email> email = parseEmail(asStr(payload["email"]));
  if (!email) return std::nullopt;

  GoogleIdentity identity;
  identity.email = *email;
  identity.name = asStr(payload["name"]);
  identity.emailVerified = true;
  return identity;
}
}

GoogleOAuthClient::GoogleOAuthClient(std::string clientId, std::string clientSecret, std::string redirectUri)
    : clientId_(std::move(clientId)), clientSecret_(std::move(clientSecret)), redirectUri_(std::move(redirectUri)) {
  loop_.run();
}

std::string GoogleOAuthClient::authorizeUrl(const std::string& state) const {
  return "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=" + urlEncode(clientId_) +
         "&redirect_uri=" + urlEncode(redirectUri_) + "&scope=" + urlEncode("openid email profile") +
         "&state=" + urlEncode(state) + "&prompt=select_account";
}

void GoogleOAuthClient::exchangeCode(const std::string& code,
                                     std::function<void(std::optional<GoogleIdentity>)> done) {
  if (!configured()) {
    done(std::nullopt);
    return;
  }

  const std::string form = "grant_type=authorization_code&code=" + urlEncode(code) +
                           "&client_id=" + urlEncode(clientId_) + "&client_secret=" + urlEncode(clientSecret_) +
                           "&redirect_uri=" + urlEncode(redirectUri_);

  auto client = drogon::HttpClient::newHttpClient("https://oauth2.googleapis.com", loop_.getLoop());
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Post);
  req->setPath("/token");
  req->setContentTypeString("application/x-www-form-urlencoded");
  req->setBody(form);

  const std::string clientId = clientId_;
  client->sendRequest(
      req,
      [client, clientId, done = std::move(done)](drogon::ReqResult result, const drogon::HttpResponsePtr& resp) {
        const int status = resp ? static_cast<int>(resp->getStatusCode()) : 0;
        if (result != drogon::ReqResult::Ok || status < 200 || status >= 300) {
          LOG_ERROR << "Google token exchange failed (status " << status << ")";
          done(std::nullopt);
          return;
        }
        std::shared_ptr<Json::Value> body = resp->getJsonObject();
        const std::string idToken = body ? asStr((*body)["id_token"]) : std::string();
        if (idToken.empty()) {
          done(std::nullopt);
          return;
        }
        done(identityFromIdToken(idToken, clientId));
      },
      10.0);
}

}

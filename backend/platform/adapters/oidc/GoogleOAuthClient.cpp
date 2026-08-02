#include "platform/adapters/oidc/GoogleOAuthClient.h"

#include "platform/adapters/http/VendorCall.h"
#include "platform/adapters/oidc/IdToken.h"

#include <drogon/HttpClient.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <json/json.h>

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

// The verified identity inside a Google id_token, or nullopt if it's malformed, not for us, or the
// email isn't Google-verified. The signature is not re-checked (see the header); aud/iss/verified
// are the trust gate. `sub` is the durable half — it is what binds the door to an account, so a
// token without one is refused rather than resolved by its address alone.
std::optional<ProviderIdentity> identityFromIdToken(const std::string& idToken, const std::string& clientId) {
  const std::optional<Json::Value> claims = idTokenClaims(idToken);
  if (!claims) return std::nullopt;

  if (stringClaim(*claims, "aud") != clientId) return std::nullopt;  // minted for another client (or multi-aud)
  const std::string iss = stringClaim(*claims, "iss");
  if (iss != "accounts.google.com" && iss != "https://accounts.google.com") return std::nullopt;
  if (!verifiedClaim(*claims, "email_verified")) return std::nullopt;

  const std::string subject = stringClaim(*claims, "sub");
  const std::optional<Email> email = parseEmail(stringClaim(*claims, "email"));
  if (subject.empty() || !email) return std::nullopt;

  return ProviderIdentity{Provider::google, subject, *email, stringClaim(*claims, "name"), true};
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
                                     std::function<void(std::optional<ProviderIdentity>)> done) {
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
  VendorCall call("google", "exchange");
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

}

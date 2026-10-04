#pragma once

#include <mutex>

#include "platform/domain/Auth.h"
#include "platform/ports/AppleIdentityVerifier.h"

#include <trantor/net/EventLoopThread.h>
#include <json/json.h>

#include <functional>
#include <optional>
#include <string>

namespace wm {

// Windmill as an OAuth client to Apple, native flow: the app posts an authorization code, redeemed
// here at Apple's token endpoint with the identity read out of the id_token. Apple's client_secret
// is a short-lived ES256 JWT signed with the team's .p8 key, minted per exchange. Any of client id /
// team / key id / key missing → configured() is false. The email may be a Hide My Email relay —
// verified and stable for this app only (domain/Auth.h's AddressTrust). The name never appears in
// the id_token; it reaches us through the request body or not at all.
class AppleOAuthClient {
public:
  virtual ~AppleOAuthClient() { stop(); }
  void stop() {
    std::call_once(stopped_, [this] {
      loop_.run();
      auto* loop = loop_.getLoop();
      loop->queueInLoop([loop] { loop->quit(); });
      loop_.wait();
    });
  }

  AppleOAuthClient(std::string clientId, std::string teamId, std::string keyId, std::string privateKeyPem);

  virtual bool configured() const {
    return !clientId_.empty() && !teamId_.empty() && !keyId_.empty() && !privateKeyPem_.empty();
  }
  virtual void exchangeCode(const std::string& code, std::function<void(std::optional<ProviderIdentity>)> done);

private:
  // The per-exchange ES256 client secret, or empty if the .p8 key won't load or sign.
  std::string clientSecret() const;

  std::string clientId_;  // the app's bundle identifier for the native flow
  std::string teamId_;
  std::string keyId_;
  std::string privateKeyPem_;
  std::once_flag stopped_;
  trantor::EventLoopThread loop_;
};

class AppleIdentityTokenVerifier final : public AppleIdentityVerifier {
public:
  ~AppleIdentityTokenVerifier() { stop(); }
  void stop() {
    std::call_once(stopped_, [this] {
      loop_.run();
      auto* loop = loop_.getLoop();
      loop->queueInLoop([loop] { loop->quit(); });
      loop_.wait();
    });
  }

  AppleIdentityTokenVerifier(bool enabled, std::string clientId);
  bool configured() const override { return enabled_ && !clientId_.empty(); }
  void verify(const std::string& identityToken, const std::string& nonce, Completion done) override;

  static std::optional<ProviderIdentity> verifiedIdentity(const std::string& identityToken,
      const std::string& nonce, const std::string& clientId, const Json::Value& keys, UnixMs now);

private:
  bool enabled_;
  std::string clientId_;
  std::once_flag stopped_;
  trantor::EventLoopThread loop_;
};

}

#pragma once

#include "platform/domain/Auth.h"

#include <functional>
#include <optional>
#include <string>

namespace wm {

struct AppleIdentityVerifier {
  using Completion = std::function<void(std::optional<ProviderIdentity>)>;
  virtual ~AppleIdentityVerifier() = default;
  virtual bool configured() const = 0;
  virtual void verify(const std::string& identityToken, const std::string& nonce, Completion done) = 0;
};

}

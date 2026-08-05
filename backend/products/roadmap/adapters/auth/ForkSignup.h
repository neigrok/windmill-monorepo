#pragma once

#include "platform/ports/SignupFork.h"
#include "products/roadmap/application/ForkService.h"

#include <optional>
#include <string>

namespace wm {

// The roadmap's answer to the platform SignupFork port: it holds the ForkService and turns the
// port's opaque source id into a TreeId, so the auth HTTP surface can name and plant a fork
// without ever seeing a roadmap type. Only this file — living beside the product it forks — ties
// the platform sign-in flow to roadmap; a journal/gym-only deploy injects nothing and the flow
// no-ops. This adapter also owns the plant's warn/error logging, since it owns the fork call.
class ForkSignup : public SignupFork {
public:
  explicit ForkSignup(ForkService& fork);

  std::optional<AuthService::ForkDescription> describe(const std::string& source) override;
  std::optional<std::string> plant(const std::string& source, const UserId& user) override;

private:
  ForkService& fork_;
};

}

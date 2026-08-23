#pragma once

#include "platform/ports/SignupFork.h"
#include "products/roadmap/application/ForkService.h"

#include <optional>
#include <string>

namespace wm {

// The roadmap's answer to the platform SignupFork port: it turns the port's opaque source id
// into a TreeId, so the auth HTTP surface can name and plant a fork without seeing a roadmap
// type. A deploy that injects nothing no-ops the flow. The fork mail's words are written here
// too — a step count is roadmap's fact — and cross the seam as prose.
class ForkSignup : public SignupFork {
public:
  explicit ForkSignup(ForkService& fork);

  std::optional<ForkDescription> describe(const std::string& source) override;
  std::optional<std::string> plant(const std::string& source, const UserId& user) override;

private:
  ForkService& fork_;
};

}

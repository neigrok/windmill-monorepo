#pragma once

#include "platform/ports/SignupFork.h"
#include "products/roadmap/application/ForkService.h"

#include <optional>
#include <string>

namespace wm {

class ForkSignup : public SignupFork {
public:
  explicit ForkSignup(ForkService& fork);

  std::optional<ForkDescription> describe(const std::string& source) override;
  std::optional<std::string> plant(const std::string& source, const UserId& user) override;

private:
  ForkService& fork_;
};

}

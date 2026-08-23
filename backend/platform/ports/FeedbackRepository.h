#pragma once

#include "platform/domain/Ids.h"

#include <optional>
#include <string>

namespace wm {

// nullopt user means a ghost session; email and context are empty strings when absent.
struct FeedbackRepository {
  virtual ~FeedbackRepository() = default;
  virtual void insert(const std::string& sessionKey, const std::optional<UserId>& user,
                      const std::string& message, const std::string& email,
                      const std::string& context) = 0;
};

}

#pragma once

#include "domain/Ids.h"

#include <optional>
#include <string>

namespace wm {

// The feedback sink (the feedback door): persist one note under the browser's client-minted
// correlation key and the user the session resolved to — nullopt for a ghost. email and
// context are optional; the caller passes empty strings when they are absent.
struct FeedbackRepository {
  virtual ~FeedbackRepository() = default;
  virtual void insert(const std::string& sessionKey, const std::optional<UserId>& user,
                      const std::string& message, const std::string& email,
                      const std::string& context) = 0;
};

}

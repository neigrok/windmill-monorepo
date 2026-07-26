#pragma once

#include "platform/ports/FeedbackRepository.h"

#include <string>

namespace wm {

class PgFeedbackRepository : public FeedbackRepository {
public:
  explicit PgFeedbackRepository(std::string connString);

  void insert(const std::string& sessionKey, const std::optional<UserId>& user,
              const std::string& message, const std::string& email,
              const std::string& context) override;

private:
  std::string connString_;
};

}

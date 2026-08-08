#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "platform/ports/FeedbackRepository.h"

#include <memory>
#include <string>

namespace wm {

class PgFeedbackRepository : public FeedbackRepository {
public:
  explicit PgFeedbackRepository(std::shared_ptr<PgPool> pool);

  void insert(const std::string& sessionKey, const std::optional<UserId>& user,
              const std::string& message, const std::string& email,
              const std::string& context) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}

#pragma once

#include "platform/adapters/llm/AiCallBudget.h"
#include "platform/domain/AiFuse.h"
#include "platform/ports/AiUsageRepository.h"
#include "platform/ports/FailureReporter.h"
#include "products/gym/coach/CoachModel.h"

#include <memory>
#include <string>

namespace wm::gym::coach {

// Anthropic's streaming Messages call under the platform meter: every round reserves USD for the
// seat's principal (the account, or the installation of an `anon` seat) under operation `turn`,
// and settles at actual usage.
class AnthropicCoachModel : public CoachModel {
public:
  AnthropicCoachModel(std::string apiKey, std::string baseUrl, std::shared_ptr<FailureReporter> failures,
                      std::shared_ptr<AiFuse> fuse, std::shared_ptr<UsageSink> usage,
                      std::shared_ptr<AiCallBudget> budget);

  bool configured() const override { return !apiKey_.empty(); }
  ModelCall open(const TurnPrincipal& principal, const std::string& turnId,
                 std::function<void(const std::string&)> text, std::function<bool()> continueRun,
                 std::function<void(const std::string&)> refused) override;

private:
  std::string apiKey_;
  std::string baseUrl_;
  std::shared_ptr<FailureReporter> failures_;
  std::shared_ptr<AiFuse> fuse_;
  std::shared_ptr<UsageSink> usage_;
  std::shared_ptr<AiCallBudget> budget_;
};

}

#pragma once

#include "platform/adapters/amplitude/AmplitudeClient.h"
#include "platform/ports/AiUsageRepository.h"

#include <memory>

namespace wm {

// Mirrors every metered vendor call to Amplitude. It WRAPS the ledger rather than replacing it, and
// the order is load-bearing: the ledger is the truth and is written first; Amplitude is
// fire-and-forget and may lose an event. Counts and costs only, never content.
class AmplitudeUsageSink : public UsageSink {
public:
  AmplitudeUsageSink(std::shared_ptr<UsageSink> ledger, std::shared_ptr<AmplitudeClient> amplitude);

  void record(const AiSpend& spend) noexcept override;

private:
  std::shared_ptr<UsageSink> ledger_;
  std::shared_ptr<AmplitudeClient> amplitude_;
};

}

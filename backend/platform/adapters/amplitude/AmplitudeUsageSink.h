#pragma once

#include "platform/adapters/amplitude/AmplitudeClient.h"
#include "platform/ports/AiUsageRepository.h"

#include <memory>

namespace wm {

// Mirrors every metered vendor call to Amplitude, so the charts and the alerting are somebody else's
// job. It WRAPS the ledger rather than replacing it, and the order is the whole design:
//
//   the ledger is the truth, and is written first. It is what the rate limits read, it is
//   transactional, and it is queryable synchronously before a call is made — none of which an
//   analytics vendor can be. Amplitude is the EYES, is fire-and-forget, and is allowed to lose an
//   event; a dropped one costs a pixel on a chart, and money is never reconciled from it.
//
// So: never invert these two, and never let a spend reach Amplitude without reaching the ledger.
//
// Counts and costs only, never content — the same rule the ledger and VendorCall already hold. There
// is no parameter here through which a prompt, a reply, a page or a tool argument could arrive.
class AmplitudeUsageSink : public UsageSink {
public:
  AmplitudeUsageSink(std::shared_ptr<UsageSink> ledger, std::shared_ptr<AmplitudeClient> amplitude);

  void record(const AiSpend& spend) noexcept override;

private:
  std::shared_ptr<UsageSink> ledger_;
  std::shared_ptr<AmplitudeClient> amplitude_;
};

}

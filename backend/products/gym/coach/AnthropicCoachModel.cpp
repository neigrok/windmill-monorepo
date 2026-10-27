#include "products/gym/coach/AnthropicCoachModel.h"

#include "platform/adapters/llm/AnthropicStream.h"
#include "products/gym/adapters/llm/AnthropicAsk.h"

#include <utility>

namespace wm::gym::coach {

AnthropicCoachModel::AnthropicCoachModel(std::string apiKey, std::string baseUrl,
                                         std::shared_ptr<FailureReporter> failures, std::shared_ptr<AiFuse> fuse,
                                         std::shared_ptr<UsageSink> usage, std::shared_ptr<AiCallBudget> budget)
    : apiKey_(std::move(apiKey)), baseUrl_(std::move(baseUrl)), failures_(std::move(failures)),
      fuse_(std::move(fuse)), usage_(std::move(usage)), budget_(std::move(budget)) {}

ModelCall AnthropicCoachModel::open(const TurnPrincipal& principal, const std::string& turnId,
                                    std::function<void(const std::string&)> text, std::function<bool()> continueRun,
                                    std::function<void(const std::string&)> refused) {
  AiSpend frame;
  if (principal.account) frame.user = principal.account->id;
  frame.product = "gym";
  frame.operation = "turn";
  frame.model = seatModel(principal.seat, kCoachMaxOutputTokens).model;
  frame.runId = turnId;
  const std::shared_ptr<const AiInstallationPrincipal> installation =
      principal.installation ? std::make_shared<const AiInstallationPrincipal>(*principal.installation) : nullptr;

  const ModelCall stream = [apiKey = apiKey_, baseUrl = baseUrl_, text = std::move(text), continueRun,
                            refused](const Json::Value& request) {
    return streamAnthropicMessage(apiKey, baseUrl, request, text, continueRun, [&](const Json::Value& diagnostic) {
      const int status = diagnostic["httpStatus"].asInt();
      if (status == 429 || status == 529 || diagnostic["providerError"].asString() == "rate_limit_error")
        refused("coach-rate-limited");
    });
  };
  // The fuse reports its first trip itself; the turn's loop reports everything else once, under
  // its own static name, so nothing is said here.
  const AgentReport report = [](const std::string&, const std::string&) {};
  return metered(stream, frame, fuse_, usage_, report, [refused] { refused("coach-busy"); }, budget_,
                 [refused](const std::string& code) { refused(code); }, 1'024, installation);
}

}

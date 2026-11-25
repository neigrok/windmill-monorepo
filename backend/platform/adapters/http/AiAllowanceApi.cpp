#include "platform/adapters/http/AiAllowanceApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/json/AiBudgetJson.h"
#include "platform/adapters/http/JsonReply.h"
#include "platform/application/WriteObservation.h"

namespace wm {

AiAllowanceApi::AiAllowanceApi(std::shared_ptr<AuthService> auth, std::shared_ptr<Entitlements> entitlements,
                               std::shared_ptr<FailureReporter> failures)
    : auth_(std::move(auth)), entitlements_(std::move(entitlements)), failures_(std::move(failures)) {}

void AiAllowanceApi::get(const drogon::HttpRequestPtr& request,
                         std::function<void(const drogon::HttpResponsePtr&)>&& reply) {
  WriteObservation observation{"ai.allowance.read", "platform", "rest", "", failures_.get()};
  WriteContext context{observation};
  const auto answer = [reply = std::move(reply), &observation](const drogon::HttpResponsePtr& response) {
    observation.skip();
    response->addHeader("Cache-Control", "no-store");
    reply(response);
  };
  try {
    const std::optional<User> account = SentCaller::of(request, *auth_).user;
    if (!account) {
      answer(error(drogon::k401Unauthorized, "Sign in to view your AI allowance.", "unauthenticated"));
      return;
    }
    if (!entitlements_->aiAllowancesEnabled()) {
      answer(error(drogon::k503ServiceUnavailable, "AI allowances are not enabled.", "ai_allowance_disabled"));
      return;
    }
    const auto allowance = entitlements_->aiAllowanceView(account->id, account->email.value);
    auto body = aiAllowanceJson(allowance);
    const bool individual = allowance.code == AiBudgetCode::SubjectExhausted;
    body["status"] = allowance.code == AiBudgetCode::Ok ? "available"
        : individual ? "allowance_exhausted" : "unavailable";
    auto response = jsonResponse(body);
    answer(response);
  } catch (...) {
    observation.failUnknown();
    answer(error(drogon::k503ServiceUnavailable, "AI allowance is unavailable.", "ai_accounting_unavailable"));
  }
}

}

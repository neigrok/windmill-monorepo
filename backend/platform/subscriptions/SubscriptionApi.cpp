#include "platform/subscriptions/SubscriptionApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "platform/application/WriteObservation.h"

#include <utility>

namespace wm::subscriptions {

SubscriptionApi::SubscriptionApi(std::shared_ptr<AuthService> auth, std::shared_ptr<Entitlements> entitlements,
                                 PaidLine line, std::shared_ptr<FailureReporter> failures)
    : auth_(std::move(auth)), entitlements_(std::move(entitlements)), line_(std::move(line)),
      failures_(std::move(failures)) {}

void SubscriptionApi::get(const drogon::HttpRequestPtr& request,
                          std::function<void(const drogon::HttpResponsePtr&)>&& reply) {
  WriteObservation observation{"subscription.read", "platform", "rest", "", failures_.get()};
  WriteContext context{observation};
  const auto answer = [reply = std::move(reply), &observation](const drogon::HttpResponsePtr& response) {
    observation.skip();
    response->addHeader("Cache-Control", "no-store");
    reply(response);
  };
  try {
    const std::optional<User> caller = callerUserOf(request, *auth_);
    if (!caller) {
      answer(error(drogon::k401Unauthorized, "sign in first"));
      return;
    }
    const Standing standing = entitlements_->standingOf(caller->id, caller->email.value);
    answer(jsonResponse(SubscriptionResponse{standing, line_}.body));
  } catch (const std::exception& failure) {
    observation.fail(failure);
    answer(error(drogon::k503ServiceUnavailable, "Your subscription can't be read right now.", "subscription_unavailable"));
  }
}

}

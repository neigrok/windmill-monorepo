#include "platform/subscriptions/SubscriptionApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "platform/adapters/http/WriteRoutes.h"
#include "platform/application/WriteObservation.h"

#include <trantor/utils/Logger.h>

#include <string>
#include <utility>

namespace wm::subscriptions {

namespace {
// A refusal of the claim door: `{code}`, as app-store-claim.json pins it.
drogon::HttpResponsePtr refused(drogon::HttpStatusCode status, const char* code) {
  Json::Value body(Json::objectValue);
  body["code"] = code;
  return jsonResponse(body, status);
}

// §5.3: what a device is answered for each refusal of the service's claim door. An erased account is answered as its
// session's next request is, and every 503 means the same to a device: claim again later.
drogon::HttpResponsePtr answerTo(const std::string& refusal) {
  if (refusal == "invalid_transaction") return refused(drogon::k400BadRequest, "invalid_transaction");
  if (refusal == "bound_to_another_account") return refused(drogon::k409Conflict, "bound_to_another_account");
  if (refusal == "account_erased") return error(drogon::k401Unauthorized, "sign in first");
  return refused(drogon::k503ServiceUnavailable, "subscriptions_unavailable");
}
}

SubscriptionApi::SubscriptionApi(std::shared_ptr<AuthService> auth, std::shared_ptr<Entitlements> entitlements,
                                 PaidLine line, std::shared_ptr<FailureReporter> failures,
                                 std::optional<ClaimForwarding> claims)
    : auth_(std::move(auth)), entitlements_(std::move(entitlements)), line_(std::move(line)),
      failures_(std::move(failures)), claims_(std::move(claims)) {}

void SubscriptionApi::get(const drogon::HttpRequestPtr& request, Reply&& reply) {
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

void SubscriptionApi::claimAppStore(const drogon::HttpRequestPtr& request, Reply&& reply) {
  const auto answer = [reply = std::move(reply)](const drogon::HttpResponsePtr& response) {
    response->addHeader("Cache-Control", "no-store");
    reply(response);
  };
  const std::optional<User> caller = callerUserOf(request, *auth_);
  if (!caller) {
    answer(error(drogon::k401Unauthorized, "sign in first"));
    return;
  }
  const std::shared_ptr<Json::Value> body = request->getJsonObject();
  const Json::Value& signedTransaction =
      body && body->isObject() ? (*body)["signedTransaction"] : Json::Value::nullSingleton();
  if (!signedTransaction.isString() || signedTransaction.asString().empty() ||
      signedTransaction.asString().size() > kSignedTransactionBytes) {
    settleCurrentWriteAs("malformed");
    answer(refused(drogon::k400BadRequest, "invalid_transaction"));
    return;
  }
  if (!claims_) {
    settleCurrentWriteAs("unconfigured");
    answer(refused(drogon::k503ServiceUnavailable, "subscriptions_unavailable"));
    return;
  }

  // The service's answer and the wait for the copy block for seconds, so they run on the claim's own threads.
  const bool taken = claims_->workers->post([claims = *claims_, entitlements = entitlements_, line = line_, request,
                                             answer, account = *caller, transaction = signedTransaction.asString()] {
    observeHttpWork(request, [&] {
      try {
        const ClaimAnswer claimed = claims.service->claim(account.id, transaction);
        if (claimed.refusal) {
          settleCurrentWriteAs(*claimed.refusal);
          answer(answerTo(*claimed.refusal));
          return;
        }
        // The copy every gate reads is what the device is shown, so it waits for the follower to bring the claim there.
        if (!claims.follower->reach(claimed.seq, claims.wait)) settleCurrentWriteAs("copy_behind");
        answer(jsonResponse(SubscriptionResponse{entitlements->standingOf(account.id, account.email.value), line}.body));
      } catch (const ClaimUnanswered& unanswered) {
        LOG_WARN << "subscription claim: the service gave no answer the contract describes (" << unanswered.answer << ")";
        reportCurrentWriteFailure(unanswered);
        answer(refused(drogon::k503ServiceUnavailable, "subscriptions_unavailable"));
      } catch (const std::exception& failure) {
        reportCurrentWriteFailure(failure);
        answer(refused(drogon::k503ServiceUnavailable, "subscriptions_unavailable"));
      }
    });
  });
  if (taken) return;
  settleCurrentWriteAs("busy");
  answer(refused(drogon::k503ServiceUnavailable, "subscriptions_unavailable"));
}

}

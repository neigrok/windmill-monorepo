#include "platform/adapters/paddle/BillingApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "platform/adapters/paddle/PaddleSignature.h"

#include <json/json.h>
#include <trantor/utils/Logger.h>

#include <optional>
#include <utility>

namespace wm {

namespace {
// asString() throws on a non-string node; read every field defensively so a surprising payload
// degrades to empty rather than throwing inside the handler.
std::string asStr(const Json::Value& value) {
  return value.isString() ? value.asString() : std::string();
}

// custom_data rides in from a checkout anyone can open, so treat it as untrusted input: a value
// that isn't a UUID would reach a ::uuid bind, throw, and make Paddle redeliver the same poison
// payload until its retry budget is gone. An unusable id is simply no binding.
bool isUuid(const std::string& value) {
  if (value.size() != 36) return false;
  for (std::size_t i = 0; i < value.size(); ++i) {
    const char c = value[i];
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (c != '-') return false;
      continue;
    }
    const bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
    if (!hex) return false;
  }
  return true;
}

// Paddle nests the plan on the first line item, and sets scheduled_change only while a pause or
// cancel is pending. A hybrid subscription can carry several items; the first is the plan we bill on.
PaddleSubscription subscriptionFrom(const Json::Value& data, const std::string& occurredAt) {
  PaddleSubscription subscription;
  subscription.subscriptionId = asStr(data["id"]);
  subscription.customerId = asStr(data["customer_id"]);
  subscription.status = asStr(data["status"]);

  // Our checkout stamps the Windmill account on the transaction and Paddle carries it here, so the
  // binding is something we set rather than something we matched. Absent for a subscription created
  // outside that flow, which the read resolves by email instead.
  const Json::Value& custom = data["custom_data"];
  if (custom.isObject()) {
    const std::string claimed = asStr(custom["user_id"]);
    if (isUuid(claimed)) subscription.userId = claimed;
  }
  subscription.occurredAt = occurredAt;

  const Json::Value& items = data["items"];
  if (items.isArray() && !items.empty() && items[0].isObject()) {
    const Json::Value& price = items[0]["price"];
    if (price.isObject()) {
      subscription.priceId = asStr(price["id"]);
      subscription.productId = asStr(price["product_id"]);
    }
  }

  const Json::Value& scheduled = data["scheduled_change"];
  if (scheduled.isObject()) subscription.scheduledChangeAt = asStr(scheduled["effective_at"]);
  return subscription;
}
}

BillingApi::BillingApi(SubscriptionRepository& subscriptions, std::shared_ptr<AuthService> auth,
                       Clock& clock, std::string webhookSecret,
                       std::shared_ptr<PaddleApiClient> paddle, std::string priceId)
    : subscriptions_(subscriptions), auth_(std::move(auth)), clock_(clock),
      webhookSecret_(std::move(webhookSecret)), paddle_(std::move(paddle)),
      priceId_(std::move(priceId)) {}

// One click, one checkout. The browser sends nothing but its session: the account's email and id
// come from the session alone, so there is no field to mistype and no way to open a checkout for
// anyone else. A fresh transaction each time keeps the link single-use — a stale one can't be
// handed to another session.
void BillingApi::startCheckout(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  const std::optional<User> user = callerUserOf(req, *auth_);
  if (!user) {
    callback(error(drogon::k401Unauthorized, "sign in first"));
    return;
  }
  if (!paddle_ || !paddle_->configured() || priceId_.empty()) {
    callback(error(drogon::k503ServiceUnavailable, "billing is not configured"));
    return;
  }

  paddle_->startCheckout(user->email.value, user->id.str(), priceId_,
                         [callback = std::move(callback)](std::optional<PaddleCheckout> checkout) {
                           if (!checkout) {
                             callback(error(drogon::k502BadGateway, "could not open a checkout"));
                             return;
                           }
                           Json::Value body(Json::objectValue);
                           body["transactionId"] = checkout->transactionId;
                           if (!checkout->checkoutUrl.empty()) body["checkoutUrl"] = checkout->checkoutUrl;
                           callback(jsonResponse(body));
                         });
}

void BillingApi::webhook(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  // The signature covers the exact bytes Paddle sent: verify against the raw body, never against a
  // reserialization of parsed JSON.
  const std::string body{req->getBody()};
  const std::string signature = req->getHeader("paddle-signature");
  if (body.empty() || signature.empty()) {
    callback(error(drogon::k400BadRequest, "missing signature or body"));
    return;
  }
  if (webhookSecret_.empty() ||
      !verifyPaddleSignature(body, signature, webhookSecret_, clock_.nowMs())) {
    // Every non-2xx is retried on the same budget, so refusing here loses nothing: a forged
    // delivery is harmless, and a rotated secret recovers by itself once the new one is deployed.
    LOG_ERROR << "paddle webhook rejected: signature did not verify";
    callback(error(drogon::k401Unauthorized, "signature did not verify"));
    return;
  }

  // Only a 2xx marks the event delivered, so anything that throws must answer non-2xx and let
  // Paddle redeliver rather than silently dropping a billing state change.
  try {
    std::shared_ptr<Json::Value> event = req->getJsonObject();
    if (!event || !event->isObject()) {
      callback(error(drogon::k400BadRequest, "not a JSON event"));
      return;
    }
    const std::string type = asStr((*event)["event_type"]);
    const Json::Value& data = (*event)["data"];

    if (type == "customer.created" || type == "customer.updated") {
      subscriptions_.upsertCustomer(PaddleCustomer{asStr(data["id"]), asStr(data["email"])});
    } else if (type.rfind("subscription.", 0) == 0) {
      subscriptions_.upsertSubscription(subscriptionFrom(data, asStr((*event)["occurred_at"])));
    }
    // Anything else is subscribed but not mirrored — acknowledge it rather than retry forever.
  } catch (const std::exception& e) {
    LOG_ERROR << "paddle webhook failed: " << e.what();
    callback(error(drogon::k500InternalServerError, "not recorded"));
    return;
  }

  Json::Value body_(Json::objectValue);
  body_["received"] = true;
  callback(jsonResponse(body_));
}

void BillingApi::mySubscription(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  const std::optional<User> user = callerUserOf(req, *auth_);
  if (!user) {
    callback(error(drogon::k401Unauthorized, "sign in first"));
    return;
  }

  // One predicate over both bindings, preferring any live subscription — see the repository port.
  Json::Value body(Json::objectValue);
  const std::optional<PaddleSubscription> subscription =
      subscriptions_.findFor(user->id, user->email.value);
  if (!subscription) {
    // No Paddle customer yet — every account before its first checkout.
    body["status"] = "none";
    body["active"] = false;
    callback(jsonResponse(body));
    return;
  }

  body["status"] = subscription->status;
  body["active"] = grantsAccess(subscription->status);
  body["subscriptionId"] = subscription->subscriptionId;
  body["priceId"] = subscription->priceId;
  body["productId"] = subscription->productId;
  // Present only while a pause or cancel is pending — the UI's cue to say when it takes effect
  // instead of offering to subscribe.
  if (!subscription->scheduledChangeAt.empty())
    body["scheduledChangeAt"] = subscription->scheduledChangeAt;
  callback(jsonResponse(body));
}

}

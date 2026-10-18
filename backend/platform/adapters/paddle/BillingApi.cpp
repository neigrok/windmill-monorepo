#include "platform/application/WriteObservation.h"
#include "platform/adapters/paddle/BillingApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "platform/adapters/paddle/PaddleSignature.h"

#include <json/json.h>
#include <trantor/utils/Logger.h>

#include <chrono>
#include <optional>
#include <utility>

namespace wm {

namespace {
// asString() throws on a non-string node; read every field defensively.
std::string asStr(const Json::Value& value) {
  return value.isString() ? value.asString() : std::string();
}

// custom_data rides in from a checkout anyone can open: a value that isn't a UUID would reach a
// ::uuid bind and throw, making Paddle redeliver forever. An unusable id is simply no binding.
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

std::optional<long long> timestampMs(const Json::Value& value) {
  if (!value.isString()) return std::nullopt;
  const auto text = value.asString();
  if (text.size() < 20 || text[4] != '-' || text[7] != '-' || text[10] != 'T' ||
      text[13] != ':' || text[16] != ':') return std::nullopt;
  const auto digits = [&](std::size_t offset, std::size_t length) -> int {
    if (offset + length > text.size()) return -1;
    int result = 0;
    for (std::size_t i = offset; i < offset + length; ++i) {
      if (text[i] < '0' || text[i] > '9') return -1;
      result = result * 10 + text[i] - '0';
    }
    return result;
  };
  const int year = digits(0, 4), month = digits(5, 2), day = digits(8, 2);
  const int hour = digits(11, 2), minute = digits(14, 2), second = digits(17, 2);
  const std::chrono::year_month_day date{std::chrono::year{year}, std::chrono::month{static_cast<unsigned>(month)},
                                        std::chrono::day{static_cast<unsigned>(day)}};
  if (!date.ok() || year < 1970 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59)
    return std::nullopt;
  std::size_t at = 19;
  int milliseconds = 0;
  if (at < text.size() && text[at] == '.') {
    const auto start = ++at;
    while (at < text.size() && text[at] >= '0' && text[at] <= '9') ++at;
    if (at == start || at - start > 9) return std::nullopt;
    for (std::size_t i = 0; i < 3; ++i)
      milliseconds = milliseconds * 10 + (start + i < at ? text[start + i] - '0' : 0);
  }
  int offsetMinutes = 0;
  if (at + 1 == text.size() && text[at] == 'Z') {
    ++at;
  } else if (at + 6 == text.size() && (text[at] == '+' || text[at] == '-') && text[at + 3] == ':') {
    const int hours = digits(at + 1, 2), minutes = digits(at + 4, 2);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return std::nullopt;
    offsetMinutes = (hours * 60 + minutes) * (text[at] == '+' ? 1 : -1);
    at += 6;
  } else return std::nullopt;
  if (at != text.size()) return std::nullopt;
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::sys_days{date}.time_since_epoch()).count()
      + (hour * 3600LL + minute * 60LL + second - offsetMinutes * 60LL) * 1000 + milliseconds;
}

bool positiveAmount(const Json::Value& value) {
  if (!value.isString()) return false;
  const auto amount = value.asString();
  if (amount.empty() || amount.size() > 18) return false;
  bool positive = false;
  for (const auto c : amount) {
    if (c < '0' || c > '9') return false;
    positive = positive || c != '0';
  }
  return positive;
}

std::optional<AiBudgetPeriod> fundedMonthlyPeriod(const Json::Value& data, const std::string& priceId) {
  if (!data.isObject() || data["status"] != "completed" || !data["items"].isArray() || data["items"].size() != 1)
    return std::nullopt;
  const auto& item = data["items"][0];
  if (!item.isObject() || !item["price"].isObject() || item["quantity"] != 1 ||
      !item.isMember("proration") || !item["proration"].isNull()) return std::nullopt;
  const auto& price = item["price"];
  if (price["id"] != priceId || !price["billing_cycle"].isObject() ||
      price["billing_cycle"]["interval"] != "month" || price["billing_cycle"]["frequency"] != 1)
    return std::nullopt;
  if (!data["details"].isObject() || !data["details"]["totals"].isObject() ||
      !positiveAmount(data["details"]["totals"]["grand_total"]) || data["details"]["totals"]["balance"] != "0")
    return std::nullopt;
  const auto& lines = data["details"]["line_items"];
  if (!lines.isArray() || lines.size() != 1 || !lines[0].isObject() || lines[0]["price_id"] != priceId ||
      lines[0]["quantity"] != 1 || !lines[0].isMember("proration") || !lines[0]["proration"].isNull() ||
      !lines[0]["totals"].isObject() || !positiveAmount(lines[0]["totals"]["total"])) return std::nullopt;
  bool captured = false;
  if (!data["payments"].isArray()) return std::nullopt;
  for (const auto& payment : data["payments"])
    if (payment.isObject() && payment["status"] == "captured" && positiveAmount(payment["amount"]) &&
        timestampMs(payment["captured_at"])) captured = true;
  if (!captured || !data["billing_period"].isObject()) return std::nullopt;
  const auto start = timestampMs(data["billing_period"]["starts_at"]);
  const auto end = timestampMs(data["billing_period"]["ends_at"]);
  constexpr long long dayMs = 86'400'000;
  if (!start || !end || *end - *start < 27 * dayMs || *end - *start > 32 * dayMs) return std::nullopt;
  return AiBudgetPeriod{*start, *end};
}

// Paddle nests the plan on the first line item; scheduled_change is set only while a pause or cancel is pending.
PaddleSubscription subscriptionFrom(const Json::Value& data, const std::string& occurredAt) {
  PaddleSubscription subscription;
  subscription.subscriptionId = asStr(data["id"]);
  subscription.customerId = asStr(data["customer_id"]);
  subscription.status = asStr(data["status"]);

  // Our checkout stamps the Windmill account on the transaction. Absent for a subscription created
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
                       std::string priceId,
                       std::shared_ptr<AiBudgetService> budgets, AuthRepository* accounts, long long fundedPeriodNanos)
    : subscriptions_(subscriptions), auth_(std::move(auth)), clock_(clock),
      webhookSecret_(std::move(webhookSecret)),
      priceId_(std::move(priceId)), budgets_(std::move(budgets)), accounts_(accounts),
      fundedPeriodNanos_(fundedPeriodNanos) {}

// Funding can be configured while checkout remains closed.
void BillingApi::startCheckout(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  const std::optional<User> user = callerUserOf(req, *auth_);
  if (!user) {
    callback(error(drogon::k401Unauthorized, "sign in first"));
    return;
  }
  callback(error(drogon::k503ServiceUnavailable, "Windmill One checkout is closed.", "checkout_closed"));
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
    // Every non-2xx is retried on the same budget: a rotated secret recovers once the new one deploys.
    LOG_ERROR << "paddle webhook rejected: signature did not verify";
    callback(error(drogon::k401Unauthorized, "signature did not verify"));
    return;
  }

  // Only a 2xx marks the event delivered, so anything that throws must answer non-2xx.
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
    if (type == "transaction.completed" && budgets_) {
      WriteObservation observation{"ai.budget.payment", "platform", "webhook"};
      WriteContext context{observation};
      if (priceId_.empty() || !accounts_) {
        observation.finish("unconfigured");
        callback(error(drogon::k503ServiceUnavailable, "AI funding is not configured.", "funding_unconfigured"));
        return;
      }
      const auto period = fundedMonthlyPeriod(data, priceId_);
      if (!period) {
        observation.finish("unsupported_purchase");
      } else {
        const auto transactionId = asStr(data["id"]);
        const auto customerId = asStr(data["customer_id"]);
        const auto subscriptionId = asStr(data["subscription_id"]);
        if (!validAiBudgetId(transactionId) || !transactionId.starts_with("txn_") ||
            !validAiBudgetId(customerId) || !customerId.starts_with("ctm_") ||
            !validAiBudgetId(subscriptionId) || !subscriptionId.starts_with("sub_")) {
          observation.finish("invalid_payment_identity");
          callback(error(drogon::k400BadRequest, "Invalid payment identity.", "invalid_payment_identity"));
          return;
        }
        const auto customer = subscriptions_.findCustomer(customerId);
        const auto subscription = subscriptions_.findSubscription(subscriptionId);
        const auto account = customer ? accounts_->findUserByEmail(Email{customer->email}) : std::nullopt;
        if (!customer || !subscription || !account || account->deletedAt) {
          observation.finish("funding_binding_pending");
          callback(error(drogon::k503ServiceUnavailable, "Payment account binding is not ready.", "funding_binding_pending"));
          return;
        }
        const auto claimed = data["custom_data"].isObject() ? asStr(data["custom_data"]["user_id"]) : std::string{};
        if (subscription->customerId != customerId || subscription->priceId != priceId_ ||
            (!subscription->userId.empty() && subscription->userId != account->id.str()) ||
            (!claimed.empty() && claimed != account->id.str())) {
          observation.finish("funding_account_mismatch");
          callback(error(drogon::k409Conflict, "Payment account binding does not match.", "funding_account_mismatch"));
          return;
        }
        const auto result = budgets_->fund(AiBudgetGrant{transactionId, account->id.str(),
            AiBudgetFundingSource::Subscription, *period, fundedPeriodNanos_, transactionId});
        if (result.code != AiBudgetCode::Ok && result.code != AiBudgetCode::Replay) {
          observation.finish(std::string(aiBudgetCodeName(result.code)));
          callback(error(drogon::k409Conflict, "Payment funding could not be recorded.", "funding_conflict"));
          return;
        }
        observation.finish(result.code == AiBudgetCode::Replay ? "replay" : "funded");
      }
    }
    // Other event types carry no allowance funding.
  } catch (const std::exception& e) {
    reportCurrentWriteFailure(e);
    LOG_ERROR << "paddle webhook failed: " << "unexpected storage exception";
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
  // Present only while a pause or cancel is pending.
  if (!subscription->scheduledChangeAt.empty())
    body["scheduledChangeAt"] = subscription->scheduledChangeAt;
  callback(jsonResponse(body));
}

}

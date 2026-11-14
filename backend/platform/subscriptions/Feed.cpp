#include "platform/subscriptions/Feed.h"

#include <algorithm>
#include <set>
#include <string_view>
#include <utility>

namespace wm::subscriptions {

namespace {
// The contract's vocabularies: §3.4's events, D-1's stores, D-2's environments and §3.1's offers.
const std::set<std::string> kEventTypes{
    "started", "renewed", "renewal_turned_off", "renewal_turned_on", "payment_failed", "payment_recovered",
    "pause_scheduled", "paused", "resumed", "plan_change_scheduled", "plan_changed", "period_extended", "expired",
    "revoked", "revocation_reversed", "updated", "bound", "unbound", "period_recorded", "period_refunded",
    "period_refund_reversed"};
const std::set<std::string> kPeriodEvents{"period_recorded", "period_refunded", "period_refund_reversed"};
const std::set<std::string> kStores{"app_store", "play_store", "paddle"};
const std::set<std::string> kEnvironments{"production", "sandbox"};
const std::set<std::string> kOfferKinds{"free_trial", "introductory", "promotional", "offer_code", "win_back"};

// Every key of the contract is always present (packages/api-contract/subscriptions/README.md).
const Json::Value& field(const Json::Value& object, const char* key) {
  if (!object.isObject() || !object.isMember(key)) throw FeedUnavailable("malformed");
  return object[key];
}

std::string text(const Json::Value& value) {
  if (!value.isString() || value.asString().empty()) throw FeedUnavailable("malformed");
  return value.asString();
}

std::string oneOf(const std::set<std::string>& words, const Json::Value& value) {
  std::string word = text(value);
  if (!words.count(word)) throw FeedUnavailable("malformed");
  return word;
}

// A word the contract does not name yet reads as none, and is listed under its field.
std::optional<std::string> offerOrNone(const Json::Value& value, const char* fieldName,
                                       std::vector<UnknownWord>& unknownWords) {
  if (value.isNull()) return std::nullopt;
  std::string word = text(value);
  if (kOfferKinds.count(word)) return word;
  unknownWords.push_back({fieldName, std::move(word)});
  return std::nullopt;
}

std::string uuid(const Json::Value& value) {
  std::string id = text(value);
  if (!isUuid(id)) throw FeedUnavailable("malformed");
  return id;
}

Seq seqOf(const Json::Value& value) {
  if (!value.isUInt64()) throw FeedUnavailable("malformed");
  return value.asUInt64();
}

std::int64_t instant(const Json::Value& value) {
  if (!value.isInt64()) throw FeedUnavailable("malformed");
  return value.asInt64();
}

std::optional<std::int64_t> instantOrNull(const Json::Value& value) {
  if (value.isNull()) return std::nullopt;
  return instant(value);
}

// A decimal amount ("12.00") and a three-letter ISO 4217 code ("USD"), or no price at all.
std::optional<Price> priceOrNull(const Json::Value& value) {
  if (value.isNull()) return std::nullopt;
  Price price{text(field(value, "amount")), text(field(value, "currency"))};
  const std::size_t point = price.amount.find('.');
  const auto digits = [](std::string_view part) {
    return !part.empty() && std::all_of(part.begin(), part.end(), [](char c) { return c >= '0' && c <= '9'; });
  };
  const bool decimal = digits(std::string_view(price.amount).substr(0, point)) &&
                       (point == std::string::npos || digits(std::string_view(price.amount).substr(point + 1)));
  const bool currency = price.currency.size() == 3 &&
                        std::all_of(price.currency.begin(), price.currency.end(), [](char c) { return c >= 'A' && c <= 'Z'; });
  if (!decimal || !currency) throw FeedUnavailable("malformed");
  return price;
}
}

EntitlementResponse::EntitlementResponse(Json::Value response)
    : accountId(text(field(response, "accountId"))),
      productionAccessUntil(instantOrNull(field(field(response, "production"), "accessUntil"))),
      sandboxAccessUntil(instantOrNull(field(field(response, "sandbox"), "accessUntil"))),
      body(std::move(response)) {}

Period::Period(const Json::Value& period, std::vector<UnknownWord>& unknownWords)
    : id(uuid(field(period, "id"))), start(instant(field(period, "start"))), end(instant(field(period, "end"))),
      price(priceOrNull(field(period, "price"))),
      offerKind(offerOrNone(field(period, "offerKind"), "period.offerKind", unknownWords)),
      refundedAt(instantOrNull(field(period, "refundedAt"))) {}

FeedEntry::FeedEntry(const Json::Value& entry)
    : seq(seqOf(field(entry, "seq"))), type(text(field(entry, "type"))), knownType(kEventTypes.count(type) > 0),
      occurredAt(instant(field(entry, "occurredAt"))), recordedAt(instant(field(entry, "recordedAt"))),
      subscriptionId(uuid(field(entry, "subscriptionId"))), store(text(field(entry, "store"))),
      environment(oneOf(kEnvironments, field(entry, "environment"))) {
  if (!knownType) unknownWords.push_back({"type", type});
  if (!kStores.count(store)) {
    unknownWords.push_back({"store", store});
    store = "unknown";
  }
  offerKind = offerOrNone(field(entry, "offerKind"), "offerKind", unknownWords);

  const Json::Value& stretch = field(entry, "period");
  if (knownType && stretch.isNull() == (kPeriodEvents.count(type) > 0)) throw FeedUnavailable("malformed");
  if (knownType && !stretch.isNull()) period.emplace(stretch, unknownWords);

  const Json::Value& account = field(entry, "accountId");
  const Json::Value& after = field(entry, "entitlement");
  if (account.isNull() != after.isNull()) throw FeedUnavailable("malformed");
  if (account.isNull()) return;
  accountId = UserId{uuid(account)};
  entitlement.emplace(after);
  if (entitlement->accountId != *accountId) throw FeedUnavailable("malformed");
}

FeedPage::FeedPage(const Json::Value& page)
    : epoch(text(field(page, "epoch"))), latestSeq(seqOf(field(page, "latestSeq"))) {
  const Json::Value& listed = field(page, "entries");
  if (!listed.isArray()) throw FeedUnavailable("malformed");
  for (const Json::Value& entry : listed) {
    entries.emplace_back(entry);
    if (entries.size() > 1 && entries.back().seq <= entries[entries.size() - 2].seq) throw FeedUnavailable("malformed");
  }
  if (!entries.empty() && entries.back().seq > latestSeq) throw FeedUnavailable("malformed");
}

std::optional<std::string> FeedCursor::restoreIn(const FeedPage& page) const {
  if (epoch.empty()) return std::nullopt;
  if (page.epoch != epoch) return "epoch";
  if (page.latestSeq < seq) return "latest_seq_below_cursor";
  return std::nullopt;
}

FeedCursor FeedCursor::past(const FeedPage& page) const {
  if (!epoch.empty() && page.epoch != epoch) throw FeedUnavailable("epoch-changed");
  if (page.entries.empty()) return FeedCursor{page.epoch, seq};
  if (page.entries.front().seq <= seq) throw FeedUnavailable("out-of-order");
  return FeedCursor{page.epoch, page.entries.back().seq};
}

}

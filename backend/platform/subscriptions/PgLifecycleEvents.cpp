#include "platform/subscriptions/PgLifecycleEvents.h"

#include "platform/adapters/json/JsonText.h"
#include "platform/application/WriteObservation.h"
#include "platform/domain/sync/Digest.h"
#include "platform/subscriptions/PgEntitlementCopy.h"

#include <algorithm>
#include <map>
#include <optional>
#include <string>
#include <utility>

namespace wm::subscriptions {

namespace {
// The feed's events a person's subscription lives through with no device present, and the name each is recorded under.
const std::map<std::string, std::string> kRecordedAs{
    {"started", "subscription_started"},
    {"renewed", "subscription_renewed"},
    {"renewal_turned_off", "subscription_renewal_turned_off"},
    {"payment_failed", "subscription_payment_failed"},
    {"expired", "subscription_expired"},
    {"revoked", "subscription_revoked"}};

std::string digest(const std::string& text) { return sync::sha256(text).hex().substr(0, 32); }

// The event as the store records it. Its properties are bounded words: the feed reads a store it does not name as
// `unknown` and refuses an environment it does not, and an offer is one of §3.1's, `none`, or `unknown` for one the
// contract does not name yet. The device key is the subscription's own, which the store keeps only for an event it
// records as no one's.
ServerEvent lifecycleEvent(const FeedEntry& entry, const std::string& name) {
  const bool unnamedOffer = std::any_of(entry.unknownWords.begin(), entry.unknownWords.end(),
                                        [](const UnknownWord& unknown) { return unknown.field == "offerKind"; });
  Json::Value props(Json::objectValue);
  props["store"] = entry.store;
  props["environment"] = entry.environment;
  props["offer_kind"] = entry.offerKind ? *entry.offerKind : std::string(unnamedOffer ? "unknown" : "none");
  const std::string key = digest(entry.subscriptionId + " " + name + " " + std::to_string(entry.occurredAt));
  return ServerEvent{kSubscriptionDevicePrefix + digest(entry.subscriptionId), entry.accountId,
                     FunnelEvent{name, entry.occurredAt, dump(props), key}};
}
}

void PgLifecycleEvents::consume(PageTxn& page, const FeedEntry& entry) {
  const auto recordedAs = kRecordedAs.find(entry.type);
  if (recordedAs == kRecordedAs.end()) return;
  observeWrite("subscription.record", "platform", "background", [&] {
    std::optional<ServerEvent> recorded = events_.recordOnce(sqlOf(page), lifecycleEvent(entry, recordedAs->second));
    if (!recorded) return finishCurrentWriteUnchanged();
    page.afterCommit([this, told = std::move(*recorded)] { forwarder_.forward(told.sessionKey, told.user, {told.event}); });
  });
}

}

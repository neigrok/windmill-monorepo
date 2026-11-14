#include "platform/subscriptions/WindmillOne.h"

#include "platform/domain/AiBudget.h"

#include <algorithm>
#include <array>
#include <set>
#include <stdexcept>
#include <utility>

namespace wm::subscriptions {

namespace {
// D-1's stores in order, each with the page where its customer manages what it sold them. A store with no such page at
// a fixed address has none, and the subscriptions it sold show no manage link.
struct Store {
  const char* name;
  const char* managePage;
};
constexpr std::array<Store, 3> kStores{{
    {"app_store", "https://apps.apple.com/account/subscriptions"}, {"play_store", nullptr}, {"paddle", nullptr}}};

const char* nameOf(Environment environment) {
  return environment == Environment::Production ? "production" : "sandbox";
}

// The Entitlement of an environment where the account holds no subscription (§5.2).
const Json::Value& noSubscription() {
  static const Json::Value block = [] {
    Json::Value empty(Json::objectValue);
    empty["plan"] = Json::Value(Json::nullValue);
    empty["accessUntil"] = Json::Value(Json::nullValue);
    empty["governing"] = Json::Value(Json::nullValue);
    empty["others"] = Json::Value(Json::arrayValue);
    return empty;
  }();
  return block;
}

// A subscription that has not ended: a word the contract does not name yet counts as live, so no account is offered a
// second subscription beside one the backend cannot read.
bool live(const Json::Value& subscription) {
  return subscription.isObject() && subscription["state"] != "expired" && subscription["state"] != "revoked";
}

Json::Value manageOf(const Json::Value& governing) {
  if (!governing.isObject()) return Json::Value(Json::nullValue);
  for (const Store& store : kStores) {
    if (governing["store"] != store.name || !store.managePage) continue;
    Json::Value manage(Json::objectValue);
    manage["store"] = store.name;
    manage["url"] = store.managePage;
    return manage;
  }
  return Json::Value(Json::nullValue);
}

// USD written with its minor units (`7.00`); a digit past them is kept, never rounded away (§3.1).
std::string usd(long long nanos) {
  std::string amount = formatAiUsd(nanos);
  const std::size_t cents = amount.find('.') + 3;
  while (amount.size() > cents && amount.back() == '0') amount.pop_back();
  return amount;
}
}

bool Standing::grants(Environment environment) const {
  if (!entitlement) return false;
  const std::optional<std::int64_t>& until = environment == Environment::Production
      ? entitlement->productionAccessUntil : entitlement->sandboxAccessUntil;
  return until && now < *until;
}

bool Standing::hasWindmillOne() const {
  return owner || grants(Environment::Production) || (allowlisted && grants(Environment::Sandbox));
}

Environment Standing::shown() const {
  const bool sandboxAlone = grants(Environment::Sandbox) && !grants(Environment::Production);
  return allowlisted && sandboxAlone ? Environment::Sandbox : Environment::Production;
}

bool Standing::fundedAsOwner() const {
  return owner || shown() == Environment::Sandbox;
}

PaidLine::PaidLine(std::string_view purchasableStores, long long aiAllowanceNanos)
    : aiAllowanceNanos(aiAllowanceNanos) {
  std::set<std::string> named;
  std::size_t at = 0;
  while (at <= purchasableStores.size()) {
    const std::size_t end = std::min(purchasableStores.find(',', at), purchasableStores.size());
    std::string word;
    for (const char c : purchasableStores.substr(at, end - at))
      if (c != ' ' && c != '\t') word.push_back(c);
    if (!word.empty()) named.insert(std::move(word));
    at = end + 1;
  }
  for (const std::string& word : named) {
    const bool known = std::any_of(kStores.begin(), kStores.end(), [&](const Store& store) { return word == store.name; });
    if (!known) throw std::invalid_argument("SUBSCRIPTIONS_PURCHASABLE_STORES names a store the backend does not know: " + word);
  }
  for (const Store& store : kStores)
    if (named.count(store.name)) openStores.emplace_back(store.name);
}

SubscriptionResponse::SubscriptionResponse(const Standing& standing, const PaidLine& line) : body(Json::objectValue) {
  const Environment environment = standing.shown();
  const Json::Value& shown = standing.entitlement ? standing.entitlement->body[nameOf(environment)] : noSubscription();
  body["environment"] = nameOf(environment);
  body["allowlisted"] = standing.allowlisted;
  for (const char* field : {"plan", "accessUntil", "governing", "others"}) body[field] = shown[field];
  body["manage"] = manageOf(shown["governing"]);

  bool holdsLive = live(shown["governing"]);
  for (const Json::Value& other : shown["others"]) holdsLive = holdsLive || live(other);
  Json::Value purchasable(Json::arrayValue);
  if (!standing.hasWindmillOne() && !holdsLive)
    for (const std::string& store : line.openStores) purchasable.append(store);
  body["purchasable"] = purchasable;

  if (purchasable.empty()) {
    body["offer"] = Json::Value(Json::nullValue);
    return;
  }
  body["offer"]["aiAllowance"]["amount"] = usd(line.aiAllowanceNanos);
  body["offer"]["aiAllowance"]["currency"] = "USD";
}

}

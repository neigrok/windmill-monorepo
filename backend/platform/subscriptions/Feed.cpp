#include "platform/subscriptions/Feed.h"

#include <utility>

namespace wm::subscriptions {

namespace {
// Every key of the contract is always present (packages/api-contract/subscriptions/README.md).
const Json::Value& field(const Json::Value& object, const char* key) {
  if (!object.isObject() || !object.isMember(key)) throw FeedUnavailable("malformed");
  return object[key];
}

std::string text(const Json::Value& value) {
  if (!value.isString() || value.asString().empty()) throw FeedUnavailable("malformed");
  return value.asString();
}

Seq seqOf(const Json::Value& value) {
  if (!value.isUInt64()) throw FeedUnavailable("malformed");
  return value.asUInt64();
}

std::optional<std::int64_t> accessUntil(const Json::Value& entitlement) {
  const Json::Value& value = field(entitlement, "accessUntil");
  if (value.isNull()) return std::nullopt;
  if (!value.isInt64()) throw FeedUnavailable("malformed");
  return value.asInt64();
}
}

EntitlementResponse::EntitlementResponse(Json::Value response)
    : accountId(text(field(response, "accountId"))),
      productionAccessUntil(accessUntil(field(response, "production"))),
      sandboxAccessUntil(accessUntil(field(response, "sandbox"))),
      body(std::move(response)) {}

FeedEntry::FeedEntry(const Json::Value& entry)
    : seq(seqOf(field(entry, "seq"))), type(text(field(entry, "type"))) {
  const Json::Value& account = field(entry, "accountId");
  const Json::Value& after = field(entry, "entitlement");
  if (account.isNull() != after.isNull()) throw FeedUnavailable("malformed");
  if (account.isNull()) return;
  if (!isUuid(text(account))) throw FeedUnavailable("malformed");
  accountId = UserId{account.asString()};
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

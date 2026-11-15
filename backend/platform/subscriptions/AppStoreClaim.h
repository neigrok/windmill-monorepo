#pragma once

#include "platform/domain/Ids.h"

#include <json/json.h>

#include <algorithm>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>

namespace wm::subscriptions {

// The service's claim door gave no answer the contract describes; `answer` is a bounded word (`timeout`, `unreachable`,
// an HTTP status, `malformed`, …), never a body.
struct ClaimUnanswered : std::runtime_error {
  explicit ClaimUnanswered(std::string answer)
      : std::runtime_error("app store claim unanswered: " + answer), answer(std::move(answer)) {}
  const std::string answer;
};

// What the service's claim door answered (§5.2): the seq of the claimed subscription's newest event, or the code of its
// refusal (§4). The entitlement a 200 carries is not read: a device is answered from the copy, which every gate reads.
struct ClaimAnswer {
  // ClaimUnanswered for a status and body the contract does not describe, as a refusal it does not name.
  ClaimAnswer(int status, const Json::Value& body) {
    if (!body.isObject()) throw ClaimUnanswered("malformed");
    if (status == 200) {
      if (!body["seq"].isUInt64()) throw ClaimUnanswered("malformed");
      seq = body["seq"].asUInt64();
      return;
    }
    const std::pair<int, const char*> refusals[] = {
        {400, "invalid_transaction"}, {409, "bound_to_another_account"}, {409, "account_erased"},
        {503, "unavailable"},         {503, "store_unavailable"},        {503, "store_api_unavailable"}};
    const bool named = std::any_of(std::begin(refusals), std::end(refusals),
                                   [&](const auto& refused) { return status == refused.first && body["code"] == refused.second; });
    if (!named) throw ClaimUnanswered(std::to_string(status));
    refusal = body["code"].asString();
  }

  Seq seq = 0;
  std::optional<std::string> refusal;
};

// The service's claim door (§4, §5.2): binds the App Store subscription `signedTransaction` belongs to to `account`, the
// one the caller's session names. A claim retried after its answer was lost answers the same.
struct AppStoreClaims {
  virtual ~AppStoreClaims() = default;
  virtual ClaimAnswer claim(const UserId& account, const std::string& signedTransaction) = 0;
};

}

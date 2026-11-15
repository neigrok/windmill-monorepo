#pragma once

#include "platform/adapters/json/JsonText.h"
#include "platform/domain/Ids.h"

#include <json/json.h>

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <iterator>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>

namespace wm::subscriptions {

// The largest body the service's internal doors take (services/subscriptions/crates/server/src/listeners.rs, Bounds).
inline constexpr std::size_t kServiceBodyBytes = 64 * 1024;

// The longest the service's claim door is given to answer, past which the claim is unanswered.
inline constexpr std::chrono::seconds kClaimAnswerWait{10};

// A transaction as StoreKit 2 signs it, in JWS compact serialization: three base64url segments joined by dots. Its
// characters need no escape in JSON, so the claim that forwards it is its length and a fixed envelope.
class SignedTransaction {
public:
  // A StoreKit 2 transaction is a few kilobytes signed.
  static constexpr std::size_t kBytes = 32 * 1024;

  // None for text that is not one, or is longer than kBytes.
  static std::optional<SignedTransaction> read(std::string_view text) {
    if (text.empty() || text.size() > kBytes) return std::nullopt;
    int segments = 1;
    bool segmentEmpty = true;
    for (const char c : text) {
      if (c == '.') {
        if (segmentEmpty) return std::nullopt;
        ++segments;
        segmentEmpty = true;
        continue;
      }
      const bool base64url = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
      if (!base64url) return std::nullopt;
      segmentEmpty = false;
    }
    if (segments != 3 || segmentEmpty) return std::nullopt;
    return SignedTransaction{std::string(text)};
  }

  const std::string& text() const { return text_; }

private:
  explicit SignedTransaction(std::string text) : text_(std::move(text)) {}
  std::string text_;
};

// The body a claim forwards, `{"accountId":…,"signedTransaction":…}`, around a canonical account id and the transaction.
inline constexpr std::size_t kClaimEnvelopeBytes = std::string_view(R"({"accountId":"","signedTransaction":""})").size() + 36;
static_assert(SignedTransaction::kBytes + kClaimEnvelopeBytes <= kServiceBodyBytes,
              "every claim forwarded fits the body the service takes");

// The service's claim door gave no answer the contract describes; `answer` is a bounded word (`timeout`, `unreachable`,
// an HTTP status, `malformed`, …), never a body.
struct ClaimUnanswered : std::runtime_error {
  explicit ClaimUnanswered(std::string answer)
      : std::runtime_error("app store claim unanswered: " + answer), answer(std::move(answer)) {}
  const std::string answer;
};

// What the service's claim door answered (§5.2): the seq of the claimed subscription's newest event, or why it refused.
// The status is read before the body. A refusal is the code the contract names for its status, `timeout` for the
// request the service gave up on itself, or `too_large` for a body it would not read. The entitlement a 200 carries is
// not read: a device is answered from the copy, which every gate reads.
struct ClaimAnswer {
  // ClaimUnanswered for a status and body the contract does not describe, as a refusal it does not name.
  ClaimAnswer(int status, const std::string& body) {
    if (status == 413) {
      refusal = "too_large";
      return;
    }
    const std::pair<int, const char*> refusals[] = {
        {400, "invalid_transaction"}, {409, "bound_to_another_account"}, {409, "account_erased"},
        {503, "unavailable"},         {503, "store_unavailable"},        {503, "store_api_unavailable"}};
    const bool contractStatus = status == 200 || std::any_of(std::begin(refusals), std::end(refusals),
                                                             [&](const auto& refused) { return status == refused.first; });
    if (!contractStatus) throw ClaimUnanswered(std::to_string(status));
    const std::optional<Json::Value> answer = parseWhole(body);
    if (!answer || !answer->isObject()) throw ClaimUnanswered(status == 200 ? "malformed" : std::to_string(status));
    if (status == 200) {
      if (!(*answer)["seq"].isUInt64()) throw ClaimUnanswered("malformed");
      seq = (*answer)["seq"].asUInt64();
      return;
    }
    if (status == 503 && (*answer)["error"] == "timeout") {
      refusal = "timeout";
      return;
    }
    const bool named = std::any_of(std::begin(refusals), std::end(refusals), [&](const auto& refused) {
      return status == refused.first && (*answer)["code"] == refused.second;
    });
    if (!named) throw ClaimUnanswered(std::to_string(status));
    refusal = (*answer)["code"].asString();
  }

  Seq seq = 0;
  std::optional<std::string> refusal;
};

// The service's claim door (§4, §5.2): binds the App Store subscription `signedTransaction` belongs to to `account`, the
// one the caller's session names, and answers within kClaimAnswerWait. A claim retried after its answer was lost
// answers the same.
struct AppStoreClaims {
  virtual ~AppStoreClaims() = default;
  virtual ClaimAnswer claim(const UserId& account, const SignedTransaction& signedTransaction) = 0;
};

}

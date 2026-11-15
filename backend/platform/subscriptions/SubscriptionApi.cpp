#include "platform/subscriptions/SubscriptionApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "platform/adapters/http/WriteRoutes.h"
#include "platform/application/FailureWindow.h"
#include "platform/application/WriteObservation.h"

#include <deque>
#include <map>
#include <mutex>
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

drogon::HttpResponsePtr claimAgainLater() {
  return refused(drogon::k503ServiceUnavailable, "subscriptions_unavailable");
}

// §5.3: what a device is answered for each refusal of the service's claim door. A body the service would not read held
// no transaction it could verify; an erased account is answered as its session's next request is; and every 503, the
// request the service gave up on included, means the same to a device: claim again later.
drogon::HttpResponsePtr answerTo(const std::string& refusal) {
  if (refusal == "invalid_transaction" || refusal == "too_large") return refused(drogon::k400BadRequest, "invalid_transaction");
  if (refusal == "bound_to_another_account") return refused(drogon::k409Conflict, "bound_to_another_account");
  if (refusal == "account_erased") return error(drogon::k401Unauthorized, "sign in first");
  return claimAgainLater();
}
}

struct SubscriptionApi::Claims : std::enable_shared_from_this<Claims> {
  struct Claim {
    drogon::HttpRequestPtr request;
    Reply answer;
    User caller;
    SignedTransaction transaction;
    std::chrono::steady_clock::time_point taken;
  };

  Claims(ClaimForwarding forwarding, std::shared_ptr<Entitlements> entitlements, PaidLine line,
         std::shared_ptr<FailureReporter> reporter)
      : forwarding_(std::move(forwarding)), entitlements_(std::move(entitlements)), line_(std::move(line)),
        reporter_(std::move(reporter)), seqUnreached_(*reporter_, "subscription.claim.seq_unreached") {}

  // Behind the account's claims already taken, or refused `busy` when kClaimsPerAccount are. Called inside the claim's
  // write observation.
  void take(const drogon::HttpRequestPtr& request, const Reply& answer, const User& caller, SignedTransaction transaction) {
    const std::string account = caller.id.str();
    enum class Taken { first, behind, full };
    const Taken taken = [&] {
      std::lock_guard lock{mutex_};
      std::deque<Claim>& line = taken_[account];
      if (line.size() >= kClaimsPerAccount) return Taken::full;
      line.push_back(Claim{request, answer, caller, std::move(transaction), forwarding_.now()});
      return line.size() == 1 ? Taken::first : Taken::behind;
    }();
    if (taken == Taken::first) post(account);
    if (taken != Taken::full) return;
    settleCurrentWriteAs("busy");
    answer(claimAgainLater());
  }

private:
  // The account's first claim onto the pool's queue, behind every claim taken before it. One the pool refuses is
  // answered `busy`, and the next behind it is tried.
  void post(const std::string& account) {
    for (;;) {
      if (forwarding_.workers->post([self = shared_from_this(), account] { self->settleFirst(account); })) return;
      const bool another = answerFirst(account, [](const Claim&) {
        settleCurrentWriteAs("busy");
        return claimAgainLater();
      });
      if (!another) return;
    }
  }

  // The account's first claim settled on this worker, then the one behind it posted.
  void settleFirst(const std::string& account) {
    if (answerFirst(account, [this](const Claim& claim) { return settle(claim); })) post(account);
  }

  // Answers the account's first claim with what `answering` makes of it, under the claim's own line, and takes it off
  // the account's claims: true when another waits behind it.
  template <typename Answering>
  bool answerFirst(const std::string& account, Answering answering) {
    const Claim claim = [&] {
      std::lock_guard lock{mutex_};
      return taken_.at(account).front();
    }();
    observeHttpWork(claim.request, [&] { claim.answer(answering(claim)); });
    std::lock_guard lock{mutex_};
    std::deque<Claim>& line = taken_.at(account);
    line.pop_front();
    if (!line.empty()) return true;
    taken_.erase(account);
    return false;
  }

  // A claim through the service and the copy (§5.3), unless the process is stopping or the claim waited too long.
  drogon::HttpResponsePtr settle(const Claim& claim) {
    if (forwarding_.stopping()) {
      settleCurrentWriteAs("stopping");
      return claimAgainLater();
    }
    if (forwarding_.now() - claim.taken > kClaimQueueWait) {
      settleCurrentWriteAs("expired");
      return claimAgainLater();
    }
    try {
      const ClaimAnswer answered = forwarding_.service->claim(claim.caller.id, claim.transaction);
      if (answered.refusal) {
        settleCurrentWriteAs(*answered.refusal);
        // The two sides no longer agree on the body a claim may send.
        if (*answered.refusal == "too_large") reportUnanswered("413");
        return answerTo(*answered.refusal);
      }
      // The copy every gate reads is what the device is shown, so it waits for the follower to bring the claim there.
      bool reached = false;
      if (!forwarding_.stopping()) {
        reached = forwarding_.follower->reach(answered.seq, forwarding_.wait);
        const std::optional<Seq> caughtUp = reached ? std::nullopt : forwarding_.follower->caughtUpTo();
        if (caughtUp && *caughtUp < answered.seq) seqUnreached_.report("cause=past_the_ledger");
      }
      if (!reached) settleCurrentWriteAs("copy_behind");
      Standing standing = entitlements_->standingOf(claim.caller.id, claim.caller.email.value);
      standing.recordedClaim = !reached;
      return jsonResponse(SubscriptionResponse{standing, line_}.body, reached ? drogon::k200OK : drogon::k202Accepted);
    } catch (const ClaimUnanswered& unanswered) {
      settleCurrentWriteAs("unanswered_" + unanswered.answer);
      reportUnanswered(unanswered.answer);
      return claimAgainLater();
    } catch (const std::exception& failure) {
      reportCurrentWriteFailure(failure);
      return claimAgainLater();
    }
  }

  // One Issue per answer per window, so no caller spends the process's reports on claims the service cannot answer.
  void reportUnanswered(const std::string& answer) {
    FailureWindow* window = nullptr;
    {
      std::lock_guard lock{mutex_};
      window = &unanswered_.try_emplace(answer, *reporter_, "subscription.claim.unanswered").first->second;
    }
    window->report("answer=" + answer);
  }

  const ClaimForwarding forwarding_;
  const std::shared_ptr<Entitlements> entitlements_;
  const PaidLine line_;
  const std::shared_ptr<FailureReporter> reporter_;
  FailureWindow seqUnreached_;
  std::mutex mutex_;
  std::map<std::string, std::deque<Claim>> taken_;  // by account: the one with the service first
  std::map<std::string, FailureWindow> unanswered_;  // by answer
};

SubscriptionApi::SubscriptionApi(std::shared_ptr<AuthService> auth, std::shared_ptr<Entitlements> entitlements,
                                 PaidLine line, std::shared_ptr<FailureReporter> failures,
                                 std::optional<ClaimForwarding> claims)
    : auth_(std::move(auth)), entitlements_(std::move(entitlements)), line_(std::move(line)),
      failures_(std::move(failures)),
      claims_(claims ? std::make_shared<Claims>(std::move(*claims), entitlements_, line_, failures_) : nullptr) {}

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
  const Reply answer = [reply = std::move(reply)](const drogon::HttpResponsePtr& response) {
    response->addHeader("Cache-Control", "no-store");
    reply(response);
  };
  const std::optional<User> caller = callerUserOf(request, *auth_);
  if (!caller) {
    answer(error(drogon::k401Unauthorized, "sign in first"));
    return;
  }
  const std::shared_ptr<Json::Value> body = request->getJsonObject();
  const Json::Value& sent = body && body->isObject() ? (*body)["signedTransaction"] : Json::Value::nullSingleton();
  std::optional<SignedTransaction> transaction = sent.isString() ? SignedTransaction::read(sent.asString()) : std::nullopt;
  if (!transaction) {
    settleCurrentWriteAs("malformed");
    answer(refused(drogon::k400BadRequest, "invalid_transaction"));
    return;
  }
  if (!claims_) {
    settleCurrentWriteAs("unconfigured");
    answer(claimAgainLater());
    return;
  }
  claims_->take(request, answer, *caller, std::move(*transaction));
}

}

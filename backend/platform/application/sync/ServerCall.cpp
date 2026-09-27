#include "platform/application/sync/ServerCall.h"

#include "platform/domain/sync/Wire.h"

#include <utility>

namespace wm::sync {

namespace {

Digest256 callDigest(const std::string& tool, const Json::Value& args) {
  Json::Value call(Json::objectValue);
  call["tool"] = tool;
  call["args"] = args;
  return intentDigest(call);
}

}

ServerCall::ServerCall(Admission& admission, SyncStore& store, UserId account, std::optional<std::string> requestId, const std::string& tool,
                       const Json::Value& args)
    : admission_(admission), store_(store), account_(std::move(account)), requestId_(std::move(requestId)), digest_(callDigest(tool, args)) {}

AdmitOutcome ServerCall::admit(Json::Value intent, Ms serverNow) {
  ++k_;
  if (!requestId_) return admission_.admit(ServerOrigin{account_, std::nullopt}, intent, serverNow);
  // A call's parts are stored under `<requestId>#k`, so a requestId holding '#' could name another call's part.
  if (requestId_->empty() || requestId_->find_first_of(std::string("#\0", 2)) != std::string::npos) {
    return CallAnswered{refusedResult(Refused{code::invalid, {}})};
  }
  intent["gestureId"] = *requestId_;
  return admission_.admit(ServerOrigin{account_, CallPart{*requestId_, k_, digest_}}, intent, serverNow);
}

void ServerCall::finish(const Json::Value& result, Ms serverNow) {
  if (!requestId_) return;
  std::unique_ptr<SyncTxn> txn = store_.begin(TxnMode::write);
  store_.lockRequest(*txn, account_, *requestId_);
  const std::optional<RequestRow> call = store_.request(*txn, account_, *requestId_);
  if (!call || call->digest != digest_) return;
  store_.putRequest(*txn, account_, RequestRow{*requestId_, digest_, false, result, serverNow});
  txn->commit();
}

}

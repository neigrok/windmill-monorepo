#pragma once

#include "platform/application/sync/Admission.h"
#include "platform/domain/Ids.h"
#include "platform/domain/sync/Digest.h"
#include "platform/ports/SyncStore.h"

#include <json/json.h>

#include <optional>
#include <string>

namespace wm::sync {

// §6.3: one server-origin call (an MCP tool, a REST write, tending), its admits in order. With a
// requestId the call is deduplicated by sha256(jcs({tool, args})): the first admit that runs looks the call
// up in its own transaction, every admit k stores its part under `<requestId>#k`, and finish() writes the
// call's result into its row after the last part. Every intent of the call carries the requestId as its
// gestureId.
class ServerCall {
public:
  ServerCall(Admission& admission, SyncStore& store, UserId account, std::optional<std::string> requestId, const std::string& tool,
             const Json::Value& args, std::string product = "platform");
  // A call with no requestId: nothing deduplicates it, so nothing names it, and its gesture is server-minted.
  ServerCall(Admission& admission, SyncStore& store, UserId account, std::string product);

  // The call's next admit. A part a run of the call stored before is replayed: it answers Admitted with that
  // result, and nothing is admitted or written. The call stops at an answer the lookup gave it whole
  // (CallAnswered; a requestId that is empty or holds '#' or U+0000 is answered invalid), at a refusal, stored or
  // replayed, which is its result, or at a transient Retry, which leaves a started call running.
  AdmitOutcome admit(Json::Value intent, Ms serverNow);
  AdmitOutcome admitBuilt(Json::Value scopeIntent, Ms serverNow, const Admission::ServerBuilder&);

  // §6.3 step 3: after the last part, the call's result (its refusal, else its last admit's) written into its
  // row, done, in a transaction of its own, which a repeat of the call answers. Only this call's own row, and
  // only while it runs: a fault already ended it.
  void finish(const Json::Value& result, Ms serverNow);

private:
  Admission& admission_;
  SyncStore& store_;
  UserId account_;
  std::optional<std::string> requestId_;
  Digest256 digest_;
  std::string gestureId_;
  std::string product_;
  int k_ = 0;
  bool ran_ = false;  // an admit of this call committed: the call was looked up
};

}

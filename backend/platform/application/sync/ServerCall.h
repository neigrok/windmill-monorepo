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
// up in its own transaction, every admit k stores its part under `<requestId>#k`, and finish() replaces
// `running` with the call's final result. Every intent of the call carries the requestId as its gestureId.
class ServerCall {
public:
  ServerCall(Admission& admission, SyncStore& store, UserId account, std::optional<std::string> requestId, const std::string& tool,
             const Json::Value& args);

  // The call's next admit. A part a run of the call stored before answers Admitted with that result and writes
  // nothing. The call stops at an answer the lookup gave it whole (CallAnswered; a requestId that is empty or
  // holds '#' or U+0000 is answered invalid), at a refusal, or at a transient Retry, which leaves a started call
  // running.
  AdmitOutcome admit(Json::Value intent, Ms serverNow);

  // The call's final result, which a repeat of the call answers. It replaces only this call's own row.
  void finish(const Json::Value& result, Ms serverNow);

private:
  Admission& admission_;
  SyncStore& store_;
  UserId account_;
  std::optional<std::string> requestId_;
  Digest256 digest_;
  int k_ = 0;
  bool ran_ = false;  // an admit of this call committed: the call was looked up
};

}

#include "products/journal/adapters/http/VoiceApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"

#include <json/value.h>

#include <optional>
#include <utility>

namespace wm {

VoiceApi::VoiceApi(std::shared_ptr<Transcriber> transcriber,
                   std::shared_ptr<Entitlements> entitlements, std::shared_ptr<AuthService> auth)
    : transcriber_(std::move(transcriber)), entitlements_(std::move(entitlements)),
      auth_(std::move(auth)) {}

void VoiceApi::transcribe(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<User> caller = callerUserOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to talk"));
    return;
  }
  // The entitlement is read BEFORE the audio is touched — a non-subscriber's bytes never reach the
  // vendor, and we never spend on an unpaid request.
  if (!entitlements_->hasWindmillOne(caller->id, caller->email.value)) {
    cb(error(drogon::k403Forbidden, "talk is part of Windmill One"));
    return;
  }
  if (!transcriber_->configured()) {
    // No vendor wired: answer plainly rather than pretend a model exists. The client hides Talk.
    cb(error(drogon::k503ServiceUnavailable, "voice is not available right now"));
    return;
  }

  const std::string audio{req->getBody()};   // ephemeral: a request-scoped copy, never persisted
  if (audio.empty()) {
    cb(error(drogon::k400BadRequest, "no audio"));
    return;
  }
  // Text out only — no page is created here; transcription stays orthogonal to persistence.
  const Transcript transcript = transcriber_->transcribe(audio, req->getHeader("content-type"));
  Json::Value body(Json::objectValue);
  body["text"] = transcript.text;
  cb(jsonResponse(body));
}

}

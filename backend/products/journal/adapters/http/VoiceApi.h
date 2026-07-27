#pragma once

#include "platform/application/AuthService.h"
#include "platform/ports/SubscriptionRepository.h"
#include "products/journal/ports/Transcriber.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// One door: talk, get text back. It is a Windmill One feature, so the subscription is checked BEFORE
// any audio is looked at — a non-subscriber's bytes never reach the vendor. The audio lives only in
// the request buffer and is never written anywhere; the reply is text only (no page is created —
// the client drops the words into today's page with source = spoken). When no vendor is wired the
// door answers 503 and the client hides Talk.
class VoiceApi {
public:
  VoiceApi(std::shared_ptr<Transcriber> transcriber,
           std::shared_ptr<SubscriptionRepository> subscriptions, std::shared_ptr<AuthService> auth);

  void transcribe(const drogon::HttpRequestPtr& req, HttpCallback&& cb);   // POST /v1/journal/transcribe

private:
  std::shared_ptr<Transcriber> transcriber_;
  std::shared_ptr<SubscriptionRepository> subscriptions_;
  std::shared_ptr<AuthService> auth_;
};

}

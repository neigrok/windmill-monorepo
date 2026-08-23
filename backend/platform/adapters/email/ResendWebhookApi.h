#pragma once

#include "platform/ports/Clock.h"
#include "platform/ports/MailSuppression.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <atomic>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// Resend's delivery webhook: verify the Svix signature, parse, apply the domain verdict
// (domain/Mail.h) to every registered MailStream. Never gates transactional mail.
// 401 unverified or no secret. 400 a verified body jsoncpp cannot parse (it throws past its
// stackLimit) — an exception out of a handler is a 5xx redelivered forever. 500 a stream write
// threw; every stream is still attempted and every write is idempotent. 200 for everything else
// including every no-op — a 404 would make this door an account-existence oracle.
class ResendWebhookApi {
public:
  ResendWebhookApi(std::vector<MailStream> streams, std::shared_ptr<Clock> clock,
                   std::string signingSecret);

  void webhook(const drogon::HttpRequestPtr& req, HttpCallback&& callback);  // POST /v1/resend/webhook

private:
  std::vector<MailStream> streams_;
  std::shared_ptr<Clock> clock_;
  std::string signingSecret_;
  std::atomic<unsigned> refusalsInARow_{0};  // drogon runs this handler on every worker thread
};

}

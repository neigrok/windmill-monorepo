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

// Resend's delivery webhook: verify the Svix signature, parse, and apply the domain verdict
// (domain/Mail.h) to every registered MailStream. It never gates transactional mail — the magic
// link is the only door into an account.
//
//   401  the signature did not verify, or no secret is configured. One refusal is logged at debug;
//        an unbroken run of them is raised to a warning.
//   400  a VERIFIED body we cannot parse: jsoncpp throws on a payload nested past its stackLimit,
//        and an exception out of a handler is a 5xx redelivered forever.
//   500  a stream's write threw. Every stream is still attempted first, and the 500 asks Svix to
//        redeliver the whole event; every write is idempotent.
//   200  everything else it understood, including every no-op — an unrecognised event type, a soft
//        bounce, an address no account owns. A 404 would make this door an account-existence oracle.
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

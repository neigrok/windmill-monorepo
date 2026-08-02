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

// Resend's delivery webhook — the one door in the system that can decide we must stop writing to a
// mailbox.
//
// It is PLATFORM's because the fact is: there is one Resend account, therefore one signing secret,
// one endpoint, and one stream carrying feedback about every mail this brand sends. A permanent
// bounce on the sign-in link and a permanent bounce on the weekly reminder are the same dead
// mailbox, and both must end every stream that writes to it. A receiver living inside one product
// could only ever stop that product's mail, and every other product would keep spending the
// deliverability the magic link depends on.
//
// So this class owns exactly three things — the Svix signature check, the parse, and the pure
// verdict (domain/Mail.h) — and no opinion at all about what suppression MEANS. Each product
// registers a MailStream saying what it stops; main.cpp assembles the list; one bounce writes them
// all. A product with no mail registers nothing, and this handler is then a verified 200 that does
// nothing, which is the honest answer.
//
// The hard-versus-soft rule is the only interesting thought in the feature, and a rule spelled out
// as an `if` inside a handler is one careless edit away from silencing everybody whose inbox was
// briefly full — which is why it lives in the domain and this class cannot decide it any other way.
//
// It never gates transactional mail: the magic link is the only door into an account, and someone
// who fixes their address must be able to walk back through it and switch their mail on again.
//
// What it answers, and why each one is the only honest code:
//   401  the signature did not verify, or no secret is configured. An unarmed verifier that
//        accepted everything would be strictly worse than having no endpoint at all. Refusals are
//        expected traffic on a public door, so one is logged at debug — but an unbroken RUN of them
//        is a misconfiguration (endpoint registered before the secret) and is raised to a warning.
//   400  a VERIFIED body we cannot parse, at any depth. jsoncpp reports a payload nested past its
//        stackLimit by throwing, and an exception out of a handler is a 5xx redelivered forever.
//   500  a stream's write threw. Every stream is still attempted first — one product's outage must
//        not leave another mailing a mailbox we know is gone — and the 500 then asks Svix to
//        redeliver the whole event. Every write is idempotent, so a redelivery re-applies what
//        already landed for free and retries only what is missing.
//   200  everything else it understood, including every no-op — an event type it does not
//        recognise, a soft bounce, an address no account owns. A 404 for the unknown address would
//        make this door an account-existence oracle for anyone who can reach it, and a 5xx for the
//        unrecognised type would have Resend redeliver it until its retry budget is gone.
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

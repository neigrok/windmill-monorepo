#pragma once

#include "platform/application/AuthService.h"
#include "platform/application/Entitlements.h"
#include "products/journal/application/EchoExplain.h"
#include "products/journal/application/EchoSweep.h"
#include "products/journal/ports/EchoRepository.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// The echo read surface, owner-scoped. The sweep derives for everyone and entitlement is asked
// here: this edge decides how much of a passage a reader is handed.
//
// Passages travel as text and days as ISO strings; the client re-locates the quote in the live page
// body. `occurrenceHint` says which occurrence of that text the passage is, for a page that says the
// same sentence twice — a hint, since the client still verifies by text.
class EchoApi {
public:
  EchoApi(std::shared_ptr<EchoRepository> echoes, std::shared_ptr<EchoSweep> sweep,
          std::shared_ptr<EchoExplainer> explainer, std::shared_ptr<AuthService> auth,
          std::shared_ptr<Entitlements> entitlements, std::string adminToken);

  void listEchoes(const drogon::HttpRequestPtr& req, HttpCallback&& cb);
  void dismiss(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
               const std::string& triggerDay, const std::string& matchDay);
  void dismissPage(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                   const std::string& triggerDay);
  void dismissOffer(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                    const std::string& triggerDay);
  void markUseful(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                  const std::string& triggerDay, const std::string& matchDay);
  void opened(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
              const std::string& triggerDay, const std::string& matchDay);
  void adminSweep(const drogon::HttpRequestPtr& req, HttpCallback&& cb);

  // What a derivation of one page would decide right now, rule by rule, writing nothing. Admin token
  // and a signed-in owner: it answers about the caller's own journal only. Every SelectionRules knob
  // is overridable per call.
  void explainPage(const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& day);

private:
  std::shared_ptr<EchoRepository> echoes_;
  std::shared_ptr<EchoSweep> sweep_;
  std::shared_ptr<EchoExplainer> explainer_;
  std::shared_ptr<AuthService> auth_;
  std::shared_ptr<Entitlements> entitlements_;
  std::string adminToken_;
};

}

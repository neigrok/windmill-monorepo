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

// The echo read surface, owner-scoped. Entitlement is asked HERE rather than in the sweep: the
// design canon's honest-cut state shows a non-subscriber that echoes exist, how many, how far back,
// and the real opening words of the nearest one — none of which can be served from an empty table.
// So the sweep derives for everyone and this edge decides how much of a passage a reader is handed.
// Reverting to "absent, not locked" is one branch in `listEchoes`, not a rebuild.
//
// Passages travel as TEXT and days as ISO strings. The client re-locates the quote in the live page
// body and renders the distance itself: no offset would survive the trip (C++ counts bytes,
// JavaScript slices UTF-16 code units) and "212 days" is not how anyone reads a year. What does
// travel is `occurrenceHint` — which occurrence of that text the passage is — because a page that
// says "i don't know." twice gives a text search no way to pick the right one. It is a hint: the
// client still verifies by text, and re-locating is still what decides whether the quote is shown.
//
// Three of these doors also write a quality signal — a walk back to the older page, a "useful", a
// dismissal — because dismissal alone cannot tell "wrong match" from "right match, bad night", and
// without the positive half the only thing this feature can ever learn about itself is one-sided.
// The answer travels back on the read as `useful`, for the same reason `offerRetired` does.
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

  // The tuning door: what a derivation of one page would decide right now, rule by rule, writing
  // nothing. Admin token AND a signed-in owner, because it answers about the CALLER's own journal
  // and hands back their passages in full — the admin secret buys access to the door, never to
  // somebody else's pages. Every SelectionRules knob is overridable per call, so the way to find a
  // better threshold is to ask for it against real nights rather than to deploy one and wait.
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

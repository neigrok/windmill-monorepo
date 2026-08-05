#pragma once

#include "platform/application/AuthService.h"
#include "platform/application/Entitlements.h"
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
class EchoApi {
public:
  EchoApi(std::shared_ptr<EchoRepository> echoes, std::shared_ptr<EchoSweep> sweep,
          std::shared_ptr<AuthService> auth, std::shared_ptr<Entitlements> entitlements,
          std::string adminToken);

  void listEchoes(const drogon::HttpRequestPtr& req, HttpCallback&& cb);
  void dismiss(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
               const std::string& triggerDay, const std::string& matchDay);
  void dismissPage(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                   const std::string& triggerDay);
  void dismissOffer(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                    const std::string& triggerDay);
  void opened(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
              const std::string& triggerDay, const std::string& matchDay);
  void adminSweep(const drogon::HttpRequestPtr& req, HttpCallback&& cb);

private:
  std::shared_ptr<EchoRepository> echoes_;
  std::shared_ptr<EchoSweep> sweep_;
  std::shared_ptr<AuthService> auth_;
  std::shared_ptr<Entitlements> entitlements_;
  std::string adminToken_;
};

}

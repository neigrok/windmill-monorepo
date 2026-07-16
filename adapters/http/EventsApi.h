#pragma once

#include "application/AuthService.h"
#include "ports/EventRepository.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// The funnel telemetry intake (event-spine): anonymous and signed-in beacons alike POST
// small event batches. Deliberately boundary-only — parse, drop what's malformed entry by
// entry, resolve the caller, append; a bad entry never rejects its siblings.
class EventsApi {
public:
  EventsApi(std::shared_ptr<EventRepository> events, std::shared_ptr<AuthService> auth);

  void ingest(const drogon::HttpRequestPtr& req, HttpCallback&& callback);  // POST /v1/events

private:
  std::shared_ptr<EventRepository> events_;
  std::shared_ptr<AuthService> auth_;
};

}

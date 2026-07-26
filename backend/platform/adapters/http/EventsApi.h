#pragma once

#include "platform/adapters/amplitude/AmplitudeClient.h"
#include "platform/application/AuthService.h"
#include "platform/ports/EventRepository.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// The funnel telemetry intake (event-spine): anonymous and signed-in beacons alike POST
// small event batches. Deliberately boundary-only — parse, drop what's malformed entry by
// entry, resolve the caller, append; a bad entry never rejects its siblings. Accepted events
// also forward to Amplitude (nullptr when unconfigured, so the forward is skipped).
class EventsApi {
public:
  EventsApi(std::shared_ptr<EventRepository> events, std::shared_ptr<AuthService> auth,
            std::shared_ptr<AmplitudeClient> amplitude = nullptr);

  void ingest(const drogon::HttpRequestPtr& req, HttpCallback&& callback);  // POST /v1/events

private:
  std::shared_ptr<EventRepository> events_;
  std::shared_ptr<AuthService> auth_;
  std::shared_ptr<AmplitudeClient> amplitude_;
};

}

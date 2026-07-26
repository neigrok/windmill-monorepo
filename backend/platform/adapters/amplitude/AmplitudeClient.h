#pragma once

#include "platform/domain/Ids.h"
#include "platform/ports/EventRepository.h"

#include <trantor/net/EventLoopThread.h>

#include <optional>
#include <string>
#include <vector>

namespace wm {

// Forwards each funnel event the beacon lands to Amplitude's HTTP V2 API, over a private event-loop
// thread so the /v1/events handler never blocks on the outbound call. The browser's session key is
// the device_id and the session-resolved user (nullopt for a ghost) is the user_id — so Amplitude
// ties events to real accounts, which a client-side SDK (anon-only) could not. An empty API key
// makes every forward a no-op; the send is async and fire-and-forget, its failure only logged.
//
// The host defaults to Amplitude's US ingestion (api2.amplitude.com); pass api.eu.amplitude.com for
// an EU-region project, since the wrong region silently drops events.
class AmplitudeClient {
public:
  explicit AmplitudeClient(std::string apiKey, std::string host = "api2.amplitude.com");

  void forward(const std::string& sessionKey, const std::optional<UserId>& user,
               const std::vector<FunnelEvent>& events);

private:
  std::string apiKey_;
  std::string host_;
  trantor::EventLoopThread loop_;
};

}

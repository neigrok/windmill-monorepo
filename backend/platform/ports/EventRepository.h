#pragma once

#include "platform/domain/Ids.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm {

// `props` is compact JSON text of the flat props object, stored verbatim as jsonb.
struct FunnelEvent {
  std::string name;
  std::int64_t clientMs = 0;
  std::string props = "{}";
  std::string id;
};

// A product event the server records itself, with no client present. It is told under the account it is attributed to
// alone, or, when it is no one's, under its device key, never both, so no server event ties a device to an account. Its
// event's `id` is its key, a digest that names no person: the store records each key once, however often it is told.
struct ServerEvent {
  std::string sessionKey;  // the device key; empty once the event is attributed to an account
  std::optional<UserId> user;
  FunnelEvent event;
};

// Append-only telemetry sink; nullopt user means a ghost session.
struct EventRepository {
  virtual ~EventRepository() = default;
  virtual void append(const std::string& sessionKey, const std::optional<UserId>& user,
                      const std::vector<FunnelEvent>& events) = 0;
  virtual int countInLastDay(const std::string& sessionKey) = 0;
};

// Where stored events go next, Amplitude in production: the intake forwards a client batch it stored, the subscription
// follower each event the server recorded. A forward does not throw: a delivery that fails is the forwarder's to report.
struct EventForwarder {
  virtual ~EventForwarder() = default;
  virtual void forward(const std::string& sessionKey, const std::optional<UserId>& user,
                       const std::vector<FunnelEvent>& events, const std::string& idSeed = "") = 0;
};

}

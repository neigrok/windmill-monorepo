#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "platform/ports/EventRepository.h"

#include <memory>
#include <optional>
#include <string>

namespace wm {

class PgEventRepository : public EventRepository {
public:
  explicit PgEventRepository(std::shared_ptr<PgPool> pool);

  void append(const std::string& sessionKey, const std::optional<UserId>& user,
              const std::vector<FunnelEvent>& events) override;
  int countInLastDay(const std::string& sessionKey) override;

  // The server's own event, written in `txn` once under its key, which outlives the row through retention and the
  // account's erasure. An account this backend holds takes the event without its device key; one it no longer holds
  // leaves the event no one's, under the device key. The event as stored, for the forwarder, or nothing when its key
  // was recorded before.
  std::optional<ServerEvent> recordOnce(pqxx::work& txn, const ServerEvent& event);

private:
  std::shared_ptr<PgPool> pool_;
};

}

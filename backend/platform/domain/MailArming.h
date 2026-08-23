#pragma once

#include "platform/domain/Ids.h"

#include <set>
#include <string>

namespace wm {

// The dark-launch gate every product mail stream stands behind. Consulted at SEND time and at each
// product's settings door, never at decide time, so a sweep's ledger keeps recording while nobody
// can receive anything. `enabled` is the feature's state, `allows` is one person's: off means
// nobody, on means only the named, and an empty allowlist is nobody. `.env.example` and
// deploy/docker-compose.yml state that in the same words.
struct MailArming {
  MailArming() = default;
  MailArming(bool enabled, const std::string& allowlistCsv);

  bool allows(const UserId& user) const;

  bool enabled = false;
  std::set<std::string> allowlist;
};

}

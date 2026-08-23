#pragma once

#include "platform/domain/Ids.h"

#include <set>
#include <string>

namespace wm {

// The gate every product mail stream stands behind. Consulted at SEND time, never at decide time.
// `enabled` is the feature's state, `allows` is one person's: off means nobody, on means only the
// named, and an empty allowlist is nobody.
struct MailArming {
  MailArming() = default;
  MailArming(bool enabled, const std::string& allowlistCsv);

  bool allows(const UserId& user) const;

  bool enabled = false;
  std::set<std::string> allowlist;
};

}

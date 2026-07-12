#pragma once

#include "domain/Auth.h"

#include <string>

namespace wm {

// The one transactional email Windmill sends. Implementations render the provider's
// 'magic-link' template with `magic_link` bound to the sign-in URL. Throws on a delivery
// failure so the caller can surface the doc's only brick — "can't reach windmill.works".
struct EmailSender {
  virtual ~EmailSender() = default;
  virtual void sendMagicLink(const Email& to, const std::string& magicLinkUrl) = 0;
};

}

#pragma once

#include "domain/Auth.h"

#include <string>

namespace wm {

// The transactional email Windmill sends — one method per mail it can say. sendMagicLink
// renders the provider's 'magic-link' template with `magic_link` bound to the sign-in URL;
// sendForkLink renders 'magic-link-fork', which also names the tree the link will plant
// (`tree_title`) and its meta line (`tree_meta`, e.g. "12 steps"). Both throw on a delivery
// failure so the caller can surface the doc's only brick — "can't reach windmill.works".
struct EmailSender {
  virtual ~EmailSender() = default;
  virtual void sendMagicLink(const Email& to, const std::string& magicLinkUrl) = 0;
  virtual void sendForkLink(const Email& to, const std::string& magicLinkUrl,
                            const std::string& treeTitle, const std::string& treeMeta) = 0;
};

}

#pragma once

#include "domain/Auth.h"

#include <functional>
#include <string>

namespace wm {

// The transactional email Windmill sends — one method per mail it can say. sendMagicLink
// renders the provider's 'magic-link' template with `magic_link` bound to the sign-in URL;
// sendForkLink renders 'magic-link-fork', which also names the tree the link will plant
// (`tree_title`) and its meta line (`tree_meta`, e.g. "12 steps"). Both are asynchronous so
// the slow provider call never parks a request loop: done fires exactly once with the
// delivery outcome — true on a 2xx, false on any failure or timeout (the edge turns that
// into the doc's only brick, "can't reach windmill.works") — and may fire on the sender's
// own loop thread rather than the caller's, exactly like PlanComposer.
struct EmailSender {
  virtual ~EmailSender() = default;
  virtual void sendMagicLink(const Email& to, const std::string& magicLinkUrl,
                             std::function<void(bool)> done) = 0;
  virtual void sendForkLink(const Email& to, const std::string& magicLinkUrl,
                            const std::string& treeTitle, const std::string& treeMeta,
                            std::function<void(bool)> done) = 0;
};

}

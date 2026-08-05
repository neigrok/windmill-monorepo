#pragma once

#include "platform/domain/Auth.h"

#include <functional>
#include <string>

namespace wm {

// The transactional email the PLATFORM sends — the two mails that belong to no product: the
// account's own sign-in. sendMagicLink is the plain sign-in link; sendForkLink is the same link
// when it also plants a copy of something, and prints that source's title and meta line beside
// it. Both strings arrive already rendered from the forking product (platform/ports/SignupFork.h)
// and are printed verbatim — this seam counts nothing and names nothing it prints. Both sends are
// asynchronous so the slow provider call never parks a request loop: done fires exactly once with
// the delivery outcome — true on a 2xx, false on any failure or timeout (the edge turns that into
// the doc's only brick, "can't reach windmill.works") — and may fire on the sender's own loop
// thread rather than the caller's, exactly like PlanComposer.
//
// Mail a product owns and words lives behind that product's own mail port, next to the product,
// so this platform seam names no product concept and the platform never depends on one.
struct EmailSender {
  virtual ~EmailSender() = default;
  virtual void sendMagicLink(const Email& to, const std::string& magicLinkUrl,
                             std::function<void(bool)> done) = 0;
  virtual void sendForkLink(const Email& to, const std::string& magicLinkUrl,
                            const std::string& sourceTitle, const std::string& sourceMeta,
                            std::function<void(bool)> done) = 0;
};

}

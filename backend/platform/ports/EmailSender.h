#pragma once

#include "platform/domain/Auth.h"

#include <functional>
#include <string>

namespace wm {

// The sign-in mail the platform sends; product mail lives behind that product's own port.
// sendForkLink prints sourceTitle/sourceMeta verbatim — they arrive already rendered. Every send is
// asynchronous: `done` fires exactly once, true on a 2xx and false on any failure or timeout, and
// may fire on the sender's own loop thread rather than the caller's.
struct EmailSender {
  virtual ~EmailSender() = default;
  virtual void sendMagicLink(const Email& to, const std::string& magicLinkUrl,
                             std::function<void(bool)> done) = 0;
  virtual void sendForkLink(const Email& to, const std::string& magicLinkUrl,
                            const std::string& sourceTitle, const std::string& sourceMeta,
                            std::function<void(bool)> done) = 0;
  virtual void sendSignInCode(const Email& to, const std::string& signInCode,
                              std::function<void(bool)> done) = 0;
};

}

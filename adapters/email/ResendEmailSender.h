#pragma once

#include "ports/EmailSender.h"

#include <trantor/net/EventLoopThread.h>

#include <string>

namespace wm {

// Sends the magic-link email through Resend's HTTP API, rendering the 'magic-link' template
// with `magic_link` = the sign-in URL. Owns a private event-loop thread so the outbound
// HTTPS call runs off — and never deadlocks — the server's request loops.
class ResendEmailSender : public EmailSender {
public:
  ResendEmailSender(std::string apiKey, std::string from);

  void sendMagicLink(const Email& to, const std::string& magicLinkUrl) override;

private:
  std::string apiKey_;
  std::string from_;
  trantor::EventLoopThread loop_;
};

}

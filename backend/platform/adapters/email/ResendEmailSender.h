#pragma once

#include "platform/adapters/email/ResendClient.h"
#include "platform/ports/EmailSender.h"

#include <functional>
#include <string>

namespace wm {

// The platform's sign-in mail over Resend: the 'magic-link' template for a plain sign-in,
// 'magic-link-fork' when the link also plants a copy of something, 'magic-code' when the app door
// asked to type a code instead.
class ResendEmailSender : public EmailSender {
public:
  explicit ResendEmailSender(ResendClient& client);

  void sendMagicLink(const Email& to, const std::string& magicLinkUrl,
                     std::function<void(bool)> done) override;
  void sendForkLink(const Email& to, const std::string& magicLinkUrl,
                    const std::string& sourceTitle, const std::string& sourceMeta,
                    std::function<void(bool)> done) override;
  void sendSignInCode(const Email& to, const std::string& signInCode,
                      std::function<void(bool)> done) override;

private:
  ResendClient& client_;
};

}

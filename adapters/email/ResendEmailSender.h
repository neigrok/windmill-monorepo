#pragma once

#include "ports/EmailSender.h"

#include <json/json.h>
#include <trantor/net/EventLoopThread.h>

#include <string>

namespace wm {

// Resend substitutes template variables raw ({{{ }}} — no escaping tier), so any
// user-authored text must shed markup before it becomes a variable. Stripping angle
// brackets is sufficient ONLY while the templates keep such variables in text-content
// positions — never attributes, never URLs (pinned in emails/magic-link-fork.html).
std::string emailSafeTitle(const std::string& title);

// Sends Windmill's mail through Resend's HTTP API: the 'magic-link' template for a plain
// sign-in, 'magic-link-fork' when the link also plants a copy of a tree. Owns a private
// event-loop thread so the outbound HTTPS call runs off — and never deadlocks — the
// server's request loops.
class ResendEmailSender : public EmailSender {
public:
  ResendEmailSender(std::string apiKey, std::string from);

  void sendMagicLink(const Email& to, const std::string& magicLinkUrl) override;
  void sendForkLink(const Email& to, const std::string& magicLinkUrl,
                    const std::string& treeTitle, const std::string& treeMeta) override;

private:
  void send(const Email& to, const std::string& templateId, const Json::Value& variables);

  std::string apiKey_;
  std::string from_;
  trantor::EventLoopThread loop_;
};

}

#pragma once

#include "platform/domain/Auth.h"

#include <json/json.h>
#include <trantor/net/EventLoopThread.h>

#include <functional>
#include <string>

namespace wm {

// Resend substitutes template variables raw ({{{ }}} — no escaping tier), so any user-authored
// text must shed markup before it becomes a variable. Stripping angle brackets is sufficient ONLY
// while the templates keep such variables in text-content positions — never attributes, never URLs
// (pinned in emails/magic-link-fork.html).
std::string emailSafeTitle(const std::string& title);

// The exact JSON Resend's /emails receives. `headers` is Resend's flat message-header object; an
// empty one leaves the field off entirely, because a transactional mail carries no unsubscribe.
Json::Value resendEmailBody(const std::string& from, const std::string& to,
                            const std::string& templateId, const Json::Value& variables,
                            const Json::Value& headers);

// The reminder's List-Unsubscribe pair as Resend headers — RFC 8058 one-click: the URL in angle
// brackets (RFC 2369) and the marker that makes a mail client POST rather than GET.
Json::Value reminderUnsubscribeHeaders(const std::string& unsubscribeUrl);

// The neutral Resend transport: POST a rendered template (a template id, its variables, and its
// message headers) to Resend's HTTP API. Owns a private event-loop thread carrying the outbound
// HTTPS call, so request loops are never parked; `done` fires from that loop — true on a 2xx, false
// on any failure or timeout.
class ResendClient {
public:
  ResendClient(std::string apiKey, std::string from);

  void send(const Email& to, const std::string& templateId, const Json::Value& variables,
            const Json::Value& headers, std::function<void(bool)> done);

private:
  std::string apiKey_;
  std::string from_;
  trantor::EventLoopThread loop_;
};

}

#pragma once

#include "platform/domain/Auth.h"

#include <json/json.h>
#include <trantor/net/EventLoopThread.h>

#include <functional>
#include <string>

namespace wm {

// Resend substitutes template variables raw ({{{ }}} — no escaping tier), so any
// user-authored text must shed markup before it becomes a variable. Stripping angle
// brackets is sufficient ONLY while the templates keep such variables in text-content
// positions — never attributes, never URLs (pinned in emails/magic-link-fork.html).
std::string emailSafeTitle(const std::string& title);

// The exact JSON Resend's /emails receives — pulled out so a test can read the bytes we send
// without a live provider. `headers` is Resend's flat message-header object (e.g. the reminder's
// List-Unsubscribe pair); an empty one leaves the field off entirely, because a transactional
// mail carries no unsubscribe.
Json::Value resendEmailBody(const std::string& from, const std::string& to,
                            const std::string& templateId, const Json::Value& variables,
                            const Json::Value& headers);

// The reminder's List-Unsubscribe pair as Resend headers — RFC 8058 one-click: the URL in angle
// brackets (RFC 2369) and the marker that makes a mail client POST rather than GET. Pulled out so
// the exact header shape gets the test the live provider send never could.
Json::Value reminderUnsubscribeHeaders(const std::string& unsubscribeUrl);

// The neutral Resend transport, shared by every mail Windmill sends and owned by none of them.
// It knows only how to POST a rendered template — a template id, its variables, and its message
// headers — to Resend's HTTP API; WHICH mail a template is (a sign-in link, a reminder, a nudge)
// is the caller's business, so this class names no product concept. Owns a private event-loop
// thread that carries the outbound HTTPS call, so the server's request loops are never parked
// waiting on Resend; done fires from that loop with the send outcome — true on a 2xx, false on
// any failure or timeout.
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

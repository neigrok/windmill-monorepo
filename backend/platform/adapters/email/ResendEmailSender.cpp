#include "platform/adapters/email/ResendEmailSender.h"

#include <utility>

namespace wm {

ResendEmailSender::ResendEmailSender(ResendClient& client) : client_(client) {}

void ResendEmailSender::sendMagicLink(const Email& to, const std::string& magicLinkUrl,
                                      std::function<void(bool)> done) {
  Json::Value variables(Json::objectValue);
  variables["magic_link"] = magicLinkUrl;
  client_.send(to, "magic-link", variables, Json::Value(Json::objectValue), std::move(done));
}

void ResendEmailSender::sendForkLink(const Email& to, const std::string& magicLinkUrl,
                                     const std::string& sourceTitle, const std::string& sourceMeta,
                                     std::function<void(bool)> done) {
  // `tree_title` / `tree_meta` are the slot names inside Resend's stored 'magic-link-fork'
  // template, which only roadmap forks today — a vendor-side contract we bind to, not a fact this
  // adapter knows about the two strings it is handed.
  Json::Value variables(Json::objectValue);
  variables["magic_link"] = magicLinkUrl;
  variables["tree_title"] = emailSafeTitle(sourceTitle);
  variables["tree_meta"] = sourceMeta;
  client_.send(to, "magic-link-fork", variables, Json::Value(Json::objectValue), std::move(done));
}

void ResendEmailSender::sendSignInCode(const Email& to, const std::string& signInCode,
                                       std::function<void(bool)> done) {
  // `sign_in_code` is the slot inside Resend's stored 'magic-code' template (paste-source:
  // web/emails/magic-code.html) — server-minted digits, never user text, so raw substitution
  // holds. The subject lives on the template, deliberately omitted here like the others.
  Json::Value variables(Json::objectValue);
  variables["sign_in_code"] = signInCode;
  client_.send(to, "magic-code", variables, Json::Value(Json::objectValue), std::move(done));
}

}

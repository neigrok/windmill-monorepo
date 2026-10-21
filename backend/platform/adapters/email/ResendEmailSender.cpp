#include "platform/adapters/email/ResendEmailSender.h"

#include <utility>

namespace wm {

ResendEmailSender::ResendEmailSender(ResendClient& client) : client_(client) {}

void ResendEmailSender::sendAiAllowanceAlert(const Email& to, const AiBudgetAlert& alert,
                                             std::function<void(bool)> done) {
  const std::string scope{aiBudgetScopeName(alert.scope)};
  const std::string source = alert.fundingSource ? std::string(aiBudgetFundingSourceName(*alert.fundingSource)) : "free";
  const std::string subject = "Windmill AI allowance: " + std::to_string(alert.thresholdPercent) + "%";
  const std::string text = "Budget: " + scope + "\nFunding: " + source +
      "\nThreshold: " + std::to_string(alert.thresholdPercent) + "%\nLimit USD: " + formatAiUsd(alert.limitNanos) +
      "\nSpent USD: " + formatAiUsd(alert.spentNanos) + "\nReserved USD: " + formatAiUsd(alert.heldNanos) + "\n";
  client_.sendText(to, subject, text, "ai-allowance/" + alert.id, std::move(done));
}

void ResendEmailSender::sendMagicLink(const Email& to, const std::string& magicLinkUrl,
                                      std::function<void(bool)> done) {
  Json::Value variables(Json::objectValue);
  variables["magic_link"] = magicLinkUrl;
  client_.send(to, "magic-link", variables, Json::Value(Json::objectValue), std::move(done));
}

void ResendEmailSender::sendForkLink(const Email& to, const std::string& magicLinkUrl,
                                     const std::string& sourceTitle, const std::string& sourceMeta,
                                     std::function<void(bool)> done) {
  // `tree_title` / `tree_meta` are the slot names inside Resend's stored 'magic-link-fork' template.
  Json::Value variables(Json::objectValue);
  variables["magic_link"] = magicLinkUrl;
  variables["tree_title"] = emailSafeTitle(sourceTitle);
  variables["tree_meta"] = sourceMeta;
  client_.send(to, "magic-link-fork", variables, Json::Value(Json::objectValue), std::move(done));
}

void ResendEmailSender::sendSignInCode(const Email& to, const std::string& signInCode,
                                       std::function<void(bool)> done) {
  // `sign_in_code` is the slot inside Resend's stored 'magic-code' template — server-minted digits,
  // never user text, so raw substitution holds. The subject lives on the template.
  Json::Value variables(Json::objectValue);
  variables["sign_in_code"] = signInCode;
  client_.send(to, "magic-code", variables, Json::Value(Json::objectValue), std::move(done));
}

}

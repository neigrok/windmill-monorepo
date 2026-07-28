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
                                     const std::string& treeTitle, const std::string& treeMeta,
                                     std::function<void(bool)> done) {
  Json::Value variables(Json::objectValue);
  variables["magic_link"] = magicLinkUrl;
  variables["tree_title"] = emailSafeTitle(treeTitle);
  variables["tree_meta"] = treeMeta;
  client_.send(to, "magic-link-fork", variables, Json::Value(Json::objectValue), std::move(done));
}

}

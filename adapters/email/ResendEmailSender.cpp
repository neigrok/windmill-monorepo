#include "adapters/email/ResendEmailSender.h"

#include <drogon/HttpClient.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <trantor/utils/Logger.h>

#include <utility>

namespace wm {

std::string emailSafeTitle(const std::string& title) {
  std::string safe;
  safe.reserve(title.size());
  for (unsigned char c : title) {
    if (c == '<' || c == '>') continue;  // markup, in a body
    // Control characters, in a HEADER. A tree title carries no length or charset validation
    // anywhere in the system and now reaches a Subject line, where a CR or an LF is not a stray
    // character but the end of the header. Multi-byte UTF-8 is all >= 0x80 and passes untouched.
    if (c < 0x20 || c == 0x7F) continue;
    safe.push_back(static_cast<char>(c));
  }
  return safe;
}

ResendEmailSender::ResendEmailSender(std::string apiKey, std::string from)
    : apiKey_(std::move(apiKey)), from_(std::move(from)) {
  loop_.run();
}

void ResendEmailSender::sendMagicLink(const Email& to, const std::string& magicLinkUrl,
                                      std::function<void(bool)> done) {
  Json::Value variables(Json::objectValue);
  variables["magic_link"] = magicLinkUrl;
  send(to, "magic-link", variables, std::move(done));
}

void ResendEmailSender::sendForkLink(const Email& to, const std::string& magicLinkUrl,
                                     const std::string& treeTitle, const std::string& treeMeta,
                                     std::function<void(bool)> done) {
  Json::Value variables(Json::objectValue);
  variables["magic_link"] = magicLinkUrl;
  variables["tree_title"] = emailSafeTitle(treeTitle);
  variables["tree_meta"] = treeMeta;
  send(to, "magic-link-fork", variables, std::move(done));
}

void ResendEmailSender::sendReminder(const Email& to, const ReminderMail& mail,
                                     std::function<void(bool)> done) {
  Json::Value variables(Json::objectValue);
  // The two positions that carry someone's own words shed markup first; the hue beside each step
  // never does, because it is one of six server-chosen literals landing inside a style attribute,
  // where angle-bracket stripping would not have protected it anyway.
  variables["tree_name"] = emailSafeTitle(mail.treeName);
  variables["tree_url"] = mail.treeUrl;
  variables["settings_url"] = mail.settingsUrl;
  variables["pause_url"] = mail.pauseUrl;
  variables["done"] = mail.done;
  variables["total"] = mail.total;
  // Every counted sentence arrives finished, worded in the pure core. This adapter binds; it does
  // not write copy — plurals and units included.
  variables["ready_phrase"] = mail.readyPhrase;
  variables["more_on_tree"] = mail.moreOnTree;
  variables["more_ready"] = mail.moreReady;
  // Three fixed slots rather than a list the provider iterates: the template documents this
  // fallback, three is the cap regardless, and an empty label simply renders an empty row.
  for (std::size_t slot = 0; slot < mail.steps.size(); ++slot) {
    const std::string prefix = "step_" + std::to_string(slot + 1) + "_";
    variables[prefix + "label"] = emailSafeTitle(mail.steps[slot].label);
    variables[prefix + "color"] = mail.steps[slot].colorHex;
  }
  send(to, "reminder", variables, std::move(done));
}

void ResendEmailSender::send(const Email& to, const std::string& templateId,
                             const Json::Value& variables, std::function<void(bool)> done) {
  if (apiKey_.empty()) {
    done(false);
    return;
  }

  Json::Value body;
  body["from"] = from_;
  body["to"] = to.value;
  body["template"]["id"] = templateId;
  body["template"]["variables"] = variables;

  Json::StreamWriterBuilder builder;
  builder["indentation"] = "";
  const std::string payload = Json::writeString(builder, body);

  auto client = drogon::HttpClient::newHttpClient("https://api.resend.com", loop_.getLoop());

  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Post);
  req->setPath("/emails");
  req->addHeader("authorization", "Bearer " + apiKey_);
  req->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  req->setBody(payload);

  // The async overload runs the whole call on the private loop and answers on it, so the
  // calling handler thread is freed the instant this returns. client rides in the callback
  // to outlive the send; done carries the 2xx verdict back to the edge.
  client->sendRequest(
      req,
      [client, done = std::move(done)](drogon::ReqResult result, const drogon::HttpResponsePtr& resp) {
        const int status = resp ? static_cast<int>(resp->getStatusCode()) : 0;
        if (result != drogon::ReqResult::Ok || status < 200 || status >= 300) {  // accept any 2xx
          const std::string detail = resp ? std::string(resp->getBody()) : std::string("no response");
          LOG_ERROR << "Resend send failed (status " << status << "): " << detail;
          done(false);
          return;
        }
        done(true);
      },
      10.0);
}

}

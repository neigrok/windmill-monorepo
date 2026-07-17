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
  for (char c : title)
    if (c != '<' && c != '>') safe.push_back(c);
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

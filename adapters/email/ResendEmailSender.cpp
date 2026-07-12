#include "adapters/email/ResendEmailSender.h"

#include <drogon/HttpClient.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>
#include <json/json.h>

#include <stdexcept>

namespace wm {

ResendEmailSender::ResendEmailSender(std::string apiKey, std::string from)
    : apiKey_(std::move(apiKey)), from_(std::move(from)) {
  loop_.run();
}

void ResendEmailSender::sendMagicLink(const Email& to, const std::string& magicLinkUrl) {
  if (apiKey_.empty()) throw std::runtime_error("RESEND_API_KEY not configured");

  Json::Value body;
  body["from"] = from_;
  body["to"] = to.value;
  body["template"]["id"] = "magic-link";
  body["template"]["variables"]["magic_link"] = magicLinkUrl;

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

  auto [result, resp] = client->sendRequest(req, 10.0);
  const int status = resp ? static_cast<int>(resp->getStatusCode()) : 0;
  if (result != drogon::ReqResult::Ok || status < 200 || status >= 300) {  // accept any 2xx
    const std::string detail = resp ? std::string(resp->getBody()) : std::string("no response");
    throw std::runtime_error("Resend send failed (status " + std::to_string(status) + "): " + detail);
  }
}

}

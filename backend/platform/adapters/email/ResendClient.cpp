#include "platform/adapters/email/ResendClient.h"

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

Json::Value resendEmailBody(const std::string& from, const std::string& to,
                            const std::string& templateId, const Json::Value& variables,
                            const Json::Value& headers) {
  Json::Value body(Json::objectValue);
  body["from"] = from;
  body["to"] = to;
  body["template"]["id"] = templateId;
  body["template"]["variables"] = variables;
  if (!headers.empty()) body["headers"] = headers;
  return body;
}

Json::Value reminderUnsubscribeHeaders(const std::string& unsubscribeUrl) {
  Json::Value headers(Json::objectValue);
  headers["List-Unsubscribe"] = "<" + unsubscribeUrl + ">";
  headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  return headers;
}

ResendClient::ResendClient(std::string apiKey, std::string from)
    : apiKey_(std::move(apiKey)), from_(std::move(from)) {
  loop_.run();
}

void ResendClient::send(const Email& to, const std::string& templateId,
                        const Json::Value& variables, const Json::Value& headers,
                        std::function<void(bool)> done) {
  if (apiKey_.empty()) {
    done(false);
    return;
  }

  const Json::Value body = resendEmailBody(from_, to.value, templateId, variables, headers);

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

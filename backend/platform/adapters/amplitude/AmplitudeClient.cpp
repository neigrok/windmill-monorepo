#include "platform/adapters/amplitude/AmplitudeClient.h"

#include <drogon/HttpClient.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <json/json.h>
#include <trantor/utils/Logger.h>

#include <memory>
#include <utility>

namespace wm {

namespace {
// The props were validated + stored as compact JSON text at the edge; parse them back into an
// object for event_properties. A parse failure just drops the properties, never the event.
Json::Value propsObject(const std::string& props) {
  Json::CharReaderBuilder builder;
  const std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  Json::Value parsed;
  std::string errors;
  if (reader->parse(props.data(), props.data() + props.size(), &parsed, &errors) && parsed.isObject())
    return parsed;
  return Json::Value(Json::objectValue);
}
}

AmplitudeClient::AmplitudeClient(std::string apiKey, std::string host)
    : apiKey_(std::move(apiKey)), host_(std::move(host)) {
  loop_.run();
}

void AmplitudeClient::forward(const std::string& sessionKey, const std::optional<UserId>& user,
                              const std::vector<FunnelEvent>& events) {
  if (apiKey_.empty() || events.empty()) return;

  Json::Value payload(Json::objectValue);
  payload["api_key"] = apiKey_;
  // The session key is the device_id; the beacon allows keys as short as one char, below Amplitude's
  // default 5-char floor, so lower it — else a short key would 400 the whole batch.
  payload["options"]["min_id_length"] = 1;
  Json::Value out(Json::arrayValue);
  int index = 0;
  for (const FunnelEvent& event : events) {
    Json::Value item(Json::objectValue);
    item["device_id"] = sessionKey;  // Amplitude needs a device_id OR user_id; the anon key is always present
    if (user) item["user_id"] = user->str();
    item["event_type"] = event.name;
    item["time"] = static_cast<Json::Int64>(event.clientMs);
    item["event_properties"] = propsObject(event.props);
    // A stable insert_id lets Amplitude drop a retried batch as a duplicate rather than double-count.
    // Name + batch index keep two events sharing a session and millisecond from colliding.
    item["insert_id"] = sessionKey + ":" + std::to_string(event.clientMs) + ":" + event.name + ":" + std::to_string(index++);
    out.append(std::move(item));
  }
  payload["events"] = std::move(out);

  Json::StreamWriterBuilder builder;
  builder["indentation"] = "";
  const std::string body = Json::writeString(builder, payload);

  auto client = drogon::HttpClient::newHttpClient("https://" + host_, loop_.getLoop());
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Post);
  req->setPath("/2/httpapi");
  req->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  req->setBody(body);

  client->sendRequest(
      req,
      [client](drogon::ReqResult result, const drogon::HttpResponsePtr& resp) {
        const int status = resp ? static_cast<int>(resp->getStatusCode()) : 0;
        if (result != drogon::ReqResult::Ok || status < 200 || status >= 300)
          LOG_ERROR << "Amplitude forward failed (status " << status << ")";
      },
      10.0);
}

}

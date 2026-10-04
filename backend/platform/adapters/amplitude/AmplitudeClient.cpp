#include "platform/adapters/amplitude/AmplitudeClient.h"

#include "platform/adapters/http/VendorCall.h"
#include "platform/application/WriteObservation.h"
#include <stdexcept>

#include <drogon/HttpClient.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <json/json.h>

#include <algorithm>
#include <charconv>
#include <memory>
#include <utility>

namespace wm {

namespace {
// The props were validated + stored as compact JSON text at the edge; parse them back into an
// object for event_properties. A parse failure drops the properties, never the event.
Json::Value propsObject(const std::string& props) {
  Json::CharReaderBuilder builder;
  const std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  Json::Value parsed;
  std::string errors;
  if (reader->parse(props.data(), props.data() + props.size(), &parsed, &errors) && parsed.isObject())
    return parsed;
  return Json::Value(Json::objectValue);
}

void sendBatch(const drogon::HttpClientPtr& client, const drogon::HttpRequestPtr& request,
                const std::shared_ptr<FailureReporter>& failures, int attemptsLeft,
                const std::shared_ptr<WriteObservation>& observation) {
  VendorCall call("amplitude", "forward");
  client->sendRequest(request,
      [client, request, failures, attemptsLeft, call, observation](drogon::ReqResult result,
                                                    const drogon::HttpResponsePtr& response) mutable {
        WriteContext context(*observation);
        if (call.succeeded(result, response)) { observation->finish(); return; }
        const int status = response ? static_cast<int>(response->getStatusCode()) : 0;
        const bool transient = result != drogon::ReqResult::Ok || !response ||
                               status == 429 || status >= 500;
        if (transient && attemptsLeft > 1) {
          double delay = 4 - attemptsLeft;
          if (response) {
            const std::string& header = response->getHeader("retry-after");
            int seconds = 0;
            const auto parsed = std::from_chars(header.data(), header.data() + header.size(), seconds);
            if (parsed.ec == std::errc{} && parsed.ptr == header.data() + header.size() && seconds >= 0)
              delay = std::min(seconds, 30);
          }
          client->getLoop()->runAfter(delay, [client, request, failures, attemptsLeft, observation] {
            sendBatch(client, request, failures, attemptsLeft - 1, observation);
          });
          return;
        }
        if (status >= 400 && status < 500) {
          observation->finish(status == 429 ? "rate_limited" : "http_" + std::to_string(status));
          return;
        }
        observation->fail(std::runtime_error("Amplitude delivery failed"));
      }, 10.0);
}
}

AmplitudeClient::AmplitudeClient(std::string apiKey, std::string host,
                                  std::shared_ptr<FailureReporter> failures)
    : apiKey_(std::move(apiKey)), host_(std::move(host)), failures_(std::move(failures)) {
  loop_.run();
}

Json::Value amplitudeEvents(const std::string& sessionKey, const std::optional<UserId>& user,
                            const std::vector<FunnelEvent>& events, const std::string& idSeed) {
  Json::Value out(Json::arrayValue);
  int index = 0;
  for (const FunnelEvent& event : events) {
    Json::Value item(Json::objectValue);
    item["device_id"] = sessionKey;  // Amplitude needs a device_id OR user_id; the anon key is always present
    if (user) item["user_id"] = user->str();
    item["event_type"] = event.name;
    item["time"] = static_cast<Json::Int64>(event.clientMs);
    item["event_properties"] = propsObject(event.props);
    const Json::Value platform = item["event_properties"].get("platform", Json::Value());
    if (platform == "android") item["platform"] = "Android";
    if (platform == "ios") item["platform"] = "iOS";
    if (platform == "web") item["platform"] = "Web";
    // A stable insert_id lets Amplitude drop a retried batch as a duplicate. Name + batch index keep
    // two events sharing a session and a millisecond from colliding.
    item["insert_id"] = sessionKey + ":" + idSeed + ":" + std::to_string(event.clientMs) + ":" +
                        event.name + ":" + std::to_string(index++);
    if (!event.id.empty()) item["insert_id"] = sessionKey + ":" + event.id;
    out.append(std::move(item));
  }
  return out;
}

void AmplitudeClient::forward(const std::string& sessionKey, const std::optional<UserId>& user,
                              const std::vector<FunnelEvent>& events, const std::string& idSeed) {
  if (apiKey_.empty() || events.empty()) return;

  Json::Value payload(Json::objectValue);
  payload["api_key"] = apiKey_;
  payload["options"]["min_id_length"] = 1;
  payload["events"] = amplitudeEvents(sessionKey, user, events, idSeed);

  Json::StreamWriterBuilder builder;
  builder["indentation"] = "";
  const std::string body = Json::writeString(builder, payload);

  auto client = drogon::HttpClient::newHttpClient("https://" + host_, loop_.getLoop());
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Post);
  req->setPath("/2/httpapi");
  req->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  req->setBody(body);

  auto observation = std::make_shared<WriteObservation>("amplitude.forward", "platform", "background", "", failures_.get());
  sendBatch(client, req, failures_, 3, observation);
}

}

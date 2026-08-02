#include "products/journal/adapters/llm/OpenAiTranscriber.h"

#include "platform/adapters/http/VendorCall.h"

#include <drogon/HttpClient.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>
#include <json/json.h>
#include <trantor/utils/Logger.h>

#include <utility>

namespace wm {

// The file extension OpenAI infers the container/codec from: the mime's subtype, stripped of any
// parameters ("audio/webm;codecs=opus" -> "webm"). A sane default keeps a missing header from failing
// the upload rather than guessing wrong.
std::string transcriptionExtension(const std::string& mimeType) {
  const std::size_t slash = mimeType.find('/');
  if (slash == std::string::npos) return "webm";
  const std::size_t end = mimeType.find_first_of(";, ", slash + 1);
  const std::string subtype = mimeType.substr(slash + 1, end == std::string::npos ? std::string::npos : end - slash - 1);
  return subtype.empty() ? "webm" : subtype;
}

OpenAiTranscriber::OpenAiTranscriber(std::string apiKey, std::string model)
    : apiKey_(std::move(apiKey)), model_(std::move(model)) {
  loop_.run();
}

bool OpenAiTranscriber::configured() const {
  return !apiKey_.empty();
}

Transcript OpenAiTranscriber::transcribe(const std::string& audio, const std::string& mimeType) {
  const std::string boundary = "----WindmillTalkBoundaryVoZ8kQ1pXsW7"; // fixed, unusual — never appears in opus/mp4 bytes
  const std::string filename = "audio." + transcriptionExtension(mimeType);
  const std::string audioType = mimeType.empty() ? "application/octet-stream" : mimeType;

  std::string form;
  form += "--" + boundary + "\r\n";
  form += "Content-Disposition: form-data; name=\"model\"\r\n\r\n" + model_ + "\r\n";
  form += "--" + boundary + "\r\n";
  form += "Content-Disposition: form-data; name=\"response_format\"\r\n\r\njson\r\n";
  form += "--" + boundary + "\r\n";
  form += "Content-Disposition: form-data; name=\"file\"; filename=\"" + filename + "\"\r\n";
  form += "Content-Type: " + audioType + "\r\n\r\n";
  form += audio;
  form += "\r\n--" + boundary + "--\r\n";

  auto client = drogon::HttpClient::newHttpClient("https://api.openai.com", loop_.getLoop());
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Post);
  req->setPath("/v1/audio/transcriptions");
  req->addHeader("Authorization", "Bearer " + apiKey_);
  req->setContentTypeString("multipart/form-data; boundary=" + boundary);
  req->setBody(std::move(form));

  // The one blocking vendor call in the backend, and the one carrying a person's voice: the call
  // reports its vendor, operation, status and cost, and never a byte of the audio or the transcript.
  VendorCall call("openai", "transcribe");
  const std::pair<drogon::ReqResult, drogon::HttpResponsePtr> outcome = client->sendRequest(req, 60.0);
  const drogon::HttpResponsePtr& resp = outcome.second;
  if (!call.succeeded(outcome.first, resp)) return {};

  Json::Value parsed;
  Json::Reader reader;
  if (!reader.parse(std::string(resp->getBody()), parsed) || !parsed.isMember("text")) {
    LOG_ERROR << "OpenAI transcribe: unreadable response";
    return {};
  }
  return Transcript{parsed["text"].asString()};
}

}

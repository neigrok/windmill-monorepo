#include "products/journal/adapters/llm/OpenAiTranscriber.h"

#include "platform/adapters/http/VendorCall.h"
#include "platform/adapters/llm/AnthropicClient.h"

#include <drogon/HttpClient.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>
#include <json/json.h>
#include <trantor/utils/Logger.h>

#include <memory>
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

OpenAiTranscriber::OpenAiTranscriber(std::string apiKey, std::string model,
                                     std::shared_ptr<AiFuse> fuse, std::shared_ptr<UsageSink> usage)
    : apiKey_(std::move(apiKey)), model_(std::move(model)), fuse_(std::move(fuse)),
      usage_(std::move(usage)) {
  loop_.run();
}

bool OpenAiTranscriber::configured() const {
  return !apiKey_.empty();
}

void OpenAiTranscriber::transcribe(const UserId& user, const std::string& audio,
                                   const std::string& mimeType,
                                   std::function<void(std::optional<Transcript>)> done) {
  // The process-wide hourly ceiling, asked before a byte is sent. A per-account budget is blind to
  // the machine's own runaway — a retry storm, a loop, a fan-out deploy — which is the shape that
  // empties an account overnight.
  if (fuse_ && !fuse_->allows(nowMs())) {
    LOG_ERROR << "openai transcribe refused: hourly AI fuse";
    done(std::nullopt);
    return;
  }

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

  // The one vendor call carrying a person's voice: it reports its vendor, operation, status and
  // cost, and never a byte of the audio or the transcript.
  auto call = std::make_shared<VendorCall>("openai", "transcribe");
  const std::string runId = newRunId("voice");
  // `client` rides into the callback because nothing else owns it once this function returns — and
  // this function returns immediately, which is the entire point of the change.
  client->sendRequest(
      req,
      [this, client, call, runId, user, done = std::move(done)](
          drogon::ReqResult result, const drogon::HttpResponsePtr& resp) {
        AiSpend spend;
        spend.user = user;
        spend.product = "journal";
        spend.operation = "transcribe";
        spend.model = model_;
        spend.runId = runId;

        if (!call->succeeded(result, resp)) {
          spend.outcome = resp && resp->getStatusCode() == drogon::k429TooManyRequests
                              ? AiOutcome::rateLimited
                              : AiOutcome::transport;
          meterSpend(spend, fuse_, usage_);
          done(std::nullopt);
          return;
        }

        Json::Value parsed;
        Json::Reader reader;
        if (!reader.parse(std::string(resp->getBody()), parsed) || !parsed.isMember("text")) {
          LOG_ERROR << "OpenAI transcribe: unreadable response";
          spend.outcome = AiOutcome::schemaInvalid;
          meterSpend(spend, fuse_, usage_);
          done(std::nullopt);
          return;
        }

        // What the reply says it cost, never an estimate of ours. A transcription reply that
        // carries no `usage` object counts as zero tokens and still lands a row: "we could not
        // price this call" and "this call never happened" are different facts, and the ledger is
        // the only place that can tell them apart later.
        spend.tokens = tokensFrom(parsed["usage"]);
        if (!parsed.isMember("usage")) LOG_ERROR << "OpenAI transcribe: reply carried no usage";
        spend.outcome = AiOutcome::ok;
        meterSpend(spend, fuse_, usage_);
        done(Transcript{parsed["text"].asString()});
      },
      60.0);
}

}

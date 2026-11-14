#include "products/journal/adapters/llm/OpenAiTranscriber.h"

#include "platform/adapters/http/VendorCall.h"
#include "platform/adapters/json/JsonText.h"
#include "platform/adapters/llm/AiCallBudget.h"
#include "platform/adapters/llm/AnthropicClient.h"

#include <drogon/HttpClient.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>
#include <trantor/utils/Logger.h>

#include <array>
#include <memory>
#include <utility>

namespace wm {

namespace {

// What one request may hold, from each model's page at developers.openai.com/api/docs/models.
struct TranscriptionLimits {
  const char* model;
  long long contextTokens;
  long long outputTokens;
};

constexpr std::array<TranscriptionLimits, 1> kTranscriptionLimits{{
    {"gpt-4o-transcribe", 16'000, 2'000},
}};

// How a take ends for the ledger. An answer that is not a success consumed nothing, and neither did a request that
// never reached a connection or a TLS session: both settle at zero. A success settles at what it billed. Anything
// else — a timeout, a connection dropped mid-exchange — may have been heard and billed, so its hold stays.
AiCallEnd takeEnd(drogon::ReqResult result, const drogon::HttpResponsePtr& response) {
  if (result == drogon::ReqResult::Ok && response)
    return response->statusCode() / 100 == 2 ? AiCallEnd::settled : AiCallEnd::unconsumed;
  const bool neverSent = result == drogon::ReqResult::BadServerAddress ||
                         result == drogon::ReqResult::HandshakeError || result == drogon::ReqResult::InvalidCertificate;
  return neverSent ? AiCallEnd::unconsumed : AiCallEnd::uncertain;
}

}

// The file extension OpenAI infers the container/codec from: the mime's subtype, stripped of any
// parameters ("audio/webm;codecs=opus" -> "webm").
std::string transcriptionExtension(const std::string& mimeType) {
  const std::size_t slash = mimeType.find('/');
  if (slash == std::string::npos) return "webm";
  const std::size_t end = mimeType.find_first_of(";, ", slash + 1);
  const std::string subtype = mimeType.substr(slash + 1, end == std::string::npos ? std::string::npos : end - slash - 1);
  return subtype.empty() ? "webm" : subtype;
}

std::optional<long long> transcriptionCeilingNanos(const std::string& model) {
  for (const TranscriptionLimits& limits : kTranscriptionLimits)
    if (model == limits.model) return costNanos(model, TokenUse{limits.contextTokens, limits.outputTokens, 0, 0});
  return std::nullopt;
}

std::optional<long long> transcriptionActualNanos(const std::string& model, const Json::Value& usage) {
  if (!usage.isObject() || usage["type"] != "tokens") return std::nullopt;
  for (const char* field : {"input_tokens", "output_tokens"})
    if (!usage[field].isInt64() || usage[field].asInt64() < 0 || usage[field].asInt64() > 1'000'000)
      return std::nullopt;
  return costNanos(model, TokenUse{usage["input_tokens"].asInt64(), usage["output_tokens"].asInt64(), 0, 0});
}

OpenAiTranscriber::OpenAiTranscriber(std::string apiKey, std::string model, std::shared_ptr<AiFuse> fuse,
                                     std::shared_ptr<UsageSink> usage, std::shared_ptr<AiCallBudget> budget,
                                     std::string baseUrl)
    : apiKey_(std::move(apiKey)), model_(std::move(model)), fuse_(std::move(fuse)), usage_(std::move(usage)),
      budget_(std::move(budget)), baseUrl_(std::move(baseUrl)) {
  loop_.run();
}

bool OpenAiTranscriber::configured() const {
  return !apiKey_.empty() && (!budget_ || transcriptionCeilingNanos(model_).has_value());
}

void OpenAiTranscriber::transcribe(const UserId& user, const std::string& audio, const std::string& mimeType,
                                   std::function<void(Transcription)> done) {
  // The process-wide hourly ceiling, asked before a byte is sent.
  if (fuse_ && !fuse_->allows(nowMs())) {
    LOG_ERROR << "openai transcribe refused: hourly AI fuse";
    done(Transcription::failed());
    return;
  }

  AiSpend spend;
  spend.user = user;
  spend.product = "journal";
  spend.operation = "transcribe";
  spend.model = model_;
  spend.runId = newRunId("voice");

  // The take holds the most it can cost before the audio leaves; an allowance that cannot hold it keeps the audio here.
  std::optional<AiBudgetReservation> reservation;
  if (budget_) {
    const AiCallAdmission admission = budget_->begin(spend, transcriptionCeilingNanos(model_));
    if (!admission.reservation) {
      done(Transcription::refused(admission.refusal));
      return;
    }
    reservation = admission.reservation;
  }

  const std::string boundary = "----WindmillTalkBoundaryVoZ8kQ1pXsW7"; // never appears in opus/mp4 bytes
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

  auto client = drogon::HttpClient::newHttpClient(baseUrl_, loop_.getLoop());
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Post);
  req->setPath("/v1/audio/transcriptions");
  req->addHeader("Authorization", "Bearer " + apiKey_);
  req->setContentTypeString("multipart/form-data; boundary=" + boundary);
  req->setBody(std::move(form));

  // Reports vendor, operation, status and cost, never a byte of the audio or the transcript.
  auto call = std::make_shared<VendorCall>("openai", "transcribe");
  // `client` rides into the callback because nothing else owns it once this function returns.
  client->sendRequest(
      req,
      [this, client, call, spend, reservation, done = std::move(done)](
          drogon::ReqResult result, const drogon::HttpResponsePtr& response) mutable {
        const bool succeeded = call->succeeded(result, response);
        const std::optional<Json::Value> reply = succeeded ? parseWhole(std::string(response->getBody())) : std::nullopt;
        const bool readable = reply && reply->isObject();
        const Json::Value usage = readable ? (*reply)["usage"] : Json::Value();
        const Json::Value text = readable ? (*reply)["text"] : Json::Value();
        const std::optional<long long> billed = transcriptionActualNanos(model_, usage);

        // Settled before the answer is written, so the slot this take held is open to the next one.
        if (reservation) budget_->finish(*reservation, billed, takeEnd(result, response));

        // What the reply says it cost, never an estimate. A failed call lands a row too.
        spend.tokens = tokensFrom(usage);
        spend.outcome = !succeeded ? (response && response->getStatusCode() == drogon::k429TooManyRequests
                                          ? AiOutcome::rateLimited
                                          : AiOutcome::transport)
                        : !text.isString() ? AiOutcome::schemaInvalid
                                           : AiOutcome::ok;
        meterSpend(spend, fuse_, usage_);

        if (succeeded && !text.isString()) LOG_ERROR << "OpenAI transcribe: unreadable reply";
        else if (succeeded && !billed) LOG_ERROR << "OpenAI transcribe: reply carried no token usage";
        done(text.isString() ? Transcription::words(text.asString()) : Transcription::failed());
      },
      60.0);
}

}

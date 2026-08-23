#include "products/roadmap/adapters/http/ComposeApi.h"

#include <drogon/HttpAppFramework.h>

#include <cstddef>
#include <memory>
#include <mutex>
#include <utility>

namespace wm {

namespace {
// The spend ceiling is the rate limiter's job, not a stingy input cap.
constexpr std::size_t kMaxTextBytes = 24576;
constexpr double kHeartbeatSeconds = 15.0;

drogon::HttpResponsePtr coded(drogon::HttpStatusCode status, const std::string& code) {
  Json::Value body(Json::objectValue);
  body["code"] = code;
  auto response = drogon::HttpResponse::newHttpJsonResponse(body);
  response->setStatusCode(status);
  return response;
}

bool isBlank(const std::string& text) {
  return text.find_first_not_of(" \t\r\n") == std::string::npos;
}

std::string sseEvent(const char* name, const std::string& data) {
  return std::string("event: ") + name + "\ndata: " + data + "\n\n";
}

// One live SSE reply. Every write goes through the mutex, so the composer's loop and the
// heartbeat timer never interleave a frame. drogon offers no disconnect callback on a streaming
// response — a failed send is the only sign the client hung up — so the first dead write cancels
// the upstream call.
class SseReply {
public:
  explicit SseReply(drogon::ResponseStreamPtr stream) : stream_(std::move(stream)) {}

  void attachCancel(std::function<void()> cancel) {
    std::unique_lock<std::mutex> lock(mutex_);
    cancel_ = std::move(cancel);
    if (!clientGone_) return;
    const std::function<void()> upstream = cancel_;
    lock.unlock();
    upstream();
  }

  void delta(const std::string& text) {
    Json::Value payload(Json::objectValue);
    payload["text"] = text;
    Json::StreamWriterBuilder builder;
    builder["indentation"] = "";
    std::unique_lock<std::mutex> lock(mutex_);
    if (finished_) return;
    sawDelta_ = true;
    if (stream_->send(sseEvent("delta", Json::writeString(builder, payload)))) return;
    finished_ = true;
    cancelUpstream(lock);
  }

  void finish(bool ok) {
    std::unique_lock<std::mutex> lock(mutex_);
    if (finished_) return;
    finished_ = true;
    if (ok) {
      stream_->send(sseEvent("done", "{}"));
    } else {
      // Mid-stream failure after deltas leaves the partial text with the client; the fail event
      // is its failure line.
      stream_->send(sseEvent("fail", R"({"code":"compose-failed"})"));
    }
    stream_->close();
  }

  bool heartbeat() {
    std::unique_lock<std::mutex> lock(mutex_);
    if (finished_ || sawDelta_) return false;
    if (stream_->send(": ping\n\n")) return true;  // keeps idle proxies from cutting the wait
    finished_ = true;
    cancelUpstream(lock);
    return false;
  }

private:
  void cancelUpstream(std::unique_lock<std::mutex>& lock) {
    clientGone_ = true;
    const std::function<void()> upstream = cancel_;
    lock.unlock();
    if (upstream) upstream();
  }

  std::mutex mutex_;
  drogon::ResponseStreamPtr stream_;
  std::function<void()> cancel_;
  bool clientGone_ = false;
  bool sawDelta_ = false;
  bool finished_ = false;
};

void heartbeatWhileWaiting(const std::shared_ptr<SseReply>& reply) {
  drogon::app().getLoop()->runAfter(kHeartbeatSeconds, [reply]() {
    if (reply->heartbeat()) heartbeatWhileWaiting(reply);
  });
}
}

ComposeApi::ComposeApi(std::shared_ptr<PlanComposer> composer) : composer_(std::move(composer)) {}

void ComposeApi::compose(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  // parse → empty 400 → too-long 400 → no-key 503 → then branch on the stream flag. Every guard
  // answers plain JSON: SSE begins only once the request is known good, so pre-stream failures
  // keep their codes.
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (!json || !json->isObject() || !(*json)["text"].isString() ||
      isBlank((*json)["text"].asString())) {
    callback(coded(drogon::k400BadRequest, "empty"));
    return;
  }
  const std::string text = (*json)["text"].asString();
  if (text.size() > kMaxTextBytes) {
    callback(coded(drogon::k400BadRequest, "too-long"));
    return;
  }
  if (!composer_->configured()) {
    callback(coded(drogon::k503ServiceUnavailable, "compose-unavailable"));
    return;
  }

  if (!(*json)["stream"].isBool() || !(*json)["stream"].asBool()) {
    composer_->compose(text, [callback = std::move(callback)](std::optional<std::string> plan) {
      if (!plan) {
        callback(coded(drogon::k502BadGateway, "compose-failed"));
        return;
      }
      Json::Value body(Json::objectValue);
      body["plan"] = *plan;
      callback(drogon::HttpResponse::newHttpJsonResponse(body));
    });
    return;
  }

  // 200 + SSE headers go on the wire immediately, so from here every outcome — even an upstream
  // error before the first byte — arrives as an SSE event. The stream callback fires once drogon
  // starts writing the response on the connection's own IO thread.
  auto composer = composer_;
  auto response = drogon::HttpResponse::newAsyncStreamResponse(
      [composer, text](drogon::ResponseStreamPtr stream) {
        auto reply = std::make_shared<SseReply>(std::move(stream));
        heartbeatWhileWaiting(reply);  // the model can think a while before its first delta
        reply->attachCancel(composer->composeStream(
            text,
            [reply](const std::string& delta) { reply->delta(delta); },
            [reply](bool ok) { reply->finish(ok); }));
      },
      true /* disable the kickoff timeout: the first delta can be minutes away */);
  response->setContentTypeString("text/event-stream");
  response->addHeader("cache-control", "no-cache");
  response->addHeader("x-accel-buffering", "no");  // event-stream is respected, but be explicit
  callback(response);
}

}

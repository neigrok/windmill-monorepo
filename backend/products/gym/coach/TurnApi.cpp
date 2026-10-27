#include "products/gym/coach/TurnApi.h"

#include "platform/adapters/http/JsonReply.h"
#include "platform/adapters/http/WriteRoutes.h"
#include "platform/adapters/json/JsonText.h"
#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/Jcs.h"

#include <drogon/HttpAppFramework.h>
#include <drogon/utils/Utilities.h>

#include <algorithm>
#include <cctype>
#include <mutex>
#include <utility>

namespace wm::gym::coach {

namespace {

drogon::HttpResponsePtr privateResponse(const drogon::HttpResponsePtr& response) {
  response->addHeader("Cache-Control", "private, no-store");
  return response;
}

drogon::HttpResponsePtr refusal(const std::string& code) {
  return privateResponse(error(statusOf(code), "Coach could not take this message.", code.c_str()));
}

std::string frame(const std::string& event, const Json::Value& data) {
  return "event: " + event + "\ndata: " + dump(data) + "\n\n";
}

void streamHeaders(const drogon::HttpResponsePtr& response) {
  response->setContentTypeString("text/event-stream");
  response->addHeader("cache-control", "no-cache");
  response->addHeader("x-accel-buffering", "no");
}

// The events over an open connection, a heartbeat comment every fifteen idle seconds.
class EventStream : public TurnSink, public std::enable_shared_from_this<EventStream> {
public:
  explicit EventStream(drogon::ResponseStreamPtr stream) : stream_(std::move(stream)) {}

  void send(const std::string& event, const Json::Value& data, bool terminal) override {
    std::lock_guard lock(mutex_);
    write(frame(event, data), terminal);
  }

  void heartbeat() {
    {
      std::lock_guard lock(mutex_);
      if (closed_) return;
      write(": heartbeat\n\n", false);
    }
    drogon::app().getLoop()->runAfter(15.0, [weak = weak_from_this()] {
      if (const auto self = weak.lock()) self->heartbeat();
    });
  }

private:
  void write(const std::string& bytes, bool terminal) {
    if (closed_) return;
    if (!stream_->send(bytes)) { closed_ = true; return; }
    if (terminal) { stream_->close(); closed_ = true; }
  }

  std::mutex mutex_;
  drogon::ResponseStreamPtr stream_;
  bool closed_ = false;
};

// One body holding every frame, sent when the turn ends: Drogon never calls an async stream back
// on a connection that is closing, so these get the whole exchange at once.
class BufferedStream : public TurnSink {
public:
  explicit BufferedStream(HttpCallback reply) : reply_(std::move(reply)) {}

  void send(const std::string& event, const Json::Value& data, bool terminal) override {
    std::lock_guard lock(mutex_);
    if (!reply_) return;
    body_ += frame(event, data);
    if (!terminal) return;
    auto response = drogon::HttpResponse::newHttpResponse();
    streamHeaders(response);
    response->setBody(std::move(body_));
    auto reply = std::move(reply_);
    reply_ = nullptr;
    reply(response);
  }

private:
  std::mutex mutex_;
  HttpCallback reply_;
  std::string body_;
};

bool closingConnection(const drogon::HttpRequestPtr& request) {
  std::string connection = request->getHeader("connection");
  std::transform(connection.begin(), connection.end(), connection.begin(),
                 [](unsigned char byte) { return static_cast<char>(std::tolower(byte)); });
  return request->version() == drogon::Version::kHttp10 || drogon::utils::splitStringViewToSet(connection, ",").count("close");
}

}  // namespace

drogon::HttpStatusCode statusOf(const std::string& code) {
  if (code == "coach-bad-request" || code == "invalid_network") return drogon::k400BadRequest;
  if (code == "unauthenticated" || code == "invalid_installation") return drogon::k401Unauthorized;
  if (code == "coach-turn-unknown") return drogon::k404NotFound;
  if (code == "coach-turn-conflict" || code == "coach-turn-order" || code == "device_bound") return drogon::k409Conflict;
  if (code == "coach-update-required") return drogon::k426UpgradeRequired;
  if (code == "coach-rate-limited" || code == "subject_exhausted") return drogon::k429TooManyRequests;
  return drogon::k503ServiceUnavailable;
}

TurnApi::TurnApi(std::shared_ptr<TurnService> turns, std::shared_ptr<AiInstallationApi> installations,
                 std::shared_ptr<FailureReporter> failures)
    : turns_(std::move(turns)), installations_(std::move(installations)), failures_(std::move(failures)) {}

void TurnApi::shutdown() { workers_.stopAndJoin(); }

TurnApi::Access TurnApi::principalOf(const drogon::HttpRequestPtr& request) const {
  const AiPrincipalAccess access = installations_->principal(request);
  if (!access.refusal.empty()) return {std::nullopt, access.refusal};
  TurnPrincipal principal;
  if (access.account) {
    principal.seat = Seat::bound;
    principal.account = access.account;
    return {principal, {}};
  }
  const std::optional<std::string> address = installations_->clientAddress(request);
  if (!address) return {std::nullopt, "invalid_network"};
  principal.seat = Seat::anon;
  principal.installation = access.installation;
  principal.address = *address;
  return {principal, {}};
}

void TurnApi::onWorker(const drogon::HttpRequestPtr& request, HttpCallback&& reply,
                       std::function<void(HttpCallback&&)> work) {
  auto callback = std::make_shared<HttpCallback>(std::move(reply));
  const bool posted = workers_.post([request, callback, work = std::move(work)] {
    observeHttpWork(request, [&] {
      try {
        work([callback](const drogon::HttpResponsePtr& response) { (*callback)(response); });
      } catch (const std::exception& error) {
        writeHttpFailure(request, error);
        (*callback)(refusal("coach-vendor-error"));
      } catch (...) {
        writeHttpFailureUnknown(request);
        (*callback)(refusal("coach-vendor-error"));
      }
    });
  });
  if (!posted) (*callback)(refusal("coach-busy"));
}

void TurnApi::stream(const drogon::HttpRequestPtr& request, HttpCallback&& reply, const std::shared_ptr<Turn>& turn,
                     bool resume) {
  if (closingConnection(request)) {
    turn->attach(std::make_shared<BufferedStream>(std::move(reply)), resume);
    return;
  }
  auto response = drogon::HttpResponse::newAsyncStreamResponse(
      [turn, resume](drogon::ResponseStreamPtr stream) {
        auto sink = std::make_shared<EventStream>(std::move(stream));
        turn->attach(sink, resume);
        sink->heartbeat();
      },
      true);
  streamHeaders(response);
  reply(response);
}

void TurnApi::open(const drogon::HttpRequestPtr& request, HttpCallback&& reply) {
  if (request->body().size() > kOpenBodyBytes) {
    reply(privateResponse(error(drogon::k413RequestEntityTooLarge, "Coach could not take this message.", "coach-bad-request")));
    return;
  }
  onWorker(request, std::move(reply), [this, request](HttpCallback&& reply) {
    const Access access = principalOf(request);
    if (!access.principal) { reply(refusal(access.refusal)); return; }
    const std::shared_ptr<Json::Value> body = request->getJsonObject();
    TurnOpenRead read = body ? readTurnOpen(*body) : TurnOpenRead{std::nullopt, "coach-bad-request"};
    if (!read.open) { reply(refusal(read.code)); return; }
    const TurnAdmission admission = turns_->open(*access.principal, std::move(*read.open));
    if (!admission.turn) { reply(refusal(admission.code)); return; }
    stream(request, std::move(reply), admission.turn, admission.resumed);
  });
}

void TurnApi::resume(const drogon::HttpRequestPtr& request, HttpCallback&& reply, const std::string& turnId) {
  onWorker(request, std::move(reply), [this, request, turnId](HttpCallback&& reply) {
    const Access access = principalOf(request);
    if (!access.principal) { reply(refusal(access.refusal)); return; }
    const std::shared_ptr<Turn> turn = turns_->find(*access.principal, turnId);
    if (!turn) { reply(refusal("coach-turn-unknown")); return; }
    stream(request, std::move(reply), turn, true);
  });
}

void TurnApi::results(const drogon::HttpRequestPtr& request, HttpCallback&& reply, const std::string& turnId) {
  onWorker(request, std::move(reply), [this, request, turnId](HttpCallback&& reply) {
    const Access access = principalOf(request);
    if (!access.principal) { reply(refusal(access.refusal)); return; }
    const std::shared_ptr<Turn> turn = turns_->find(*access.principal, turnId);
    if (!turn) { reply(refusal("coach-turn-unknown")); return; }
    const std::shared_ptr<Json::Value> body = request->getJsonObject();
    TurnResultsRead read = body ? readTurnResults(*body) : TurnResultsRead{0, {}, "coach-bad-request"};
    if (!read.code.empty()) { reply(refusal(read.code)); return; }
    const std::string digest = sync::sha256(sync::jcs(*body)).hex();
    switch (turn->answer(read.batch, std::move(read.results), digest)) {
      case ResultsAnswer::accepted: {
        Json::Value out(Json::objectValue);
        out["batch"] = read.batch;
        reply(privateResponse(jsonResponse(out)));
        return;
      }
      case ResultsAnswer::replay: {
        auto response = drogon::HttpResponse::newHttpResponse();
        response->setStatusCode(drogon::k204NoContent);
        reply(privateResponse(response));
        return;
      }
      case ResultsAnswer::order:
        reply(refusal("coach-turn-order"));
        return;
    }
  });
}

void TurnApi::stop(const drogon::HttpRequestPtr& request, HttpCallback&& reply, const std::string& turnId) {
  onWorker(request, std::move(reply), [this, request, turnId](HttpCallback&& reply) {
    const Access access = principalOf(request);
    if (!access.principal) { reply(refusal(access.refusal)); return; }
    const std::shared_ptr<Turn> turn = turns_->find(*access.principal, turnId);
    if (!turn) { reply(refusal("coach-turn-unknown")); return; }
    turn->requestStop();
    Json::Value out(Json::objectValue);
    out["state"] = std::string(nameOf(turn->state()));
    reply(privateResponse(jsonResponse(out, drogon::k202Accepted)));
  });
}

}

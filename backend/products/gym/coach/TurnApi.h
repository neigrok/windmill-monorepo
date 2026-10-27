#pragma once

#include "platform/ai_installations/AiInstallationApi.h"
#include "platform/application/WorkerPool.h"
#include "platform/ports/FailureReporter.h"
#include "products/gym/coach/TurnService.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <optional>
#include <string>

// The turn wire (gym_coach.md §6): the four turn routes over Drogon. A session opens a `bound`
// seat, `X-Windmill-Installation` an `anon` one, and every request of a turn is served under the
// seat that opened it. A refusal before the stream starts is an HTTP error `{error, code}`; after
// it, an `error` event and the stream closes.
//
//   POST /v1/gym/coach/turns                   open; text/event-stream
//   GET  /v1/gym/coach/turns/{turnId}          resume; `snapshot` first
//   POST /v1/gym/coach/turns/{turnId}/results  answer a batch; 200 accepted, 204 the same body again
//   POST /v1/gym/coach/turns/{turnId}/stop     request Stop; 202

namespace wm::gym::coach {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// The HTTP status a §6.5 code answers with before the stream starts.
drogon::HttpStatusCode statusOf(const std::string& code);

class TurnApi {
public:
  TurnApi(std::shared_ptr<TurnService> turns, std::shared_ptr<AiInstallationApi> installations,
          std::shared_ptr<FailureReporter> failures);

  void open(const drogon::HttpRequestPtr& request, HttpCallback&& reply);
  void resume(const drogon::HttpRequestPtr& request, HttpCallback&& reply, const std::string& turnId);
  void results(const drogon::HttpRequestPtr& request, HttpCallback&& reply, const std::string& turnId);
  void stop(const drogon::HttpRequestPtr& request, HttpCallback&& reply, const std::string& turnId);
  void shutdown();

private:
  struct Access {
    std::optional<TurnPrincipal> principal;
    std::string refusal;
  };
  Access principalOf(const drogon::HttpRequestPtr& request) const;
  // Hands the turn's events to the connection: an async stream on a keep-alive connection, one
  // buffered body where Drogon would never call the stream back (HTTP/1.0, `Connection: close`).
  void stream(const drogon::HttpRequestPtr& request, HttpCallback&& reply, const std::shared_ptr<Turn>& turn,
              bool resume);
  // Every handler's work runs on the API's workers, never on the IO thread: admission reads the
  // allowance. A full queue answers `coach-busy`; a throw answers 500 and reports it.
  void onWorker(const drogon::HttpRequestPtr& request, HttpCallback&& reply,
                std::function<void(HttpCallback&&)> work);

  std::shared_ptr<TurnService> turns_;
  std::shared_ptr<AiInstallationApi> installations_;
  std::shared_ptr<FailureReporter> failures_;
  WorkerPool workers_{"gym-coach-http", 2, 16};
};

}

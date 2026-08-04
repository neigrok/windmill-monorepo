#include "products/journal/adapters/llm/HttpEmbedder.h"

#include "platform/adapters/http/VendorCall.h"

#include <drogon/HttpClient.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>
#include <json/json.h>
#include <trantor/utils/Logger.h>

#include <utility>

namespace wm {

HttpEmbedder::HttpEmbedder(std::string baseUrl) {
  while (!baseUrl.empty() && baseUrl.back() == '/') baseUrl.pop_back();

  // drogon dials an origin and ignores everything after it, so a URL carrying a path would silently
  // post /embed at a door that isn't there. Split it here instead, and keep the prefix.
  const std::size_t scheme = baseUrl.find("://");
  const std::size_t path = scheme == std::string::npos ? baseUrl.find('/') : baseUrl.find('/', scheme + 3);
  origin_ = baseUrl.substr(0, path);
  if (path != std::string::npos) prefix_ = baseUrl.substr(path);

  loop_.run();
}

bool HttpEmbedder::configured() const {
  return !origin_.empty();
}

bool HttpEmbedder::rememberVersion(const std::string& reported) const {
  const std::lock_guard<std::mutex> lock(mutex_);
  if (version_.empty() || version_ == reported) {
    version_ = reported;
    return true;
  }

  LOG_ERROR << "journal embedder changed model mid-sweep: " << version_ << " -> " << reported;
  version_ = reported;
  return false;
}

std::string HttpEmbedder::version() const {
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    if (!version_.empty()) return version_;
  }
  if (!configured()) return {};

  auto client = drogon::HttpClient::newHttpClient(origin_, loop_.getLoop());
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Get);
  req->setPath(prefix_ + "/health");

  VendorCall call("embedder", "version");
  const std::pair<drogon::ReqResult, drogon::HttpResponsePtr> outcome = client->sendRequest(req, 30.0);
  // The verdict is reported for the operator but is not the answer here: a sidecar still loading its
  // weights answers 503, and its body already names the version. The stamp is a property of the
  // configuration, not of readiness.
  call.succeeded(outcome.first, outcome.second);
  if (!outcome.second) return {};

  const std::shared_ptr<Json::Value> reply = outcome.second->getJsonObject();
  if (!reply || !(*reply)["version"].isString()) {
    LOG_ERROR << "journal embedder health: unreadable response";
    return {};
  }

  const std::string reported = (*reply)["version"].asString();
  rememberVersion(reported);
  return reported;
}

std::vector<std::vector<float>> HttpEmbedder::embed(const std::vector<std::string>& passages) {
  // Nothing to embed is the caller's business, not a round trip. It returns empty — which this port
  // reads as failure — so the sweep must never ask; the sidecar refuses an empty batch for the same
  // reason, rather than answering it in a way indistinguishable from a broken call.
  if (!configured() || passages.empty()) return {};

  Json::Value body(Json::objectValue);
  Json::Value list(Json::arrayValue);
  for (const std::string& passage : passages) list.append(passage);
  body["passages"] = std::move(list);

  auto client = drogon::HttpClient::newHttpClient(origin_, loop_.getLoop());
  auto req = drogon::HttpRequest::newHttpJsonRequest(body);
  req->setMethod(drogon::Post);
  req->setPath(prefix_ + "/embed");

  // The line carries the status and the cost and nothing else — the body on this seam is somebody's
  // journal. Two minutes because a cold sidecar loads its weights before it answers the first page
  // of the night, and the sweep would rather wait than write the page down as "nothing found".
  VendorCall call("embedder", "embed");
  const std::pair<drogon::ReqResult, drogon::HttpResponsePtr> outcome = client->sendRequest(req, 120.0);
  if (!call.succeeded(outcome.first, outcome.second)) return {};

  const std::shared_ptr<Json::Value> reply = outcome.second->getJsonObject();
  if (!reply || !(*reply)["version"].isString() || !(*reply)["vectors"].isArray()) {
    LOG_ERROR << "journal embedder: unreadable response";
    return {};
  }
  if (!rememberVersion((*reply)["version"].asString())) return {};

  const Json::Value& vectors = (*reply)["vectors"];
  if (vectors.size() != passages.size()) {
    LOG_ERROR << "journal embedder returned " << vectors.size() << " vectors for " << passages.size()
              << " passages";
    return {};
  }

  std::vector<std::vector<float>> embedded;
  embedded.reserve(vectors.size());
  for (const Json::Value& vector : vectors) {
    if (!vector.isArray() || vector.empty()) {
      LOG_ERROR << "journal embedder returned an empty vector";
      return {};
    }
    std::vector<float> values;
    values.reserve(vector.size());
    for (const Json::Value& component : vector) values.push_back(component.asFloat());
    embedded.push_back(std::move(values));
  }

  // One short vector would be a truncated reply read as a valid one, and cosine against it is a
  // number with no meaning. All or nothing, so the page is retried whole.
  for (const std::vector<float>& vector : embedded) {
    if (vector.size() == embedded.front().size()) continue;
    LOG_ERROR << "journal embedder returned vectors of unequal length";
    return {};
  }
  return embedded;
}

}

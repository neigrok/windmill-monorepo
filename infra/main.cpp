#include "adapters/http/HttpApi.h"
#include "adapters/postgres/PgProgressRepository.h"
#include "adapters/postgres/PgTreeRepository.h"

#include <drogon/drogon.h>

#include <cstdlib>
#include <memory>
#include <string>

int main() {
  using namespace wm;

  const char* url = std::getenv("DATABASE_URL");
  std::string connString = url ? url : "postgresql://localhost/windmill";

  auto trees = std::make_shared<PgTreeRepository>(connString);
  auto progress = std::make_shared<PgProgressRepository>(connString);
  auto api = std::make_shared<HttpApi>(trees, progress, Hlc{1, 0, "genesis"}, UserId{std::string("dev")});

  auto& app = drogon::app();

  // Dev CORS: the frontend dev server is a different origin. Permissive for now.
  app.registerPostHandlingAdvice(
      [](const drogon::HttpRequestPtr&, const drogon::HttpResponsePtr& resp) {
        resp->addHeader("Access-Control-Allow-Origin", "*");
        resp->addHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
        resp->addHeader("Access-Control-Allow-Headers", "content-type");
      });
  auto preflight = [](const drogon::HttpRequestPtr&, HttpCallback&& cb, const std::string&) {
    auto resp = drogon::HttpResponse::newHttpResponse();
    resp->setStatusCode(drogon::k204NoContent);
    cb(resp);
  };
  app.registerHandler("/v1/trees/{id}", preflight, {drogon::Options});
  app.registerHandler("/v1/trees/{id}/progress", preflight, {drogon::Options});
  app.registerHandler("/v1/trees/{id}/diagnostics", preflight, {drogon::Options});

  app.registerHandler(
      "/v1/trees/{id}",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->getTree(req, std::move(cb), id);
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/trees/{id}",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->putTree(req, std::move(cb), id);
      },
      {drogon::Put});
  app.registerHandler(
      "/v1/trees/{id}/progress",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->getProgress(req, std::move(cb), id);
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/trees/{id}/diagnostics",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->getDiagnostics(req, std::move(cb), id);
      },
      {drogon::Get});

  const char* portEnv = std::getenv("PORT");
  int port = portEnv ? std::atoi(portEnv) : 8080;
  LOG_INFO << "windmill-backend listening on :" << port;
  app.addListener("0.0.0.0", port).setThreadNum(4).run();
  return 0;
}

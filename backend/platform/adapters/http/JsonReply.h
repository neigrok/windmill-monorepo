#pragma once

#include "platform/adapters/json/JsonText.h"

#include <drogon/HttpAppFramework.h>
#include <drogon/HttpResponse.h>

#include <json/value.h>

#include <string>

namespace wm {

// The two replies every JSON endpoint makes, and the one rule for how Drogon writes them. An
// endpoint that wants a different shape (OAuth's RFC 6749 error object, the SSE stream's code-only
// frames) writes its own on purpose.

// Every double in a reply Drogon serialises — this file's two, and every `newHttpJsonResponse`
// elsewhere — carries kJsonDoubleDigits significant digits, the same rule as `dump`, so `82.4`
// crosses as `82.4` and never as `82.400000000000006`. Drogon fixes its writer on the first body it
// serialises, so this is called once, before the app takes traffic.
inline void configureJsonReplies(drogon::HttpAppFramework& app) {
  app.setFloatPrecisionInJson(kJsonDoubleDigits, "significant");
}

inline drogon::HttpResponsePtr jsonResponse(const Json::Value& body,
                                            drogon::HttpStatusCode status = drogon::k200OK) {
  auto response = drogon::HttpResponse::newHttpJsonResponse(body);
  response->setStatusCode(status);
  return response;
}

// A refusal: the human sentence under "error", and — where the caller is meant to branch on the
// reason rather than read it — a machine-readable word under "code". The code is optional.
inline drogon::HttpResponsePtr error(drogon::HttpStatusCode status, const std::string& message,
                                     const char* code = nullptr) {
  Json::Value body(Json::objectValue);
  body["error"] = message;
  if (code) body["code"] = code;
  return jsonResponse(body, status);
}

}

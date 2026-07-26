#pragma once

#include <drogon/HttpResponse.h>

#include <json/value.h>

#include <string>

namespace wm {

// The two replies every JSON endpoint makes. They were copied into a dozen adapters before this
// file existed, which is how a product ends up answering "no" in two different shapes depending
// on which handler said it — so they live here once, and an endpoint that wants a different shape
// (OAuth's RFC 6749 error object, the SSE stream's code-only frames) writes its own on purpose.

inline drogon::HttpResponsePtr jsonResponse(const Json::Value& body,
                                            drogon::HttpStatusCode status = drogon::k200OK) {
  auto response = drogon::HttpResponse::newHttpJsonResponse(body);
  response->setStatusCode(status);
  return response;
}

// A refusal: the human sentence under "error", and — where the caller is meant to branch on the
// reason rather than read it — a machine-readable word under "code" ("bad-id", "unknown-cursor").
// The code is optional because most refusals have exactly one cause and the sentence is the whole
// of it; a key that is sometimes an empty string would make a client test it twice.
inline drogon::HttpResponsePtr error(drogon::HttpStatusCode status, const std::string& message,
                                     const char* code = nullptr) {
  Json::Value body(Json::objectValue);
  body["error"] = message;
  if (code) body["code"] = code;
  return jsonResponse(body, status);
}

}

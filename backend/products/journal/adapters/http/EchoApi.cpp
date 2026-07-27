#include "products/journal/adapters/http/EchoApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"

#include <chrono>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>

namespace wm {

namespace {
constexpr std::uint64_t kDayMs = 24ULL * 60 * 60 * 1000;

drogon::HttpResponsePtr noContent() {
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  return response;
}

// One echo as the reader sees it. The score never leaves the server: canon says an echo is a
// presence, not a number — the row's ranking stays a storage concern, and the reply carries only
// the two days and the two spans the surface underlines.
Json::Value toJson(const StoredEcho& echo) {
  Json::Value span(Json::arrayValue);
  span.append(echo.triggerSpan.first);
  span.append(echo.triggerSpan.second);
  Json::Value matchSpan(Json::arrayValue);
  matchSpan.append(echo.matchSpan.first);
  matchSpan.append(echo.matchSpan.second);

  Json::Value body(Json::objectValue);
  body["triggerDay"] = echo.triggerDay.iso();
  body["matchDay"] = echo.matchDay.iso();
  body["triggerSpan"] = span;
  body["matchSpan"] = matchSpan;
  return body;
}

Json::Value toJson(const EchoSweepReport& report) {
  Json::Value body(Json::objectValue);
  body["usersScanned"] = report.usersScanned;
  body["vectorsComputed"] = report.vectorsComputed;
  body["echoesFound"] = report.echoesFound;
  body["skippedNotSubscribed"] = report.skippedNotSubscribed;
  return body;
}

// A millisecond knob of the admin door, read from the body or the query: nullopt is a malformed
// value the caller answers 400 to, zero is simply absent. Digits-only before stoull so a "-5"
// cannot wrap and a 20-digit overflow stays a 400 rather than a 500.
std::optional<std::uint64_t> msOf(const drogon::HttpRequestPtr& req,
                                  const std::shared_ptr<Json::Value>& json, const char* name) {
  if (json && json->isMember(name)) {
    if (!(*json)[name].isUInt64()) return std::nullopt;
    return (*json)[name].asUInt64();
  }
  const std::string param = req->getParameter(name);
  if (param.empty()) return 0;
  if (param.find_first_not_of("0123456789") != std::string::npos) return std::nullopt;
  try {
    return std::stoull(param);
  } catch (const std::out_of_range&) {
    return std::nullopt;
  }
}
}

EchoApi::EchoApi(std::shared_ptr<EchoRepository> echoes, std::shared_ptr<EchoSweep> sweep,
                 std::shared_ptr<AuthService> auth, std::string adminToken)
    : echoes_(std::move(echoes)), sweep_(std::move(sweep)), auth_(std::move(auth)),
      adminToken_(std::move(adminToken)) {}

void EchoApi::listEchoes(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to read your echoes"));
    return;
  }
  // No window asked for means the whole shelf. A non-subscriber's list is empty because nothing
  // was ever computed for them — "absent, not locked" needs no entitlement check here.
  const std::string from = req->getParameter("from");
  const std::string to = req->getParameter("to");
  std::optional<LocalDate> first;
  std::optional<LocalDate> last;
  try {
    first = LocalDate{from.empty() ? "0001-01-01" : from};
    last = LocalDate{to.empty() ? "9999-12-31" : to};
  } catch (const InvalidPage&) {
    cb(error(drogon::k400BadRequest, "bad date"));
    return;
  }

  Json::Value echoes(Json::arrayValue);
  for (const StoredEcho& echo : echoes_->echoesFor(*caller, *first, *last))
    echoes.append(toJson(echo));
  Json::Value body(Json::objectValue);
  body["echoes"] = echoes;
  cb(jsonResponse(body));
}

void EchoApi::dismiss(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                      const std::string& date) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to dismiss an echo"));
    return;
  }
  std::optional<LocalDate> day;
  try {
    day = LocalDate{date};
  } catch (const InvalidPage&) {
    cb(error(drogon::k400BadRequest, "bad date"));
    return;
  }
  // Owner-scoped and idempotent: a day with no echo dismisses nothing, and answers the same 204.
  echoes_->dismiss(*caller, *day);
  cb(noContent());
}

void EchoApi::adminSweep(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  // The operator's rehearsal door, closed unless the deploy set an admin token. The compare is
  // constant-time so a wrong token cannot be guessed a byte at a time.
  const std::string header = req->getHeader("x-admin-token");
  const std::string presented = header.empty() ? req->getParameter("token") : header;
  if (adminToken_.empty() || !secretEqual(presented, adminToken_)) {
    cb(error(drogon::k403Forbidden, "admin token required"));
    return;
  }

  std::shared_ptr<Json::Value> json = req->getJsonObject();
  std::optional<std::uint64_t> asOf = msOf(req, json, "asOfMs");
  if (!asOf) {
    cb(error(drogon::k400BadRequest, "asOfMs must be a millisecond timestamp"));
    return;
  }
  std::optional<std::uint64_t> since = msOf(req, json, "sinceMs");
  if (!since) {
    cb(error(drogon::k400BadRequest, "sinceMs must be a millisecond timestamp"));
    return;
  }

  // An unstated instant is the real one — this edge owns no Clock, and the operator door reading
  // the wall on the way in is exactly the boundary's job. The look-back defaults to one nightly
  // window: everything touched in the last 24 hours.
  std::uint64_t asOfMs = *asOf;
  if (asOfMs == 0)
    asOfMs = static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
                                            std::chrono::system_clock::now().time_since_epoch())
                                            .count());
  std::uint64_t sinceMs = *since;
  if (sinceMs == 0) sinceMs = asOfMs > kDayMs ? asOfMs - kDayMs : 0;

  cb(jsonResponse(toJson(sweep_->run(asOfMs, sinceMs))));
}

}

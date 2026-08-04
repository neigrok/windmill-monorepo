#include "products/journal/adapters/http/EchoApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"

#include <trantor/utils/Logger.h>

#include <chrono>
#include <cstdint>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace wm {

namespace {
constexpr std::uint64_t kDayMs = 24ULL * 60 * 60 * 1000;

// How much of a passage an unentitled reader is shown. Enough to recognise their own sentence and
// know it is genuinely theirs; not enough to be the feature. The withheld count travels with it so
// the cut is stated rather than disguised.
constexpr std::size_t kFreeWords = 8;

drogon::HttpResponsePtr noContent() {
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  return response;
}

std::vector<std::string> wordsOf(const std::string& text) {
  std::istringstream stream(text);
  std::vector<std::string> words;
  for (std::string word; stream >> word;) words.push_back(word);
  return words;
}

// The honest cut. An entitled reader gets the passage; everyone else gets its real opening words
// and the number withheld — which is the truth about what exists, rather than the older behaviour
// of hiding that anything was found at all.
void appendMatch(Json::Value& into, const EchoView& echo, bool entitled) {
  Json::Value match(Json::objectValue);
  match["day"] = echo.matchDay.iso();
  match["isSelf"] = echo.matchIsSelf;
  match["source"] = echo.matchSource == Source::spoken ? "spoken" : "typed";

  if (entitled) {
    match["text"] = echo.matchText;
    match["withheldWords"] = 0;
    into.append(match);
    return;
  }

  const std::vector<std::string> words = wordsOf(echo.matchText);
  const std::size_t shown = words.size() < kFreeWords ? words.size() : kFreeWords;
  std::string prefix;
  for (std::size_t i = 0; i < shown; ++i) {
    if (i > 0) prefix += ' ';
    prefix += words[i];
  }
  match["text"] = prefix;
  match["withheldWords"] = static_cast<int>(words.size() - shown);
  into.append(match);
}

Json::Value toJson(const EchoSweepReport& report) {
  Json::Value body(Json::objectValue);
  body["usersScanned"] = report.usersScanned;
  body["pagesDerived"] = report.pagesDerived;
  body["pagesSkippedRefrain"] = report.pagesSkippedRefrain;
  body["passagesEmbedded"] = report.passagesEmbedded;
  body["echoesWritten"] = report.echoesWritten;
  body["pagesFailed"] = report.pagesFailed;
  body["inboundEnqueued"] = report.inboundEnqueued;
  body["pagesOverBudget"] = report.pagesOverBudget;
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
                 std::shared_ptr<AuthService> auth, std::shared_ptr<Entitlements> entitlements,
                 std::string adminToken)
    : echoes_(std::move(echoes)), sweep_(std::move(sweep)), auth_(std::move(auth)),
      entitlements_(std::move(entitlements)), adminToken_(std::move(adminToken)) {}

void EchoApi::listEchoes(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<User> caller = callerUserOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to read your echoes"));
    return;
  }

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

  const bool entitled = entitlements_->hasWindmillOne(caller->id, caller->email.value);

  // Grouped by the page that carries them: the canon renders one card per page, and the ordering
  // the repository returns (newest trigger first, then each page's matches newest first) is the
  // order the surface draws.
  Json::Value pages(Json::arrayValue);
  std::string openDay;
  Json::Value page(Json::objectValue);
  Json::Value matches(Json::arrayValue);
  for (const EchoView& echo : echoes_->echoesFor(caller->id, *first, *last)) {
    if (echo.triggerDay.iso() != openDay) {
      if (!openDay.empty()) {
        page["matches"] = matches;
        pages.append(page);
      }
      openDay = echo.triggerDay.iso();
      page = Json::Value(Json::objectValue);
      page["day"] = openDay;
      page["entitled"] = entitled;
      matches = Json::Value(Json::arrayValue);
    }
    appendMatch(matches, echo, entitled);
  }
  if (!openDay.empty()) {
    page["matches"] = matches;
    pages.append(page);
  }

  Json::Value body(Json::objectValue);
  body["pages"] = pages;
  cb(jsonResponse(body));
}

void EchoApi::dismiss(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                      const std::string& triggerDay, const std::string& matchDay) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to dismiss an echo"));
    return;
  }
  std::optional<LocalDate> trigger;
  std::optional<LocalDate> match;
  try {
    trigger = LocalDate{triggerDay};
    match = LocalDate{matchDay};
  } catch (const InvalidPage&) {
    cb(error(drogon::k400BadRequest, "bad date"));
    return;
  }

  // The reader waves away a pairing between two DAYS; storage keys dismissal on the passage pair,
  // because an ordinal shifts the moment a sentence is inserted and a position-keyed dismissal
  // would quietly resurrect the very echo they retired. Resolving here keeps that detail out of
  // the surface without letting it leak into the URL.
  for (const EchoView& echo : echoes_->echoesFor(*caller, *trigger, *trigger)) {
    if (echo.matchDay.iso() != match->iso()) continue;
    echoes_->dismiss(*caller, echo.triggerSpanId, echo.matchSpanId);
  }
  cb(noContent());   // idempotent: a pairing that is already gone dismisses nothing, and says 204
}

void EchoApi::opened(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                     const std::string& triggerDay, const std::string& matchDay) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in"));
    return;
  }
  // The one positive relevance signal this feature has. Dismissal alone cannot tell "wrong match"
  // from "right match, bad night", so a tap that opened the older page is the only clean label
  // available — and it is on screen already. Logged rather than tabled for now; it wants its own
  // table before anyone tries to learn from it.
  LOG_INFO << "journal echo opened: user=" << caller->str() << " trigger=" << triggerDay
           << " match=" << matchDay;
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
  // the wall on the way in is exactly the boundary's job.
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

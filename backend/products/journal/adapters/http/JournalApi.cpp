#include "products/journal/adapters/http/JournalApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "products/journal/adapters/json/PageJson.h"

#include <algorithm>
#include <charconv>
#include <optional>
#include <utility>

namespace wm {

namespace {
// The date is the resource's address, so a shape other than YYYY-MM-DD refuses here, before storage
// is ever asked about it.
std::optional<LocalDate> dayOf(const std::string& date) {
  try {
    return LocalDate{date};
  } catch (const InvalidPage&) {
    return std::nullopt;
  }
}
}

JournalApi::JournalApi(std::shared_ptr<PageService> pages, std::shared_ptr<AuthService> auth)
    : pages_(std::move(pages)), auth_(std::move(auth)) {}

void JournalApi::getPage(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                         const std::string& date) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your journal"));
    return;
  }
  std::optional<LocalDate> day = dayOf(date);
  if (!day) {
    cb(error(drogon::k400BadRequest, "bad date"));
    return;
  }
  std::optional<Page> page = pages_->page(*caller, *day);
  if (!page) {
    // An empty day is a fact, not a fault — the canvas draws the blank page from this 404.
    cb(error(drogon::k404NotFound, "nothing written"));
    return;
  }
  cb(jsonResponse(toJson(*page)));
}

void JournalApi::putPage(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                         const std::string& date) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your journal"));
    return;
  }
  std::optional<LocalDate> day = dayOf(date);
  if (!day) {
    cb(error(drogon::k400BadRequest, "bad date"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (!json) {
    cb(error(drogon::k400BadRequest, "expected json"));
    return;
  }
  std::optional<Page> incoming;
  try {
    incoming = parsePageWrite(*json, *caller, *day);
  } catch (const PageTooLarge&) {
    // Its own status and its own sentence: it is the one parse failure the writer can do something
    // about, and a page this long is a storage rule (kMaxPageBytes, domain/Page.h).
    cb(error(drogon::k413RequestEntityTooLarge, "that page is too long to store"));
    return;
  } catch (const std::exception&) {
    // A malformed field — a non-numeric mood, a garbled stamp — is the client's mistake, so it is a
    // 400, never a 500 that would also land a row in the server-error ledger.
    cb(error(drogon::k400BadRequest, "could not read that page"));
    return;
  }
  // The reply is always the WINNING row, so a device that raced and lost is handed the body that won.
  WriteOutcome out = pages_->write(*incoming);
  cb(jsonResponse(toJson(out.page)));
}

void JournalApi::listPages(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your journal"));
    return;
  }

  // Three reads behind one path, most specific first: the sync feed (since), the canvas window
  // (from/to), and the whole shelf when neither is asked for.
  const std::string since = req->getParameter("since");
  if (!since.empty()) {
    Hlc cursor;
    try {
      cursor = parseHlc(since);
    } catch (const std::exception&) {
      cb(error(drogon::k400BadRequest, "bad cursor"));
      return;
    }
    int limit = 500;
    const std::string requestedLimit = req->getParameter("limit");
    if (!requestedLimit.empty()) {
      int value = 0;
      const char* last = requestedLimit.data() + requestedLimit.size();
      const std::from_chars_result parsed = std::from_chars(requestedLimit.data(), last, value);
      if (parsed.ec == std::errc{} && parsed.ptr == last && value > 0) limit = std::min(value, 1000);
    }
    Json::Value body(Json::objectValue);
    body["pages"] = toJson(pages_->since(*caller, cursor, limit));
    cb(jsonResponse(body));
    return;
  }

  const std::string from = req->getParameter("from");
  const std::string to = req->getParameter("to");
  if (!from.empty() && !to.empty()) {
    std::optional<LocalDate> first = dayOf(from);
    std::optional<LocalDate> last = dayOf(to);
    if (!first || !last) {
      cb(error(drogon::k400BadRequest, "bad date"));
      return;
    }
    Json::Value body(Json::objectValue);
    body["pages"] = toJson(pages_->range(*caller, *first, *last));
    cb(jsonResponse(body));
    return;
  }

  Json::Value body(Json::objectValue);
  body["pages"] = toJson(pages_->all(*caller));
  cb(jsonResponse(body));
}

void JournalApi::exportAll(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your journal"));
    return;
  }
  // Export is the shelf in the same envelope the list wears: every page, oldest first.
  Json::Value body(Json::objectValue);
  body["pages"] = toJson(pages_->all(*caller));
  cb(jsonResponse(body));
}

}

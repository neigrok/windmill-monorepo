#include "platform/adapters/http/UsageAdminApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cerrno>
#include <cstdlib>
#include <optional>
#include <string>
#include <utility>

namespace wm {

namespace {

// The window this page is about when nobody says otherwise, and the depth of the ranked table.
// Ten names is the list somebody actually reads; a longer one is a database export wearing a page.
constexpr long long kDefaultWindowMs = 30LL * 24 * 60 * 60 * 1000;
constexpr int kTopSpenders = 10;

std::string folded(const std::string& text) {
  const std::size_t first = text.find_first_not_of(" \t\r\n");
  if (first == std::string::npos) return "";
  const std::size_t last = text.find_last_not_of(" \t\r\n");
  std::string trimmed = text.substr(first, last - first + 1);
  std::transform(trimmed.begin(), trimmed.end(), trimmed.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return trimmed;
}

std::vector<std::string> ownersOf(const std::string& list) {
  std::vector<std::string> owners;
  std::size_t start = 0;
  while (start <= list.size()) {
    const std::size_t comma = list.find(',', start);
    const std::size_t end = comma == std::string::npos ? list.size() : comma;
    const std::string one = folded(list.substr(start, end - start));
    if (!one.empty()) owners.push_back(one);
    if (comma == std::string::npos) break;
    start = comma + 1;
  }
  return owners;
}

long long nowMs() {
  const auto since = std::chrono::system_clock::now().time_since_epoch();
  return std::chrono::duration_cast<std::chrono::milliseconds>(since).count();
}

// A window from the query string, with the trailing thirty days as the answer to every absence or
// nonsense. A bad number is not worth a 400 on a page with two readers: the default is what they
// wanted anyway, and a refusal here only makes the URL harder to type by hand.
struct Window {
  long long fromMs = 0;
  long long toMs = 0;
};

long long msParam(const drogon::HttpRequestPtr& req, const std::string& name, long long fallback) {
  const std::string raw = req->getParameter(name);
  if (raw.empty()) return fallback;
  errno = 0;
  char* end = nullptr;
  const long long value = std::strtoll(raw.c_str(), &end, 10);
  // Three ways a number can be nonsense, and only the first is a parse failure. errno catches the
  // digits that overflow; the RANGE check catches the ones that do not — LLONG_MAX parses perfectly
  // and then throws inside to_timestamp() on the way into Postgres, which turned a typo in a URL
  // into a 500. The stated contract here is that nonsense falls back to the default window, so it
  // has to, whichever kind of nonsense it was.
  constexpr long long kMaxMs = 253'402'300'799'000;  // 9999-12-31, past any window worth asking for
  if (errno == ERANGE || end == raw.c_str() || *end != '\0' || value < 0 || value > kMaxMs)
    return fallback;
  return value;
}

Window windowOf(const drogon::HttpRequestPtr& req) {
  const long long to = msParam(req, "to", nowMs());
  return Window{msParam(req, "from", to - kDefaultWindowMs), to};
}

Json::Value number(long long value) { return Json::Value(static_cast<Json::Int64>(value)); }

Json::Value summaryJson(const UsageSummary& summary) {
  Json::Value byProduct(Json::arrayValue);
  for (const ProductSpend& product : summary.byProduct) {
    Json::Value entry(Json::objectValue);
    entry["product"] = product.product;
    entry["costNanos"] = number(product.costNanos);
    entry["calls"] = number(product.calls);
    // Rides on EVERY aggregate row, not only the total: a row holding unpriced calls is a row whose
    // cost is a FLOOR, and the page cannot draw its "≥" from a number it was never handed.
    entry["unpricedCalls"] = number(product.unpricedCalls);
    byProduct.append(entry);
  }

  Json::Value daily(Json::arrayValue);
  for (const DaySpend& day : summary.daily) {
    Json::Value entry(Json::objectValue);
    entry["day"] = day.day;
    entry["costNanos"] = number(day.costNanos);
    entry["calls"] = number(day.calls);
    entry["unpricedCalls"] = number(day.unpricedCalls);
    daily.append(entry);
  }

  Json::Value unpricedModels(Json::arrayValue);
  for (const std::string& model : summary.unpricedModels) unpricedModels.append(model);

  Json::Value body(Json::objectValue);
  // Integer nanos on the wire, never a formatted string and never a float. The client decides how
  // money reads — including that a real cost under a cent renders "<$0.01" rather than "$0.00",
  // which is a rendering decision and would be a lie if it were baked in here.
  body["costNanos"] = number(summary.costNanos);
  body["calls"] = number(summary.calls);
  body["unpricedCalls"] = number(summary.unpricedCalls);
  body["inputTokens"] = number(summary.inputTokens);
  body["outputTokens"] = number(summary.outputTokens);
  body["cacheReadTokens"] = number(summary.cacheReadTokens);
  body["cacheWriteTokens"] = number(summary.cacheWriteTokens);
  body["anonymousCostNanos"] = number(summary.anonymousCostNanos);
  body["unpricedModels"] = unpricedModels;
  body["byProduct"] = byProduct;
  body["daily"] = daily;
  return body;
}

}  // namespace

UsageAdminApi::UsageAdminApi(std::shared_ptr<AiUsageRepository> usage,
                             std::shared_ptr<AuthService> auth, const std::string& ownerEmails)
    : usage_(std::move(usage)), auth_(std::move(auth)), owners_(ownersOf(ownerEmails)) {}

bool UsageAdminApi::isOwner(const drogon::HttpRequestPtr& req) const {
  if (owners_.empty()) return false;  // an unset allowlist opens nothing, ever
  const std::optional<User> caller = callerUserOf(req, *auth_);
  if (!caller) return false;
  const std::string email = folded(caller->email.value);
  if (email.empty()) return false;
  return std::find(owners_.begin(), owners_.end(), email) != owners_.end();
}

void UsageAdminApi::summary(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  // One sentence for signed-out, not-an-owner and no-such-thing alike — same status, same body.
  if (!isOwner(req)) {
    callback(error(drogon::k404NotFound, "not found"));
    return;
  }
  const Window window = windowOf(req);
  callback(jsonResponse(summaryJson(usage_->summary(window.fromMs, window.toMs))));
}

void UsageAdminApi::users(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  if (!isOwner(req)) {
    callback(error(drogon::k404NotFound, "not found"));
    return;
  }
  const Window window = windowOf(req);
  Json::Value body(Json::arrayValue);
  for (const UserSpend& spend : usage_->topSpenders(window.fromMs, window.toMs, kTopSpenders)) {
    Json::Value entry(Json::objectValue);
    entry["userId"] = spend.user.str();
    entry["email"] = spend.email;
    entry["costNanos"] = number(spend.costNanos);
    entry["calls"] = number(spend.calls);
    entry["unpricedCalls"] = number(spend.unpricedCalls);
    entry["topProduct"] = spend.topProduct;
    body.append(entry);
  }
  callback(jsonResponse(body));
}

}

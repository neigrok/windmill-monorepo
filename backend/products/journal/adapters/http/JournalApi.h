#pragma once

#include "platform/application/AuthService.h"
#include "products/journal/application/PageService.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// The journal canvas over REST. Every handler resolves the caller first and 401s before touching
// storage, and every read/write is scoped to that caller — there is no path that takes a non-owner,
// which is how "no route is public" is enforced structurally (canon §0.1). A page is addressed by
// its local date in the URL; the body carries the words, the fields, and the device's HLC stamp.
class JournalApi {
public:
  JournalApi(std::shared_ptr<PageService> pages, std::shared_ptr<AuthService> auth);

  void getPage(const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& date);   // GET  /v1/journal/page/:date
  void putPage(const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& date);   // PUT  /v1/journal/page/:date
  void listPages(const drogon::HttpRequestPtr& req, HttpCallback&& cb);                          // GET  /v1/journal/pages?since=|from=&to=
  void exportAll(const drogon::HttpRequestPtr& req, HttpCallback&& cb);                          // GET  /v1/journal/export

private:
  std::shared_ptr<PageService> pages_;
  std::shared_ptr<AuthService> auth_;
};

}

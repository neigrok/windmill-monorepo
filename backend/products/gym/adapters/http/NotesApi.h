#pragma once

#include "platform/application/AuthService.h"
#include "products/gym/ports/NotesRepository.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm::gym {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

//   list   out : { "notes": [ { "id", "position", "title", "body", "updatedAt" } ] }
class NotesApi {
public:
  NotesApi(std::shared_ptr<NotesRepository> notes, std::shared_ptr<AuthService> auth);

  void listNotes(const drogon::HttpRequestPtr& req, HttpCallback&& cb);     // GET    /v1/gym/notes

private:
  std::shared_ptr<NotesRepository> notes_;
  std::shared_ptr<AuthService> auth_;
};

}
